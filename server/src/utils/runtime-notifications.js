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
 * dedupeKey: пока такое уведомление не просмотрено, повтор обновляет его (repeat_count),
 * а не добавляет новое — фоновые задачи с ретраями иначе засыпают ленту дублями.
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

    const dedupeKey =
      input?.dedupeKey != null && String(input.dedupeKey).trim() !== ''
        ? String(input.dedupeKey).trim()
        : null;

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
      ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
      meta,
    };

    const current = (await readData(STORAGE_KEY)) || [];
    const arr = Array.isArray(current) ? current : [];
    let rest = arr;
    if (dedupeKey) {
      const prev = arr.find(
        (x) =>
          x?.dedupe_key === dedupeKey &&
          notificationProfileId(x) === notificationProfileId(n)
      );
      if (prev) {
        n.id = prev.id;
        n.first_created_at = prev.first_created_at || prev.created_at;
        n.repeat_count = (Number(prev.repeat_count) || 1) + 1;
        rest = arr.filter((x) => x !== prev);
      }
    }
    const next = [n, ...rest].slice(0, MAX_ITEMS);
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

/**
 * Снять уведомления типа type по заказам, которые уже разрешились (например, ушли поставщику).
 * Уведомление удаляется, только если все его meta.order_ids входят в orderIds.
 */
export async function resolveRuntimeNotificationsForOrders({ type, profileId = null, orderIds = [] } = {}) {
  try {
    const resolved = new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
    );
    if (!type || !resolved.size) return { ok: true, removed: 0 };
    const current = (await readData(STORAGE_KEY)) || [];
    const arr = Array.isArray(current) ? current : [];
    let removed = 0;
    const kept = arr.filter((n) => {
      if (n?.type !== type) return true;
      if (profileId != null && profileId !== '') {
        const np = notificationProfileId(n);
        if (np != null && Number(np) !== Number(profileId)) return true;
      }
      const ids = (Array.isArray(n?.meta?.order_ids) ? n.meta.order_ids : [])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
      if (!ids.length || !ids.every((id) => resolved.has(id))) return true;
      removed += 1;
      return false;
    });
    if (removed > 0) await writeData(STORAGE_KEY, kept);
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), removed: 0 };
  }
}

/**
 * Удалить runtime-уведомления по id.
 * С profileId — только своего аккаунта (и без profile_id).
 */
export async function removeRuntimeNotificationsByIds(ids, options = {}) {
  try {
    const idSet = new Set(
      (Array.isArray(ids) ? ids : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)
    );
    if (!idSet.size) return { ok: true, removed: 0 };

    const profileId = options.profileId ?? options.profile_id ?? null;
    const current = (await readData(STORAGE_KEY)) || [];
    const arr = Array.isArray(current) ? current : [];
    let removed = 0;
    const kept = arr.filter((n) => {
      const nid = String(n?.id || '').trim();
      if (!nid || !idSet.has(nid)) return true;
      if (profileId != null && profileId !== '') {
        const np = notificationProfileId(n);
        if (np != null && Number(np) !== Number(profileId)) return true;
      }
      removed += 1;
      return false;
    });
    if (removed > 0) await writeData(STORAGE_KEY, kept);
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), removed: 0 };
  }
}
