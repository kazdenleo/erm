/**
 * Лента новостей маркетплейсов (супер-админ).
 */

import {
  listMarketplaceNews,
  syncMarketplaceNews,
  getMarketplaceNewsById,
  markMarketplaceNewsRead,
  markAllMarketplaceNewsRead,
} from '../services/platformMarketplaceNews.service.js';
import { isMissingRelationError } from '../repositories/platform_marketplace_news.repository.pg.js';

const ALLOWED_SOURCES = new Set(['ozon', 'wildberries', 'yandex', 'all']);
const ALLOWED_TAGS = new Set(['api', 'ops', 'all']);

function migrationHint(res) {
  return res.status(400).json({
    ok: false,
    message:
      'Таблицы не созданы. Выполните миграции 230_platform_marketplace_news.sql и 235_platform_marketplace_news_body_reads.sql',
  });
}

function normalizeSource(raw) {
  if (raw == null || raw === '') return null;
  let source = String(raw).trim().toLowerCase();
  if (source === 'wb') source = 'wildberries';
  return source;
}

function normalizeTag(raw) {
  if (raw == null || raw === '') return null;
  const tag = String(raw).trim().toLowerCase();
  if (tag === 'tariffs' || tag === 'conditions' || tag === 'ops_news') return 'ops';
  return tag;
}

export async function listNews(req, res, next) {
  try {
    const limit = req.query?.limit;
    const offset = req.query?.offset;
    const source = normalizeSource(req.query?.source);
    if (source && !ALLOWED_SOURCES.has(source)) {
      return res.status(400).json({
        ok: false,
        message: 'source: ozon | wildberries | yandex | all',
      });
    }
    const tag = normalizeTag(req.query?.tag ?? req.query?.topic);
    if (tag && !ALLOWED_TAGS.has(tag)) {
      return res.status(400).json({
        ok: false,
        message: 'tag: api | ops | all',
      });
    }
    const unreadOnly =
      req.query?.unread === '1' ||
      req.query?.unread === 'true' ||
      req.query?.unreadOnly === '1' ||
      req.query?.unreadOnly === 'true';

    const { rows, total, unreadCount } = await listMarketplaceNews({
      limit,
      offset,
      source: source === 'all' ? null : source,
      tag: tag === 'all' ? null : tag,
      userId: req.user?.id,
      unreadOnly,
    });
    res.json({ ok: true, data: { items: rows, total, unreadCount } });
  } catch (err) {
    if (isMissingRelationError(err)) return migrationHint(res);
    next(err);
  }
}

export async function getNews(req, res, next) {
  try {
    const item = await getMarketplaceNewsById(req.params.id, req.user?.id);
    if (!item) {
      return res.status(404).json({ ok: false, message: 'Новость не найдена' });
    }
    res.json({ ok: true, data: item });
  } catch (err) {
    if (isMissingRelationError(err)) return migrationHint(res);
    next(err);
  }
}

export async function markRead(req, res, next) {
  try {
    const item = await markMarketplaceNewsRead(req.params.id, req.user?.id);
    if (!item) {
      return res.status(404).json({ ok: false, message: 'Новость не найдена' });
    }
    res.json({ ok: true, data: item });
  } catch (err) {
    if (isMissingRelationError(err)) return migrationHint(res);
    next(err);
  }
}

export async function markAllRead(req, res, next) {
  try {
    const source = normalizeSource(req.body?.source ?? req.query?.source);
    if (source && !ALLOWED_SOURCES.has(source)) {
      return res.status(400).json({
        ok: false,
        message: 'source: ozon | wildberries | yandex | all',
      });
    }
    const tag = normalizeTag(req.body?.tag ?? req.body?.topic ?? req.query?.tag ?? req.query?.topic);
    if (tag && !ALLOWED_TAGS.has(tag)) {
      return res.status(400).json({
        ok: false,
        message: 'tag: api | ops | all',
      });
    }
    const result = await markAllMarketplaceNewsRead(req.user?.id, {
      source: source === 'all' ? null : source,
      tag: tag === 'all' ? null : tag,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    if (isMissingRelationError(err)) return migrationHint(res);
    next(err);
  }
}

export async function syncNews(req, res, next) {
  try {
    const result = await syncMarketplaceNews();
    res.json({ ok: true, data: result });
  } catch (err) {
    if (isMissingRelationError(err)) return migrationHint(res);
    next(err);
  }
}
