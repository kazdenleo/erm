/**
 * Лента новостей маркетплейсов (супер-админ).
 */

import { query } from '../config/database.js';

export function isMissingRelationError(err) {
  return err && (String(err.code) === '42P01' || String(err.code) === '42703');
}

function rowToApi(row) {
  if (!row) return null;
  const body = row.body != null ? String(row.body) : row.summary != null ? String(row.summary) : null;
  return {
    id: row.id != null ? String(row.id) : null,
    source: row.source,
    externalId: row.external_id,
    title: row.title,
    summary: row.summary,
    body,
    url: row.url,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    tags: Array.isArray(row.tags) ? row.tags : [],
    isRead: Boolean(row.is_read),
    readAt: row.read_at || null,
  };
}

class PlatformMarketplaceNewsRepositoryPG {
  async upsertItem({ source, externalId, title, summary, body, url, publishedAt, tags, raw }) {
    const src = String(source || '').trim();
    const ext = String(externalId || '').trim();
    if (!src || !ext) throw new Error('source and externalId are required');

    const titleSafe = String(title || '').trim() || 'Без заголовка';
    const bodySafe = body != null ? String(body) : summary != null ? String(summary) : null;
    const summarySafe = summary != null ? String(summary) : bodySafe != null ? String(bodySafe).slice(0, 800) : null;
    const urlSafe = url != null && String(url).trim() !== '' ? String(url).trim() : null;
    const tagsArr = Array.isArray(tags) ? tags.map((t) => String(t)).filter(Boolean) : [];
    const rawJson =
      raw && typeof raw === 'object' ? JSON.stringify(raw) : JSON.stringify({ value: raw ?? null });

    const result = await query(
      `INSERT INTO platform_marketplace_news
         (source, external_id, title, summary, body, url, published_at, fetched_at, tags, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, $8::text[], $9::jsonb)
       ON CONFLICT (source, external_id) DO UPDATE SET
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         body = EXCLUDED.body,
         url = EXCLUDED.url,
         published_at = COALESCE(EXCLUDED.published_at, platform_marketplace_news.published_at),
         fetched_at = CURRENT_TIMESTAMP,
         tags = EXCLUDED.tags,
         raw = EXCLUDED.raw
       RETURNING *, (xmax = 0) AS inserted`,
      [src, ext, titleSafe, summarySafe, bodySafe, urlSafe, publishedAt || null, tagsArr, rawJson]
    );
    const row = result.rows[0];
    return { item: rowToApi(row), inserted: Boolean(row?.inserted) };
  }

