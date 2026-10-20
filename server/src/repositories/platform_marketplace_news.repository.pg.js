/**
 * Лента новостей маркетплейсов (супер-админ).
 */

import { query } from '../config/database.js';

export function isMissingRelationError(err) {
  return err && String(err.code) === '42P01';
}

function rowToApi(row) {
  if (!row) return null;
  return {
    id: row.id != null ? String(row.id) : null,
    source: row.source,
    externalId: row.external_id,
    title: row.title,
    summary: row.summary,
    url: row.url,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    tags: Array.isArray(row.tags) ? row.tags : [],
  };
}

class PlatformMarketplaceNewsRepositoryPG {
  async upsertItem({ source, externalId, title, summary, url, publishedAt, tags, raw }) {
    const src = String(source || '').trim();
    const ext = String(externalId || '').trim();
    if (!src || !ext) throw new Error('source and externalId are required');

    const titleSafe = String(title || '').trim() || 'Без заголовка';
    const summarySafe = summary != null ? String(summary) : null;
    const urlSafe = url != null && String(url).trim() !== '' ? String(url).trim() : null;
    const tagsArr = Array.isArray(tags) ? tags.map((t) => String(t)).filter(Boolean) : [];
    const rawJson =
      raw && typeof raw === 'object' ? JSON.stringify(raw) : JSON.stringify({ value: raw ?? null });

    const result = await query(
      `INSERT INTO platform_marketplace_news
         (source, external_id, title, summary, url, published_at, fetched_at, tags, raw)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7::text[], $8::jsonb)
       ON CONFLICT (source, external_id) DO UPDATE SET
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         url = EXCLUDED.url,
         published_at = COALESCE(EXCLUDED.published_at, platform_marketplace_news.published_at),
         fetched_at = CURRENT_TIMESTAMP,
         tags = EXCLUDED.tags,
         raw = EXCLUDED.raw
       RETURNING *, (xmax = 0) AS inserted`,
      [src, ext, titleSafe, summarySafe, urlSafe, publishedAt || null, tagsArr, rawJson]
    );
    const row = result.rows[0];
    return { item: rowToApi(row), inserted: Boolean(row?.inserted) };
  }

  async list({ limit = 50, offset = 0, source = null } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const src =
      source != null && String(source).trim() !== '' && String(source).trim() !== 'all'
        ? String(source).trim().toLowerCase()
        : null;

    const countRes = src
      ? await query('SELECT COUNT(*)::bigint AS c FROM platform_marketplace_news WHERE source = $1', [
          src,
        ])
      : await query('SELECT COUNT(*)::bigint AS c FROM platform_marketplace_news');
    const total = Number(countRes.rows[0]?.c) || 0;

    const result = src
      ? await query(
          `SELECT id, source, external_id, title, summary, url, published_at, fetched_at, tags
           FROM platform_marketplace_news
           WHERE source = $1
           ORDER BY published_at DESC NULLS LAST, id DESC
           LIMIT $2 OFFSET $3`,
          [src, lim, off]
        )
      : await query(
          `SELECT id, source, external_id, title, summary, url, published_at, fetched_at, tags
           FROM platform_marketplace_news
           ORDER BY published_at DESC NULLS LAST, id DESC
           LIMIT $1 OFFSET $2`,
          [lim, off]
        );

    return { rows: result.rows.map(rowToApi), total };
  }
}

export default new PlatformMarketplaceNewsRepositoryPG();
