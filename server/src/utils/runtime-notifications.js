import logger from './logger.js';
import { readData, writeData } from './storage.js';

const STORAGE_KEY = 'runtimeNotifications';
const MAX_ITEMS = 200;

function normalizeSeverity(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'error' || s === 'warn' || s === 'info') return s;
  return 'info';
}

function makeId(prefix = 'rt') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Runtime-уведомления: ошибки/предупреждения фоновых задач и интеграций.
 * Храним в storage (файл), чтобы UI мог показать даже после перезапуска.
 */
export async function addRuntimeNotification(input) {
  try {
    const now = new Date().toISOString();
    const n = {
      id: input?.id || makeId('rt'),
      type: input?.type || 'runtime',
      severity: normalizeSeverity(input?.severity),
      title: input?.title || 'Системное уведомление',
      message: String(input?.message || '').slice(0, 2000),
      marketplace: input?.marketplace || undefined,
      source: input?.source || undefined,
      created_at: input?.created_at || now,
      meta: input?.meta && typeof input.meta === 'object' ? input.meta : undefined
    };

    const current = (await readData(STORAGE_KEY)) || [];
    const arr = Array.isArray(current) ? current : [];
    const next = [n, ...arr].slice(0, MAX_ITEMS);
    await writeData(STORAGE_KEY, next);
    return n;
  } catch (e) {
    logger?.warn?.('[Runtime Notifications] Failed to store notification:', e?.message || e);
    return null;
  }
}

export async function getRuntimeNotifications() {
  try {
    const current = (await readData(STORAGE_KEY)) || [];
    return Array.isArray(current) ? current : [];
  } catch (_) {
    return [];
  }
}

export async function clearRuntimeNotifications() {
  try {
    await writeData(STORAGE_KEY, []);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

