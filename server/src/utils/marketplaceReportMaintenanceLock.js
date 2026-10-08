/**
 * Advisory lock + deadlock retry for FBS/FBO report line maintenance on analytics reads.
 */
import { query, getClient } from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Session-level advisory lock must be taken and released on the same connection,
 * otherwise the unlock is a no-op and the lock stays on a pooled connection.
 * If another request holds the lock longer than waitMs, maintenance is skipped
 * (it is best-effort for analytics reads) and null is returned.
 */
export async function withReportMaintenanceLock(lockBase, profileId, fn, { waitMs = 30000 } = {}) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return fn();
  const key = Number(lockBase) + pid;
  const client = await getClient();
  let locked = false;
  try {
    await client.query(`SET lock_timeout = '${Math.max(1, Math.floor(waitMs))}ms'`);
    try {
      await client.query(`SELECT pg_advisory_lock($1::bigint)`, [key]);
      locked = true;
    } catch (e) {
      if (e?.code !== '55P03') throw e;
      logger.warn('[MP Reports] maintenance lock busy, skipping maintenance', { key, waitMs });
      return null;
    } finally {
      await client.query(`SET lock_timeout = DEFAULT`).catch(() => {});
    }
    return await fn();
  } finally {
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [key]).catch(() => {});
    }
    client.release();
  }
}

export async function queryRetryDeadlock(sql, params, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await query(sql, params);
    } catch (e) {
      lastErr = e;
      if (e?.code !== '40P01' || i >= attempts - 1) throw e;
      const waitMs = 40 + i * 80 + Math.floor(Math.random() * 40);
      logger.warn('[MP Reports] deadlock, retry', { attempt: i + 1, waitMs, message: e.message });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

export const FBS_REPORT_MAINT_LOCK_BASE = 911_000_000;
export const FBO_REPORT_MAINT_LOCK_BASE = 912_000_000;
