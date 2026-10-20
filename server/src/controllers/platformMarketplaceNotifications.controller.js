/**
 * Уведомления маркетплейсов (супер-админ): настройки ключей и журнал событий.
 */

import { getEnv } from '../config/env.js';
import platformMpNotificationsRepo, {
  isMissingRelationError,
} from '../repositories/platform_marketplace_notifications.repository.pg.js';
import {
  buildOzonAckResponse,
  buildOzonPingResponse,
  isOzonPingMessageType,
  isOzonPushMessageType,
  normalizeOzonMessageType,
} from '../utils/ozonPushWebhook.js';
import logger from '../utils/logger.js';

const ALLOWED_SOURCES = new Set(['ozon', 'wildberries', 'yandex', 'unknown']);
const OZON_HOOK_PATH = '/api/hooks/ozon';
const GENERIC_HOOK_PATH = '/api/hooks/marketplaces';

function normalizeSource(raw) {
  if (raw == null || raw === '') return 'unknown';
  const s = String(raw).trim().toLowerCase();
  if (s === 'wb' || s === 'wildberry') return 'wildberries';
  if (ALLOWED_SOURCES.has(s)) return s;
  return 'unknown';
}

function extractEventType(body) {
  if (!body || typeof body !== 'object') return null;
  const raw =
    body.message_type || body.type || body.event_type || body.MessageType || body.eventType || null;
  return raw != null ? String(raw) : null;
}

async function tryInsertMarketplaceEvent(fields) {
  try {
    await platformMpNotificationsRepo.insertEvent(fields);
    return true;
  } catch (err) {
    if (isMissingRelationError(err)) {
      logger.warn('[MP hooks] platform_marketplace_events missing; event not stored');
      return false;
    }
    logger.warn('[MP hooks] failed to store event', { message: err?.message || String(err) });
    return false;
  }
}

function respondOzonPush(res, messageType) {
  if (isOzonPingMessageType(messageType)) {
    return res.status(200).json(buildOzonPingResponse());
  }
  return res.status(200).json(buildOzonAckResponse());
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase();
    if (key === 'authorization' || key === 'cookie' || key === 'set-cookie') continue;
    out[k] = v;
  }
  return out;
}

function defaultSecretsShape() {
  return {
    ingestKey: '',
    ozon: { webhookSecret: '', clientId: '', comment: '' },
    wildberries: { token: '', comment: '' },
    yandex: { webhookSecret: '', comment: '' },
  };
}

function mergeSecrets(incoming) {
  const base = defaultSecretsShape();
  if (!incoming || typeof incoming !== 'object') return base;
  return {
    ...base,
    ...incoming,
    ozon: { ...base.ozon, ...(typeof incoming.ozon === 'object' ? incoming.ozon : {}) },
    wildberries: { ...base.wildberries, ...(typeof incoming.wildberries === 'object' ? incoming.wildberries : {}) },
    yandex: { ...base.yandex, ...(typeof incoming.yandex === 'object' ? incoming.yandex : {}) },
  };
}

export async function getSettings(req, res, next) {
  try {
    const data = await platformMpNotificationsRepo.getSettings();
    const secrets = mergeSecrets(data?.secrets);
    res.json({
      ok: true,
      data: {
        secrets,
        updatedAt: data?.updatedAt ?? null,
        hookPath: GENERIC_HOOK_PATH,
        ozonHookPath: OZON_HOOK_PATH,
        hookHint:
          'Общий URL: заголовок X-Platform-Ingest-Key и при необходимости X-Marketplace-Source: ozon | wildberries | yandex. Для push Ozon используйте отдельный URL /api/hooks/ozon (без ingest-ключа; ответ TYPE_PING и {"result":true}).',
      },
    });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return res.status(400).json({
        ok: false,
        message: 'Таблицы не созданы. Выполните миграцию 092_platform_marketplace_notifications.sql',
      });
    }
    next(err);
  }
}

