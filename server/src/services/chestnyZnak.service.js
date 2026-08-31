/**
 * Честный знак — True API (ГИС МТ)
 */

import fetch from 'node-fetch';
import repositoryFactory from '../config/repository-factory.js';
import logger from '../utils/logger.js';
import {
  CHESTNY_ZNAK_CODE,
  CHESTNY_ZNAK_TYPE,
  buildTrueApiBaseUrl,
  isTokenExpired,
  isTokenPlaceholder,
  mapCisInfoResponse,
  normalizeCis,
  parseIntegrationConfig,
  parseJwtPayload,
  splitCisList,
  toPublicChestnyZnakConfig,
  tokenExpiryIso,
} from '../utils/chestnyZnak.js';

const FETCH_TIMEOUT_MS = 25000;
const MAX_CIS_PER_REQUEST = 900;

function httpError(message, statusCode = 400, details = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (details != null) err.details = details;
  return err;
}

function parseJsonSafe(text) {
  if (text == null || String(text).trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

class ChestnyZnakService {
  constructor() {
    this.repository = repositoryFactory.getIntegrationsRepository();
  }

  _requirePg() {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      throw httpError('Честный знак доступен только при работе с PostgreSQL', 400);
    }
  }

  _requireScope({ profileId, organizationId } = {}) {
    if (profileId == null || profileId === '') {
      throw httpError('Нет привязки к аккаунту', 403);
    }
    if (organizationId == null || String(organizationId).trim() === '') {
      throw httpError('Выберите организацию', 400);
    }
  }

  async _loadRow({ profileId, organizationId }) {
    this._requirePg();
    this._requireScope({ profileId, organizationId });
    return this.repository.findByCode(CHESTNY_ZNAK_CODE, profileId, organizationId);
  }

  async _loadConfig({ profileId, organizationId }) {
    const row = await this._loadRow({ profileId, organizationId });
    return parseIntegrationConfig(row?.config);
  }

  async getPublicConfig({ profileId, organizationId } = {}) {
    const cfg = await this._loadConfig({ profileId, organizationId });
    return toPublicChestnyZnakConfig(cfg);
  }

  async saveConfig(body, { profileId, organizationId } = {}) {
    this._requirePg();
    this._requireScope({ profileId, organizationId });
    const incoming = body && typeof body === 'object' ? body : {};
    const existingRow = await this._loadRow({ profileId, organizationId });
    const existing = parseIntegrationConfig(existingRow?.config);

    const next = { ...existing };

    if (incoming.sandbox !== undefined) next.sandbox = Boolean(incoming.sandbox);
    if (incoming.is_active !== undefined) next.is_active = incoming.is_active !== false && incoming.is_active !== 'false';
    if (incoming.united_token !== undefined) next.united_token = Boolean(incoming.united_token);
    if (incoming.api_version !== undefined) {
      next.api_version = String(incoming.api_version).toLowerCase() === 'v4' ? 'v4' : 'v3';
    }
    if (incoming.api_url !== undefined) {
      next.api_url = String(incoming.api_url || '').trim();
    }
    if (incoming.inn !== undefined) {
      next.inn = String(incoming.inn || '').replace(/\D/g, '').slice(0, 12);
    }
    if (incoming.cert_thumbprint !== undefined) {
      next.cert_thumbprint = String(incoming.cert_thumbprint || '').replace(/\s+/g, '').toUpperCase();
    }
    if (incoming.product_groups !== undefined) {
      const list = Array.isArray(incoming.product_groups)
        ? incoming.product_groups
        : String(incoming.product_groups || '').split(',');
      next.product_groups = list.map((x) => String(x).trim()).filter(Boolean);
    }
    if (incoming.oms_id !== undefined) next.oms_id = String(incoming.oms_id || '').trim();
    if (incoming.oms_connection !== undefined) {
      next.oms_connection = String(incoming.oms_connection || '').trim();
    }
    if (incoming.oms_token !== undefined && !isTokenPlaceholder(incoming.oms_token)) {
      next.oms_token = String(incoming.oms_token).trim();
    }

    if (incoming.token !== undefined && !isTokenPlaceholder(incoming.token)) {
      const token = String(incoming.token).trim();
      next.token = token;
      next.token_expires_at = incoming.token_expires_at || tokenExpiryIso(token);
    }

    const isActive = next.is_active !== false;
    next.is_active = isActive;

    if (existingRow) {
      await this.repository.update(existingRow.id, {
        config: next,
        is_active: isActive,
        name: 'Честный знак',
      });
    } else {
      await this.repository.create({
        profile_id: profileId,
        organization_id: organizationId,
        type: CHESTNY_ZNAK_TYPE,
        name: 'Честный знак',
        code: CHESTNY_ZNAK_CODE,
        config: next,
        is_active: isActive,
      });
    }

    return this.getPublicConfig({ profileId, organizationId });
  }

  async _persistToken(token, extras, { profileId, organizationId }) {
    const existing = await this._loadConfig({ profileId, organizationId });
    const next = {
      ...existing,
      token: String(token || '').trim(),
      token_expires_at: tokenExpiryIso(token),
      ...extras,
    };
    return this.saveConfig(next, { profileId, organizationId });
  }

  _baseUrl(cfg) {
    return buildTrueApiBaseUrl(cfg);
  }

  async _trueApiFetch(cfg, method, path, { body, token } = {}) {
    const base = this._baseUrl(cfg);
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = {
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const bearer = token ?? cfg.token;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw httpError('Честный знак не ответил вовремя. Повторите запрос.', 504);
      }
      throw httpError(`Не удалось связаться с Честным знаком: ${err.message}`, 502);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const json = parseJsonSafe(text);
    return { res, text, json, url };
  }

  _gisMessage(json, fallback) {
    if (!json || typeof json !== 'object') return fallback;
    return (
      json.error_message ||
      json.errorMessage ||
      json.message ||
      json.description ||
      (Array.isArray(json.errors) && json.errors[0]?.errorMessage) ||
      fallback
    );
  }

  async fetchAuthKey({ profileId, organizationId } = {}) {
    const cfg = await this._loadConfig({ profileId, organizationId });
    const { res, json, text } = await this._trueApiFetch(cfg, 'GET', '/auth/key');
    if (!res.ok) {
      throw httpError(
        this._gisMessage(json, `Не удалось получить ключ авторизации (HTTP ${res.status})`),
        res.status >= 500 ? 502 : 400,
        json || text
      );
    }
    const uuid = json?.uuid;
    const data = json?.data;
    if (!uuid || !data) {
      throw httpError('Честный знак вернул пустой ключ авторизации', 502);
    }
    return { uuid, data, sandbox: Boolean(cfg.sandbox), base_url: this._baseUrl(cfg) };
  }

  async signIn({ uuid, signature, inn, unitedToken, cert_thumbprint }, { profileId, organizationId } = {}) {
    const cfg = await this._loadConfig({ profileId, organizationId });
    const signUuid = String(uuid || '').trim();
    const data = String(signature || '').trim();
    if (!signUuid || !data) {
      throw httpError('Нужны uuid и подпись УКЭП');
    }
    const innDigits = String(inn || cfg.inn || '').replace(/\D/g, '').slice(0, 12);
    const useUnited =
      unitedToken != null ? Boolean(unitedToken) : Boolean(cfg.united_token);
    const body = {
      uuid: signUuid,
      data,
      unitedToken: useUnited,
    };
    if (innDigits.length === 10 || innDigits.length === 12) {
      body.inn = innDigits;
    }

    const { res, json, text } = await this._trueApiFetch(cfg, 'POST', '/auth/simpleSignIn', { body });
    if (!res.ok) {
      throw httpError(
        this._gisMessage(json, `Авторизация в Честном знаке не удалась (HTTP ${res.status})`),
        res.status === 401 || res.status === 403 ? 400 : res.status >= 500 ? 502 : 400,
        json || text
      );
    }
    const token = json?.token || json?.access_token;
    if (!token) {
      throw httpError('Честный знак не вернул токен', 502, json || text);
    }

    const extras = {};
    if (innDigits) extras.inn = innDigits;
    if (cert_thumbprint) {
      extras.cert_thumbprint = String(cert_thumbprint).replace(/\s+/g, '').toUpperCase();
    }
    extras.united_token = useUnited;
    extras.is_active = true;

    const publicCfg = await this._persistToken(token, extras, { profileId, organizationId });
    logger.info('[ChestnyZnak] signed in', {
      profileId,
      organizationId,
      expires_at: publicCfg.token_expires_at,
    });
    return publicCfg;
  }

  async _requireLiveToken({ profileId, organizationId }) {
    const cfg = await this._loadConfig({ profileId, organizationId });
    const token = String(cfg.token || '').trim();
    if (!token) {
      throw httpError('Сначала войдите в Честный знак по УКЭП или сохраните токен');
    }
    if (isTokenExpired(token)) {
      throw httpError('Сессия Честного знака истекла. Войдите по УКЭП снова.');
    }
    return cfg;
  }

  async testConnection({ profileId, organizationId } = {}) {
    const cfg = await this._requireLiveToken({ profileId, organizationId });
    const { res, json, text } = await this._trueApiFetch(cfg, 'POST', '/cises/info', {
      body: ['00'],
    });
    if (res.status === 401 || res.status === 403) {
      throw httpError(
        this._gisMessage(json, 'Токен не принят Честным знаком. Войдите по УКЭП заново.'),
        400
      );
    }
    if (res.status >= 500) {
      throw httpError(
        this._gisMessage(json, `Честный знак временно недоступен (HTTP ${res.status})`),
        502,
        json || text
      );
    }
    const payload = parseJwtPayload(cfg.token);
    return {
      ok: true,
      message: 'Подключение к True API установлено',
      sandbox: Boolean(cfg.sandbox),
      base_url: this._baseUrl(cfg),
      token_expires_at: cfg.token_expires_at || tokenExpiryIso(cfg.token),
      inn: payload?.inn || cfg.inn || null,
    };
  }

  async checkCises(codes, { profileId, organizationId } = {}) {
    const list = Array.isArray(codes)
      ? codes.map(normalizeCis).filter(Boolean)
      : splitCisList(codes, { max: MAX_CIS_PER_REQUEST });
    if (list.length === 0) {
      throw httpError('Укажите хотя бы один код маркировки');
    }
    if (list.length > MAX_CIS_PER_REQUEST) {
      throw httpError(`За один раз можно проверить не больше ${MAX_CIS_PER_REQUEST} кодов`);
    }

    const cfg = await this._requireLiveToken({ profileId, organizationId });
    const { res, json, text } = await this._trueApiFetch(cfg, 'POST', '/cises/info', {
      body: list,
    });
    if (res.status === 401 || res.status === 403) {
      throw httpError(
        this._gisMessage(json, 'Сессия истекла или нет доступа. Войдите по УКЭП заново.'),
        400
      );
    }
    if (!res.ok) {
      throw httpError(
        this._gisMessage(json, `Не удалось проверить коды (HTTP ${res.status})`),
        res.status >= 500 ? 502 : 400,
        json || text
      );
    }
    return {
      items: mapCisInfoResponse(json),
      requested: list.length,
    };
  }
}

export default new ChestnyZnakService();
