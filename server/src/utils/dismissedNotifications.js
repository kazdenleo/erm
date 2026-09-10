/**
 * Просмотренные (скрытые) уведомления по пользователю.
 * Синтетические (токены/сертификаты) нельзя удалить из источника — прячем по id.
 * Runtime при «просмотрено» удаляем из хранилища; id также пишем сюда на случай гонок.
 */

import { readData, writeData } from './storage.js';

const STORAGE_KEY = 'dismissedNotifications';
const MAX_IDS_PER_USER = 500;

function normalizeIds(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function readStore() {
  const raw = (await readData(STORAGE_KEY)) || {};
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export async function getDismissedNotificationIds(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return new Set();
  const store = await readStore();
  const entry = store[String(uid)];
  const ids = Array.isArray(entry)
    ? entry
    : Array.isArray(entry?.ids)
      ? entry.ids
      : [];
  return new Set(normalizeIds(ids));
}

export async function dismissNotificationIds(userId, ids) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, error: 'userId required' };
  }
  const toAdd = normalizeIds(ids);
  if (!toAdd.length) return { ok: true, added: 0, ids: [] };

  const store = await readStore();
  const key = String(uid);
  const prev = store[key];
  const prevIds = Array.isArray(prev)
    ? prev
    : Array.isArray(prev?.ids)
      ? prev.ids
      : [];
  const merged = normalizeIds([...toAdd, ...prevIds]).slice(0, MAX_IDS_PER_USER);
  store[key] = { ids: merged, updated_at: new Date().toISOString() };
  await writeData(STORAGE_KEY, store);
  return { ok: true, added: toAdd.length, ids: toAdd };
}
