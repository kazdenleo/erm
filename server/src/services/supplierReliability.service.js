/**
 * Учёт и загрузка надёжности поставщиков для автозакупки.
 */
import { query } from '../config/database.js';
import {
  countsFromReliabilityEvents,
  reliabilityScoreFromCounts,
  reliabilityWindowDays,
  DEFAULT_RELIABILITY_SCORE,
} from '../utils/supplierReliability.js';

const ALLOWED = new Set([
  'submit_ok',
  'submit_reject',
  'submit_partial',
  'late_delivery',
  'on_time_delivery',
]);

/**
 * @param {{
 *   profileId?: number|null,
 *   supplierId: number,
 *   eventType: string,
 *   purchaseId?: number|null,
 *   productId?: number|null,
 *   meta?: object|null,
 * }} opts
 */
export async function recordSupplierReliabilityEvent(opts) {
  const supplierId = Number(opts?.supplierId);
  const eventType = String(opts?.eventType || '');
  if (!Number.isFinite(supplierId) || supplierId <= 0) return null;
  if (!ALLOWED.has(eventType)) return null;

  const profileId =
    opts?.profileId != null && Number.isFinite(Number(opts.profileId))
      ? Number(opts.profileId)
      : null;
  const purchaseId =
    opts?.purchaseId != null && Number.isFinite(Number(opts.purchaseId))
      ? Number(opts.purchaseId)
      : null;
  const productId =
    opts?.productId != null && Number.isFinite(Number(opts.productId))
      ? Number(opts.productId)
      : null;
  const meta = opts?.meta && typeof opts.meta === 'object' ? opts.meta : null;

  try {
    const r = await query(
      `INSERT INTO supplier_reliability_events
         (profile_id, supplier_id, event_type, purchase_id, product_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        profileId,
        supplierId,
        eventType,
        purchaseId,
        productId,
        meta ? JSON.stringify(meta) : null,
      ]
    );
    return r.rows?.[0]?.id ?? null;
  } catch (e) {
    // Таблица может ещё не быть на окружении — не ломаем submit/приёмку.
    if (String(e?.code) === '42P01') return null;
    console.warn('[supplierReliability] record failed:', e?.message || e);
    return null;
  }
}

/**
 * Карта supplierId → score 0..1 за окно WINDOW_DAYS.
 * @param {number[]} supplierIds
 * @param {{ profileId?: number|null }} [opts]
 * @returns {Promise<Map<number, number>>}
 */
export async function loadSupplierReliabilityScores(supplierIds, opts = {}) {
  const ids = [
    ...new Set(
      (supplierIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  const out = new Map();
  if (!ids.length) return out;

  const days = reliabilityWindowDays();
  const profileId =
    opts?.profileId != null && Number.isFinite(Number(opts.profileId))
      ? Number(opts.profileId)
      : null;

  try {
    // Глобально по supplier; profileId в meta для аналитики, на score не режем —
    // отказ «АвтоОпт» одинаково важен для всех профилей.
    const r = await query(
      `SELECT supplier_id, event_type
       FROM supplier_reliability_events
       WHERE supplier_id = ANY($1::bigint[])
         AND created_at >= NOW() - ($2::text || ' days')::interval`,
      [ids, String(days)]
    );

    /** @type {Map<number, Array<{event_type:string}>>} */
    const bySup = new Map();
    for (const row of r.rows || []) {
      const sid = Number(row.supplier_id);
      if (!bySup.has(sid)) bySup.set(sid, []);
      bySup.get(sid).push({ event_type: row.event_type });
    }

    for (const sid of ids) {
      const counts = countsFromReliabilityEvents(bySup.get(sid) || []);
      out.set(sid, reliabilityScoreFromCounts(counts));
    }
  } catch (e) {
    if (String(e?.code) !== '42P01') {
      console.warn('[supplierReliability] load failed:', e?.message || e);
    }
    for (const sid of ids) {
      if (!out.has(sid)) out.set(sid, DEFAULT_RELIABILITY_SCORE);
    }
  }

  // Не использованный profileId — оставляем параметр для будущей сегментации.
  void profileId;
  return out;
}

/**
 * После успешной приёмки: сравнить completed_at с planned_delivery_date.
 * @param {{ purchaseId: number, supplierId?: number|null, plannedDeliveryDate?: string|Date|null, completedAt?: string|Date|null, profileId?: number|null }} opts
 */
export async function recordDeliveryTimingForPurchase(opts) {
  const purchaseId = Number(opts?.purchaseId);
  let supplierId = opts?.supplierId != null ? Number(opts.supplierId) : null;
  let planned = opts?.plannedDeliveryDate ?? null;
  let completedAt = opts?.completedAt ?? new Date();

  if (!Number.isFinite(purchaseId) || purchaseId <= 0) return null;

  try {
    if (!Number.isFinite(supplierId) || supplierId <= 0 || !planned) {
      const r = await query(
        `SELECT supplier_id, planned_delivery_date, organization_id
         FROM purchases WHERE id = $1 LIMIT 1`,
        [purchaseId]
      );
      const row = r.rows?.[0];
      if (!row) return null;
      if (!Number.isFinite(supplierId) || supplierId <= 0) {
        supplierId = Number(row.supplier_id);
      }
      if (!planned) planned = row.planned_delivery_date;
    }

    if (!Number.isFinite(supplierId) || supplierId <= 0 || !planned) return null;

    const plannedDay = new Date(planned);
    const doneDay = new Date(completedAt);
    if (Number.isNaN(plannedDay.getTime()) || Number.isNaN(doneDay.getTime())) return null;

    // Сравниваем календарные дни (UTC date-part достаточно для SLA «к дате»).
    const pYmd = plannedDay.toISOString().slice(0, 10);
    const dYmd = doneDay.toISOString().slice(0, 10);
    const late = dYmd > pYmd;

    return await recordSupplierReliabilityEvent({
      profileId: opts?.profileId ?? null,
      supplierId,
      eventType: late ? 'late_delivery' : 'on_time_delivery',
      purchaseId,
      meta: { plannedDeliveryDate: pYmd, completedAt: dYmd },
    });
  } catch (e) {
    console.warn('[supplierReliability] delivery timing failed:', e?.message || e);
    return null;
  }
}

export default {
  recordSupplierReliabilityEvent,
  loadSupplierReliabilityScores,
  recordDeliveryTimingForPurchase,
};
