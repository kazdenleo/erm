/**
 * Клиент API ЮKassa (платежи v3).
 * Env: YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const API_BASE = 'https://api.yookassa.ru/v3';

export function isYookassaConfigured() {
  const shopId = String(process.env.YOOKASSA_SHOP_ID || config?.yookassa?.shopId || '').trim();
  const secret = String(process.env.YOOKASSA_SECRET_KEY || config?.yookassa?.secretKey || '').trim();
  return !!(shopId && secret);
}

function credentials() {
  const shopId = String(process.env.YOOKASSA_SHOP_ID || config?.yookassa?.shopId || '').trim();
  const secret = String(process.env.YOOKASSA_SECRET_KEY || config?.yookassa?.secretKey || '').trim();
  if (!shopId || !secret) {
    const err = new Error('ЮKassa не настроена (YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY)');
    err.statusCode = 503;
    throw err;
  }
  return { shopId, secret };
}

function authHeader() {
  const { shopId, secret } = credentials();
  return `Basic ${Buffer.from(`${shopId}:${secret}`).toString('base64')}`;
}

async function ykFetch(method, path, body, idempotenceKey) {
  const headers = {
    Authorization: authHeader(),
    'Content-Type': 'application/json',
  };
  if (idempotenceKey) headers['Idempotence-Key'] = String(idempotenceKey);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg =
      json?.description ||
      json?.message ||
      `ЮKassa HTTP ${res.status}`;
    logger.warn('[yookassa] API error', { status: res.status, path, msg, json });
    const err = new Error(msg);
    err.statusCode = res.status >= 400 && res.status < 500 ? 400 : 502;
    err.data = json;
    throw err;
  }
  return json;
}

/**
 * Создать платёж с redirect confirmation.
 * @returns {Promise<{ id: string, status: string, confirmationUrl: string|null, raw: object }>}
 */
export async function createRedirectPayment({
  amountRub,
  description,
  returnUrl,
  metadata = {},
  idempotenceKey = null,
}) {
  const value = Number(amountRub);
  if (!Number.isFinite(value) || value <= 0) {
    const err = new Error('Некорректная сумма платежа');
    err.statusCode = 400;
    throw err;
  }
  const amountStr = value.toFixed(2);
  const key = idempotenceKey || crypto.randomUUID();
  const payload = {
    amount: { value: amountStr, currency: 'RUB' },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: returnUrl,
    },
    description: String(description || 'Оплата подписки').slice(0, 128),
    metadata: Object.fromEntries(
      Object.entries(metadata || {}).map(([k, v]) => [k, String(v)])
    ),
  };
  const raw = await ykFetch('POST', '/payments', payload, key);
  return {
    id: raw.id,
    status: raw.status,
    confirmationUrl: raw.confirmation?.confirmation_url || null,
    raw,
  };
}

export async function getPayment(paymentId) {
  const raw = await ykFetch('GET', `/payments/${encodeURIComponent(paymentId)}`);
  return raw;
}
