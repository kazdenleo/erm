/**
 * Advisory lock + deadlock retry for FBS/FBO report line maintenance on analytics reads.
 */
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

export async function withReportMaintenanceLock(lockBase, profileId, fn) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return fn();
  const key = Number(lockBase) + pid;
  await query(`SELECT pg_advisory_lock($1::bigint)`, [key]);
  try {
    return await fn();
  } finally {
    await query(`SELECT pg_advisory_unlock($1::bigint)`, [key]).catch(() => {});
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
