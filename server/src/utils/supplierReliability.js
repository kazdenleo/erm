/**
 * Надёжность поставщика для выбора в закупке.
 * Чуть более дорогой, но стабильный побеждает дешёвого с частыми отказами.
 */

/** Штраф к цене (₽) при reliability = 0; при 1 — без надбавки. */
export const DEFAULT_RELIABILITY_PENALTY_RUB = 120;

/** Нет статистики — слегка ниже идеала, чтобы проверенные не проигрывали. */
export const DEFAULT_RELIABILITY_SCORE = 0.85;

const WINDOW_DAYS = 45;

/**
 * @param {{ rejects?: number, oks?: number, late?: number, onTime?: number }} counts
 * @returns {number} 0..1
 */
export function reliabilityScoreFromCounts(counts = {}) {
  const rejects = Math.max(0, Math.floor(Number(counts.rejects) || 0));
  const oks = Math.max(0, Math.floor(Number(counts.oks) || 0));
  const late = Math.max(0, Math.floor(Number(counts.late) || 0));
  const onTime = Math.max(0, Math.floor(Number(counts.onTime) || 0));

  const submitTotal = rejects + oks;
  const deliveryTotal = late + onTime;
  if (submitTotal + deliveryTotal === 0) return DEFAULT_RELIABILITY_SCORE;

  const rejectRate = submitTotal > 0 ? rejects / submitTotal : 0;
  const lateRate = deliveryTotal > 0 ? late / deliveryTotal : 0;
  // Отказы весят сильнее опозданий.
  const score = 1 - 0.7 * rejectRate - 0.3 * lateRate;
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

/**
 * Цена для сортировки с учётом надёжности.
 * @param {number|null|undefined} price
 * @param {number|null|undefined} reliability 0..1
 * @param {number} [penaltyRub]
 */
export function effectiveProcurementPrice(price, reliability, penaltyRub = DEFAULT_RELIABILITY_PENALTY_RUB) {
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) return Infinity;
  const rel =
    reliability != null && Number.isFinite(Number(reliability))
      ? Math.max(0, Math.min(1, Number(reliability)))
      : DEFAULT_RELIABILITY_SCORE;
  const penalty = Math.max(0, Number(penaltyRub) || 0) * (1 - rel);
  return Math.round((p + penalty) * 100) / 100;
}

export function reliabilityWindowDays() {
  return WINDOW_DAYS;
}

/**
 * Свести сырые event_type → счётчики.
 * @param {Array<{ event_type?: string }>} rows
 */
export function countsFromReliabilityEvents(rows) {
  let rejects = 0;
  let oks = 0;
  let late = 0;
  let onTime = 0;
  for (const row of rows || []) {
    const t = String(row?.event_type || '');
    if (t === 'submit_reject' || t === 'submit_partial') rejects += 1;
    else if (t === 'submit_ok') oks += 1;
    else if (t === 'late_delivery') late += 1;
    else if (t === 'on_time_delivery') onTime += 1;
  }
  return { rejects, oks, late, onTime };
}

/**
 * Классификация ответа API отправки → тип события надёжности (или null = не писать).
 * @param {object|null|undefined} supplierSubmit
 * @returns {'submit_ok'|'submit_partial'|'submit_reject'|null}
 */
export function reliabilityEventTypeFromSubmit(supplierSubmit) {
  if (!supplierSubmit || typeof supplierSubmit !== 'object') return null;
  if (supplierSubmit.skipped) return null;
  if (supplierSubmit.reason === 'already_submitted') return null;
  if (supplierSubmit.reason === 'submit_in_progress') return null;
  if (supplierSubmit.reason === 'submit_disabled') return null;
  if (supplierSubmit.reason === 'supplier_api_not_configured') return null;
  if (supplierSubmit.reason === 'invalid_args') return null;
  if (supplierSubmit.reason === 'purchase_not_found') return null;
  if (supplierSubmit.reason === 'no_lines') return null;
  if (supplierSubmit.reason === 'claim_failed') return null;
  // Таймаут после возможного успеха — не штрафуем как отказ.
  if (supplierSubmit.ambiguousSuccess || supplierSubmit.reason === 'ambiguous_assumed_submitted') {
    return null;
  }

  const accepted =
    Array.isArray(supplierSubmit.lines) && supplierSubmit.lines.length > 0;
  const failed =
    Array.isArray(supplierSubmit.failedLines) && supplierSubmit.failedLines.length > 0;
  const submitted = supplierSubmit.submitted === true || accepted;

  if (submitted && failed) return 'submit_partial';
  if (submitted && supplierSubmit.partial) return 'submit_partial';
  if (submitted) return 'submit_ok';
  if (supplierSubmit.submitted === false || supplierSubmit.reason) return 'submit_reject';
  return null;
}
