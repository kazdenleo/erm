/**
 * Шифрование секретов интеграций / кабинетов МП (at rest).
 * Формат значения: enc:v1:<iv_b64url>:<tag_b64url>:<ct_b64url>
 *
 * Ключ: SECRETS_ENCRYPTION_KEY (64 hex = 32 байта) или base64 на 32 байта.
 * Если не задан — производный от JWT_SECRET (только чтобы локалка работала;
 * на проде задайте отдельный SECRETS_ENCRYPTION_KEY).
 */

import crypto from 'crypto';
import config from '../config/index.js';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const MASK_PREFIX = '••••••••';

/** Поля config, которые шифруем / маскируем. */
export const SECRET_CONFIG_KEYS = Object.freeze([
  'api_key',
  'apiKey',
  'advert_api_key',
  'advertApiKey',
  'performance_client_secret',
  'performanceClientSecret',
  'client_secret',
  'clientSecret',
  'password',
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'v1ApiKey',
  'apiKeyV1',
  'portalApiKey',
  'portal_api_key',
]);

let cachedKey = null;
let warnedMissingExplicitKey = false;

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromB64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function resolveKeyMaterial() {
  const raw = String(process.env.SECRETS_ENCRYPTION_KEY || '').trim();
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    try {
      const b = Buffer.from(raw, 'base64');
      if (b.length === 32) return b;
    } catch {
      /* fallthrough */
    }
    // Любая строка → scrypt
    return crypto.scryptSync(raw, 'erm-secrets-v1', 32);
  }
  const jwt = String(config?.jwt?.secret || process.env.JWT_SECRET || 'change-this-secret-in-production');
  if (!warnedMissingExplicitKey && config?.isProduction) {
    warnedMissingExplicitKey = true;
    console.warn(
      '[secretsCrypto] SECRETS_ENCRYPTION_KEY не задан — используется ключ из JWT_SECRET. Задайте отдельный ключ на проде.'
    );
  }
  return crypto.scryptSync(jwt, 'erm-secrets-v1', 32);
}

function getKey() {
  if (!cachedKey) cachedKey = resolveKeyMaterial();
  return cachedKey;
}

/** Для тестов. */
export function resetSecretsCryptoCache() {
  cachedKey = null;
  warnedMissingExplicitKey = false;
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function isMaskedSecret(value) {
  if (value == null) return false;
  const s = String(value);
  return s.startsWith(MASK_PREFIX) || s.startsWith('***MASKED***');
}

export function encryptSecret(plain) {
  if (plain == null) return plain;
  const text = String(plain);
  if (!text) return text;
  if (isEncryptedSecret(text)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${b64url(iv)}:${b64url(tag)}:${b64url(ct)}`;
}

export function decryptSecret(value) {
  if (value == null) return value;
  const text = String(value);
  if (!text) return text;
  if (!isEncryptedSecret(text)) return text;
  const body = text.slice(PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('Некорректный формат зашифрованного секрета');
  }
  const [ivB, tagB, ctB] = parts;
  const decipher = crypto.createDecipheriv(ALGO, getKey(), fromB64url(ivB));
  decipher.setAuthTag(fromB64url(tagB));
  const pt = Buffer.concat([decipher.update(fromB64url(ctB)), decipher.final()]);
  return pt.toString('utf8');
}

export function maskSecret(plain) {
  if (plain == null || plain === '') return '';
  let s = String(plain);
  if (isEncryptedSecret(s)) {
    try {
      s = decryptSecret(s);
    } catch {
      return `${MASK_PREFIX}????`;
    }
  }
  if (s.length <= 4) return MASK_PREFIX;
  return `${MASK_PREFIX}${s.slice(-4)}`;
}

function normalizeConfigObject(config) {
  if (!config) return {};
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
}

/** Шифрует секретные поля (идемпотентно). */
export function encryptConfigSecrets(config) {
  const out = normalizeConfigObject(config);
  for (const key of SECRET_CONFIG_KEYS) {
    if (out[key] == null || out[key] === '') continue;
    const v = String(out[key]);
    if (isMaskedSecret(v)) continue;
    out[key] = encryptSecret(v);
  }
  return out;
}

/** Расшифровывает секретные поля для внутреннего использования (API МП). */
export function decryptConfigSecrets(config) {
  const out = normalizeConfigObject(config);
  for (const key of SECRET_CONFIG_KEYS) {
    if (out[key] == null || out[key] === '') continue;
    try {
      out[key] = decryptSecret(String(out[key]));
    } catch (e) {
      console.warn(`[secretsCrypto] decrypt failed for ${key}:`, e?.message || e);
    }
  }
  return out;
}

/** Маскирует секреты для ответа клиенту. */
export function maskConfigSecrets(config) {
  const out = normalizeConfigObject(config);
  for (const key of SECRET_CONFIG_KEYS) {
    if (out[key] == null || out[key] === '') continue;
    out[key] = maskSecret(out[key]);
  }
  return out;
}

/**
 * Слияние входящего config с предыдущим:
 * masked / пустое секретное поле → оставляем старое (уже зашифрованное или нет).
 */
export function mergeConfigSecrets(incoming, previous) {
  const next = normalizeConfigObject(incoming);
  const prev = normalizeConfigObject(previous);
  for (const key of SECRET_CONFIG_KEYS) {
    const v = next[key];
    if (v == null || v === '' || isMaskedSecret(v)) {
      if (prev[key] != null && prev[key] !== '') {
        next[key] = prev[key];
      } else {
        delete next[key];
      }
    }
  }
  return next;
}

export function presentCabinetRow(row) {
  if (!row || typeof row !== 'object') return row;
  return { ...row, config: maskConfigSecrets(row.config) };
}

export function presentCabinetRows(rows) {
  return Array.isArray(rows) ? rows.map(presentCabinetRow) : rows;
}

/**
 * Подготовка config к записи: merge masked → plaintext → encrypted.
 * @returns {{ plain: object, encrypted: object }}
 */
export function prepareConfigForStorage(incoming, previous = null) {
  const merged = mergeConfigSecrets(incoming, previous);
  const plain = decryptConfigSecrets(merged);
  const encrypted = encryptConfigSecrets(plain);
  return { plain, encrypted };
}
