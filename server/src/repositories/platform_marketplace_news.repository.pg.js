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

  async list({
    limit = 50,
    offset = 0,
    source = null,
    sources = null,
    tag = null,
    userId = null,
    unreadOnly = false,
  } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const src =
      source != null && String(source).trim() !== '' && String(source).trim() !== 'all'
        ? String(source).trim().toLowerCase()
        : null;
    const srcList = Array.isArray(sources)
      ? [...new Set(sources.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))]
      : null;
    const tagFilter =
      tag != null && String(tag).trim() !== '' && String(tag).trim() !== 'all'
        ? String(tag).trim().toLowerCase()
        : null;
    const uid = userId != null && userId !== '' ? Number(userId) : null;
    const unread = Boolean(unreadOnly);

    const where = [];
    const params = [];
    if (src) {
      params.push(src);
      where.push(`n.source = $${params.length}`);
    } else if (srcList) {
      if (!srcList.length) {
        return { rows: [], total: 0, unreadCount: 0 };
      }
      params.push(srcList);
      where.push(`n.source = ANY($${params.length}::text[])`);
    }
    if (tagFilter) {
      params.push(tagFilter);
      where.push(`n.tags @> ARRAY[$${params.length}]::text[]`);
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
      const unreadWhereParts = ['r.news_id IS NULL'];
      if (src) {
        unreadParams.push(src);
        unreadWhereParts.unshift(`n.source = $${unreadParams.length}`);
      } else if (srcList && srcList.length) {
        unreadParams.push(srcList);
        unreadWhereParts.unshift(`n.source = ANY($${unreadParams.length}::text[])`);
      }
      if (tagFilter) {
        unreadParams.push(tagFilter);
        unreadWhereParts.unshift(`n.tags @> ARRAY[$${unreadParams.length}]::text[]`);
      }
      unreadParams.push(uid);
      const uidIdx = unreadParams.length;
      const uRes = await query(
        `SELECT COUNT(*)::bigint AS c
         FROM platform_marketplace_news n
         LEFT JOIN platform_marketplace_news_reads r ON r.news_id = n.id AND r.user_id = $${uidIdx}
         WHERE ${unreadWhereParts.join(' AND ')}`,
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

  async listOpsForPrune({ limit = 500 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    const result = await query(
      `SELECT id, source, external_id, title, summary, body, tags
       FROM platform_marketplace_news
       WHERE tags @> ARRAY['ops']::text[]
       ORDER BY id ASC
       LIMIT $1`,
      [lim]
    );
    return (result.rows || []).map((row) => rowToApi(row));
  }

  async deleteByIds(ids) {
    const list = (Array.isArray(ids) ? ids : [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n));
    if (!list.length) return { deleted: 0 };
    const result = await query(
      `DELETE FROM platform_marketplace_news
       WHERE id = ANY($1::bigint[])
       RETURNING id`,
      [list]
    );
    return { deleted: result.rowCount || 0 };
  }

  async markAllRead(userId, { source = null, tag = null } = {}) {
    const uid = Number(userId);
    if (!Number.isFinite(uid)) throw new Error('userId is required');
    const src =
      source != null && String(source).trim() !== '' && String(source).trim() !== 'all'
        ? String(source).trim().toLowerCase()
        : null;
    const tagFilter =
      tag != null && String(tag).trim() !== '' && String(tag).trim() !== 'all'
        ? String(tag).trim().toLowerCase()
        : null;

    const where = [
      `NOT EXISTS (
         SELECT 1 FROM platform_marketplace_news_reads r
         WHERE r.user_id = $1 AND r.news_id = n.id
       )`,
    ];
    const params = [uid];
    if (src) {
      params.push(src);
      where.push(`n.source = $${params.length}`);
    }
    if (tagFilter) {
      params.push(tagFilter);
      where.push(`n.tags @> ARRAY[$${params.length}]::text[]`);
    }

    const result = await query(
      `INSERT INTO platform_marketplace_news_reads (user_id, news_id, read_at)
       SELECT $1, n.id, CURRENT_TIMESTAMP
       FROM platform_marketplace_news n
       WHERE ${where.join(' AND ')}
       RETURNING news_id`,
      params
    );
    return { marked: result.rowCount || 0 };
  }
}

export default new PlatformMarketplaceNewsRepositoryPG();
