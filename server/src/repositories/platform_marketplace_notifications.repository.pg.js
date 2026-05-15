/**
 * Глобальные уведомления маркетплейсов (супер-админ): журнал и ключи приёма.
 */

import { query } from '../config/database.js';

export function isMissingRelationError(err) {
  return err && String(err.code) === '42P01';
}

function rowSettingsToApi(row) {
  if (!row) return null;
  return {
    secrets:
      row.secrets && typeof row.secrets === 'object' ? row.secrets : typeof row.secrets === 'string' ? JSON.parse(row.secrets) : {},
    updatedAt: row.updated_at,
  };
}

function rowEventToApi(row) {
  if (!row) return null;
  return {
    id: row.id != null ? String(row.id) : null,
    source: row.source,
    eventType: row.event_type,
    requestMethod: row.request_method,
    pathHint: row.path_hint,
    payload: row.payload,
    headersSnapshot: row.headers_snapshot,
    createdAt: row.created_at,
  };
}

class PlatformMarketplaceNotificationsRepositoryPG {
  async getSettings() {
    const result = await query('SELECT * FROM platform_notification_settings WHERE id = 1 LIMIT 1');
    const row = result.rows[0];
    return rowSettingsToApi(row);
  }

  async updateSettings(secrets) {
    const payload = secrets && typeof secrets === 'object' ? secrets : {};
    const result = await query(
      `INSERT INTO platform_notification_settings (id, secrets, updated_at)
       VALUES (1, $1::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         secrets = EXCLUDED.secrets,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [JSON.stringify(payload)]
    );
    return rowSettingsToApi(result.rows[0]);
  }

  async insertEvent({ source, eventType, requestMethod, pathHint, payload, headersSnapshot }) {
    const src = source != null && String(source).trim() !== '' ? String(source).trim() : 'unknown';
    const et = eventType != null && String(eventType).trim() !== '' ? String(eventType).trim() : null;
    const rm = requestMethod != null ? String(requestMethod).toUpperCase() : null;
    const ph = pathHint != null ? String(pathHint) : null;
    const pl =
      payload && typeof payload === 'object'
        ? JSON.stringify(payload)
        : JSON.stringify({ value: payload });
    const hs =
      headersSnapshot && typeof headersSnapshot === 'object'
        ? JSON.stringify(headersSnapshot)
        : headersSnapshot != null
          ? JSON.stringify({ raw: String(headersSnapshot) })
          : null;

    const result = await query(
      `INSERT INTO platform_marketplace_events (source, event_type, request_method, path_hint, payload, headers_snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       RETURNING *`,
      [src, et, rm, ph, pl, hs]
    );
    return rowEventToApi(result.rows[0]);
  }

  async listEvents({ limit = 50, offset = 0 }) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const countRes = await query('SELECT COUNT(*)::bigint AS c FROM platform_marketplace_events');
    const total = Number(countRes.rows[0]?.c) || 0;
    const result = await query(
      `SELECT * FROM platform_marketplace_events
       ORDER BY created_at DESC, id DESC
       LIMIT $1 OFFSET $2`,
      [lim, off]
    );
    return { rows: result.rows.map(rowEventToApi), total };
  }
}

export default new PlatformMarketplaceNotificationsRepositoryPG();