  async list({ limit = 50, offset = 0, source = null, userId = null, unreadOnly = false } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const src =
      source != null && String(source).trim() !== '' && String(source).trim() !== 'all'
        ? String(source).trim().toLowerCase()
        : null;
    const uid = userId != null && userId !== '' ? Number(userId) : null;
    const unread = Boolean(unreadOnly);

    const where = [];
    const params = [];
    if (src) {
      params.push(src);
      where.push(`n.source = $${params.length}`);
    }
    if (unread && uid != null && Number.isFinite(uid)) {
      where.push(`r.news_id IS NULL`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const joinSql =
      uid != null && Number.isFinite(uid)
        ? `LEFT JOIN platform_marketplace_news_reads r ON r.news_id = n.id AND r.user_id = $${params.length + 1}`
        : '';
    if (uid != null && Number.isFinite(uid)) params.push(uid);

    const countRes = await query(
      `SELECT COUNT(*)::bigint AS c
       FROM platform_marketplace_news n
       ${joinSql}
       ${whereSql}`,
      params
    );
    const total = Number(countRes.rows[0]?.c) || 0;

    const limIdx = params.length + 1;
    const offIdx = params.length + 2;
    const listParams = [...params, lim, off];
    const result = await query(
      `SELECT n.id, n.source, n.external_id, n.title, n.summary, n.body, n.url,
              n.published_at, n.fetched_at, n.tags,
              ${uid != null && Number.isFinite(uid) ? '(r.news_id IS NOT NULL)' : 'FALSE'} AS is_read,
              ${uid != null && Number.isFinite(uid) ? 'r.read_at' : 'NULL::timestamptz'} AS read_at
       FROM platform_marketplace_news n
       ${joinSql}
       ${whereSql}
       ORDER BY n.published_at DESC NULLS LAST, n.id DESC
       LIMIT $${limIdx} OFFSET $${offIdx}`,
      listParams
    );

    let unreadCount = 0;
    if (uid != null && Number.isFinite(uid)) {
      const unreadParams = [];
      let unreadWhere = 'r.news_id IS NULL';
      if (src) {
        unreadParams.push(src);
        unreadWhere = `n.source = $1 AND ${unreadWhere}`;
      }
      unreadParams.push(uid);
      const uidIdx = unreadParams.length;
      const uRes = await query(
        `SELECT COUNT(*)::bigint AS c
         FROM platform_marketplace_news n
         LEFT JOIN platform_marketplace_news_reads r ON r.news_id = n.id AND r.user_id = $${uidIdx}
         WHERE ${unreadWhere}`,
        unreadParams
      );
      unreadCount = Number(uRes.rows[0]?.c) || 0;
    }

    return { rows: result.rows.map(rowToApi), total, unreadCount };
  }

  async getById(id, userId = null) {
    const newsId = Number(id);
    if (!Number.isFinite(newsId)) return null;
    const uid = userId != null && userId !== '' ? Number(userId) : null;
    const params = [newsId];
    const joinSql =
      uid != null && Number.isFinite(uid)
        ? `LEFT JOIN platform_marketplace_news_reads r ON r.news_id = n.id AND r.user_id = $2`
        : '';
    if (uid != null && Number.isFinite(uid)) params.push(uid);

    const result = await query(
      `SELECT n.id, n.source, n.external_id, n.title, n.summary, n.body, n.url,
              n.published_at, n.fetched_at, n.tags,
              ${uid != null && Number.isFinite(uid) ? '(r.news_id IS NOT NULL)' : 'FALSE'} AS is_read,
              ${uid != null && Number.isFinite(uid) ? 'r.read_at' : 'NULL::timestamptz'} AS read_at
       FROM platform_marketplace_news n
       ${joinSql}
       WHERE n.id = $1
       LIMIT 1`,
      params
    );
    return rowToApi(result.rows[0]);
  }

  async markRead(newsId, userId) {
    const nid = Number(newsId);
    const uid = Number(userId);
    if (!Number.isFinite(nid) || !Number.isFinite(uid)) {
      throw new Error('newsId and userId are required');
    }
    await query(
      `INSERT INTO platform_marketplace_news_reads (user_id, news_id, read_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, news_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP`,
      [uid, nid]
    );
    return this.getById(nid, uid);
  }

  async markAllRead(userId, { source = null } = {}) {
    const uid = Number(userId);
    if (!Number.isFinite(uid)) throw new Error('userId is required');
    const src =
      source != null && String(source).trim() !== '' && String(source).trim() !== 'all'
        ? String(source).trim().toLowerCase()
        : null;

    if (src) {
      const result = await query(
        `INSERT INTO platform_marketplace_news_reads (user_id, news_id, read_at)
         SELECT $1, n.id, CURRENT_TIMESTAMP
         FROM platform_marketplace_news n
         WHERE n.source = $2
           AND NOT EXISTS (
             SELECT 1 FROM platform_marketplace_news_reads r
             WHERE r.user_id = $1 AND r.news_id = n.id
           )
         RETURNING news_id`,
        [uid, src]
      );
      return { marked: result.rowCount || 0 };
    }

    const result = await query(
      `INSERT INTO platform_marketplace_news_reads (user_id, news_id, read_at)
       SELECT $1, n.id, CURRENT_TIMESTAMP
       FROM platform_marketplace_news n
       WHERE NOT EXISTS (
         SELECT 1 FROM platform_marketplace_news_reads r
         WHERE r.user_id = $1 AND r.news_id = n.id
       )
       RETURNING news_id`,
      [uid]
    );
    return { marked: result.rowCount || 0 };
  }
}

export default new PlatformMarketplaceNewsRepositoryPG();
