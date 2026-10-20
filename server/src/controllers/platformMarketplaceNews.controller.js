/**
 * Лента новостей маркетплейсов (супер-админ).
 */

import {
  listMarketplaceNews,
  syncMarketplaceNews,
} from '../services/platformMarketplaceNews.service.js';
import { isMissingRelationError } from '../repositories/platform_marketplace_news.repository.pg.js';

const ALLOWED_SOURCES = new Set(['ozon', 'wildberries', 'yandex', 'all']);

export async function listNews(req, res, next) {
  try {
    const limit = req.query?.limit;
    const offset = req.query?.offset;
    let source = req.query?.source != null ? String(req.query.source).trim().toLowerCase() : null;
    if (source === 'wb') source = 'wildberries';
    if (source && !ALLOWED_SOURCES.has(source)) {
      return res.status(400).json({
        ok: false,
        message: 'source: ozon | wildberries | yandex | all',
      });
    }
    const { rows, total } = await listMarketplaceNews({
      limit,
      offset,
      source: source === 'all' ? null : source,
    });
    res.json({ ok: true, data: { items: rows, total } });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return res.status(400).json({
        ok: false,
        message: 'Таблицы не созданы. Выполните миграцию 230_platform_marketplace_news.sql',
      });
    }
    next(err);
  }
}

export async function syncNews(req, res, next) {
  try {
    const result = await syncMarketplaceNews();
    res.json({ ok: true, data: result });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return res.status(400).json({
        ok: false,
        message: 'Таблицы не созданы. Выполните миграцию 230_platform_marketplace_news.sql',
      });
    }
    next(err);
  }
}
