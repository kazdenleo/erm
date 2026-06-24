/**
 * Поиск открытой закупки поставщика для накопления позиций.
 * 1) Точное совпадение bucket в note: [auto-arrival:today] и т.д.
 * 2) Legacy-закупка без метки (старый формат «Из заказов …»).
 * Не сливает с закупкой другого bucket (today ≠ tomorrow).
 */

import {
  autoArrivalNoteMarker,
  autoArrivalNoteText,
  parseArrivalBucketFromPurchaseNote,
  normalizeArrivalBucket,
  resolveProcurementArrivalBucketFromApiConfig,
} from './supplierProcurementArrival.js';
import { loadWarehouseWeekendDays } from './warehouseProcurementCalendar.js';

function parseApiConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * @param {import('pg').PoolClient | { query: Function }} client
 */
export async function findOpenAutoPurchaseId(
  client,
  { profileId, supplierId, arrivalBucket }
) {
  const bucket = normalizeArrivalBucket(arrivalBucket);
  const markerLike = `${autoArrivalNoteMarker(bucket)}%`;

  const exact = await client.query(
    `SELECT id, note FROM purchases
     WHERE profile_id = $1 AND supplier_id = $2 AND status = 'open'
       AND note LIKE $3
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [profileId, supplierId, markerLike]
  );
  const exactRow = exact.rows?.[0];
  if (exactRow) {
    const parsed = parseArrivalBucketFromPurchaseNote(exactRow.note);
    if (!parsed || parsed === bucket) {
      return Number(exactRow.id);
    }
  }

  const legacy = await client.query(
    `SELECT id, note FROM purchases
     WHERE profile_id = $1 AND supplier_id = $2 AND status = 'open'
       AND (note IS NULL OR TRIM(note) = '' OR note NOT ILIKE '[auto-arrival:%')
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [profileId, supplierId]
  );
  const legacyRow = legacy.rows?.[0];
  if (legacyRow) {
    return Number(legacyRow.id);
  }

  return null;
}

/**
 * Добавить метку [auto-arrival:…] к старой закупке при первом дополнении.
 */
export async function upgradeLegacyPurchaseArrivalNote(
  client,
  purchaseId,
  arrivalBucket,
  { extraSuffix = null } = {}
) {
  const purId = Number(purchaseId);
  const bucket = normalizeArrivalBucket(arrivalBucket);
  if (!Number.isFinite(purId) || purId < 1) return;

  const r = await client.query(`SELECT note FROM purchases WHERE id = $1 LIMIT 1`, [purId]);
  const note = String(r.rows?.[0]?.note || '').trim();
  if (note.includes('[auto-arrival:')) return;

  const prefix = autoArrivalNoteText(bucket);
  let newNote = note ? `${prefix} · ${note}` : prefix;
  if (extraSuffix && !note.includes(extraSuffix)) {
    newNote = `${newNote} · ${extraSuffix}`;
  }
  await client.query(
    `UPDATE purchases SET note = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [purId, newNote]
  );
}

/**
 * Префикс note для новой закупки из заказов (если ещё нет метки bucket).
 */
export async function enrichProcurementNote(
  note,
  { supplierId, warehouseId, profileId, now = new Date() } = {}
) {
  const bucket = await resolveArrivalBucketForSupplier({ supplierId, warehouseId, profileId, now });
  if (!bucket) {
    const raw = note != null ? String(note).trim() : '';
    return raw || null;
  }
  const raw = note != null ? String(note).trim() : '';
  if (parseArrivalBucketFromPurchaseNote(raw)) return raw || null;
  const prefix = autoArrivalNoteText(bucket);
  return raw ? `${prefix} · ${raw}` : prefix;
}

export async function resolveArrivalBucketForSupplier({
  supplierId,
  warehouseId,
  profileId,
  now = new Date(),
} = {}) {
  const sid = Number(supplierId);
  const wid = Number(warehouseId);
  const pid = profileId != null ? Number(profileId) : null;
  if (!Number.isFinite(sid) || sid < 1 || !Number.isFinite(pid)) return null;

  const { query } = await import('../config/database.js');
  const sup = await query(
    `SELECT api_config FROM suppliers WHERE id = $1 AND profile_id = $2 LIMIT 1`,
    [sid, pid]
  );
  const apiConfig = parseApiConfig(sup.rows?.[0]?.api_config);
  const warehouseWeekendDays =
    Number.isFinite(wid) && wid > 0 ? await loadWarehouseWeekendDays(wid, pid) : null;
  return resolveProcurementArrivalBucketFromApiConfig(apiConfig, now, warehouseWeekendDays);
}

export { normalizeArrivalBucket };