export async function putSettings(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const secrets = mergeSecrets(body.secrets);
    const data = await platformMpNotificationsRepo.updateSettings(secrets);
    res.json({
      ok: true,
      data: {
        secrets: mergeSecrets(data?.secrets),
        updatedAt: data?.updatedAt ?? null,
        hookPath: GENERIC_HOOK_PATH,
        ozonHookPath: OZON_HOOK_PATH,
      },
    });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return res.status(400).json({
        ok: false,
        message: 'Таблицы не созданы. Выполните миграцию 092_platform_marketplace_notifications.sql',
      });
    }
    next(err);
  }
}

export async function listEvents(req, res, next) {
  try {
    const limit = req.query?.limit;
    const offset = req.query?.offset;
    const { rows, total } = await platformMpNotificationsRepo.listEvents({ limit, offset });
    res.json({ ok: true, data: { items: rows, total } });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return res.status(400).json({
        ok: false,
        message: 'Таблицы не созданы. Выполните миграцию 092_platform_marketplace_notifications.sql',
      });
    }
    next(err);
  }
}

/**
 * Приём вебхуков маркетплейсов (без сессии пользователя, только по ключу).
 * Если тело похоже на push Ozon (message_type TYPE_*), ответ в формате Seller API.
 */
export async function ingestMarketplaceHook(req, res, next) {
  try {
    let settings;
    try {
      settings = await platformMpNotificationsRepo.getSettings();
    } catch (err) {
      if (isMissingRelationError(err)) {
        return res.status(503).json({
          ok: false,
          message: 'Таблицы не созданы. Выполните миграцию 092_platform_marketplace_notifications.sql',
        });
      }
      throw err;
    }

    const merged = mergeSecrets(settings?.secrets);
    const dbKey = merged.ingestKey != null ? String(merged.ingestKey).trim() : '';
    const envKey = String(getEnv('PLATFORM_MP_INGEST_KEY', '') || '').trim();
    const expected = dbKey || envKey;

    if (!expected) {
      return res.status(503).json({
        ok: false,
        message:
          'Ключ приёма не задан. Укажите «Общий ключ приёма» в разделе админки «Уведомления» или переменную окружения PLATFORM_MP_INGEST_KEY.',
      });
    }

    const got = String(
      req.get('x-platform-ingest-key') || req.get('X-Platform-Ingest-Key') || ''
    ).trim();
    if (got !== expected) {
      return res.status(401).json({ ok: false, message: 'Неверный ключ приёма (X-Platform-Ingest-Key)' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const eventType = extractEventType(body);
    const sourceHint = req.get('x-marketplace-source') || req.get('X-Marketplace-Source') || body?.source;
    const source = normalizeSource(
      isOzonPushMessageType(eventType) && !sourceHint ? 'ozon' : sourceHint
    );

    await tryInsertMarketplaceEvent({
      source,
      eventType,
      requestMethod: req.method,
      pathHint: req.originalUrl || GENERIC_HOOK_PATH,
      payload: body,
      headersSnapshot: sanitizeHeaders(req.headers),
    });

    if (isOzonPushMessageType(eventType) || source === 'ozon') {
      return respondOzonPush(res, eventType);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * Публичный приём push Ozon Seller API (без ingest-ключа).
 * Нужен для TYPE_PING и непрерывного мониторинга доступности вебхука.
 * События пишем в журнал; бизнес-обработку пока не запускаем — только быстрый ack.
 */
export async function ingestOzonPush(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const eventType = extractEventType(body);
  const messageType = normalizeOzonMessageType(eventType);

  // TYPE_PING подтверждаем даже если журнал недоступен — иначе Ozon приостановит доставку.
  await tryInsertMarketplaceEvent({
    source: 'ozon',
    eventType: eventType || (messageType || null),
    requestMethod: req.method,
    pathHint: req.originalUrl || OZON_HOOK_PATH,
    payload: body,
    headersSnapshot: sanitizeHeaders(req.headers),
  });

  return respondOzonPush(res, messageType || eventType);
}
