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

/** Достаёт profile_id из уведомления (top-level или meta). */
export function notificationProfileId(n) {
  if (!n || typeof n !== 'object') return null;
  const raw = n.profile_id ?? n.profileId ?? n.meta?.profile_id ?? n.meta?.profileId ?? null;
  if (raw == null || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/**
 * Видимость runtime-уведомления для аккаунта:
 * - без profileId в запросе (системный контекст) — все;
 * - уведомление без profile_id — не показываем тенанту (чтобы не утекали чужие);
 * - иначе — только совпадение profile_id.
 */
export function isRuntimeNotificationForProfile(n, profileId) {
  if (profileId == null || profileId === '') return true;
  const pid = notificationProfileId(n);
  if (pid == null) return false;
  return Number(pid) === Number(profileId);
}

/**
 * Runtime-уведомления: ошибки/предупреждения фоновых задач и интеграций.
 * Храним в storage (файл), чтобы UI мог показать даже после перезапуска.
 * Обязательно передавайте profileId / profile_id — иначе уведомление не увидят пользователи аккаунтов.
 */
export async function addRuntimeNotification(input) {
  try {
    const now = new Date().toISOString();
    const profileIdRaw =
      input?.profileId ??
      input?.profile_id ??
      input?.meta?.profile_id ??
      input?.meta?.profileId ??
      null;
    const profileId =
      profileIdRaw != null && profileIdRaw !== '' && Number.isFinite(Number(profileIdRaw))
        ? Number(profileIdRaw)
        : null;

    const meta =
      input?.meta && typeof input.meta === 'object' ? { ...input.meta } : undefined;
    if (meta && profileId != null && meta.profile_id == null && meta.profileId == null) {
      meta.profile_id = profileId;
    }

    const n = {
      id: input?.id || makeId('rt'),
      type: input?.type || 'runtime',
      severity: normalizeSeverity(input?.severity),
      title: input?.title || 'Системное уведомление',
      message: String(input?.message || '').slice(0, 2000),
      marketplace: input?.marketplace || undefined,
      source: input?.source || undefined,
      created_at: input?.created_at || now,
      ...(profileId != null ? { profile_id: profileId } : {}),
      meta,
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

export async function getRuntimeNotifications(options = {}) {
  try {
    const current = (await readData(STORAGE_KEY)) || [];
    const arr = Array.isArray(current) ? current : [];
    const profileId = options.profileId ?? options.profile_id ?? null;
    if (profileId == null || profileId === '') return arr;
    return arr.filter((n) => isRuntimeNotificationForProfile(n, profileId));
  } catch (_) {
    return [];
  }
}

/**
 * Очистить runtime-уведомления.
 * С profileId — только этого аккаунта (+ старые без profile_id не трогаем у других,
 * но «осиротевшие» без profile_id при очистке аккаунта тоже убираем, чтобы не копились).
 * Без profileId — всё (как раньше, для админ-контекста).
 */
export async function clearRuntimeNotifications(options = {}) {
  try {
    const profileId = options.profileId ?? options.profile_id ?? null;
    if (profileId == null || profileId === '') {
      await writeData(STORAGE_KEY, []);
      return { ok: true };
    }
    const current = (await readData(STORAGE_KEY)) || [];
    const arr = Array.isArray(current) ? current : [];
    const pid = Number(profileId);
    const kept = arr.filter((n) => {
      const np = notificationProfileId(n);
      // чужие аккаунты оставляем
      if (np != null && Number(np) !== pid) return true;
      // свои и «без аккаунта» — удаляем при очистке этого аккаунта
      return false;
    });
    await writeData(STORAGE_KEY, kept);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
