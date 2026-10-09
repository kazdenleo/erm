/**
 * Отчёт о привязке товаров к сертификату на маркетплейсах:
 * какие товары ERP ожидаются, какие реально привязаны и почему остальные — нет.
 */

import { certificateNumberKey } from './certificateImportMap.js';

const MISSING_SAMPLE = 200;

export const OZON_PRODUCT_STATUS_LABELS = {
  approved: 'одобрен',
  awaiting_verification: 'на проверке',
  verification: 'на проверке',
  background_check: 'фоновая проверка',
  declined: 'отклонён',
};

/**
 * @param {object} p
 * @param {Array<{ sku?: string, ozonProductId: number }>} p.expected товары ERP с product_id Ozon
 * @param {Array<{ product_id: number, product_status_code?: string }>} p.bound привязанные на Ozon
 * @param {Map<number, { certificateId: number, number: string }>} [p.heldBy] к какому сертификату привязан товар
 */
export function summarizeOzonBinding({ expected = [], bound = [], heldBy = new Map() }) {
  const boundById = new Map(bound.map((it) => [Number(it.product_id), it]));
  const statuses = {};
  let boundExpected = 0;
  const declined = [];
  const missing = [];
  for (const item of expected) {
    const id = Number(item.ozonProductId);
    const hit = boundById.get(id);
    if (hit) {
      boundExpected += 1;
      const code = String(hit.product_status_code || 'unknown');
      statuses[code] = (statuses[code] || 0) + 1;
      if (code === 'declined') declined.push({ sku: item.sku || null, ozon_product_id: id });
      continue;
    }
    const holder = heldBy.get(id);
    missing.push({
      sku: item.sku || null,
      ozon_product_id: id,
      held_by_certificate_id: holder?.certificateId ?? null,
      reason: holder
        ? `привязан к другому сертификату на Ozon: ${holder.number || `ID ${holder.certificateId}`}`
        : 'Ozon не привязал товар',
    });
  }
  return {
    marketplace: 'ozon',
    expected: expected.length,
    bound: boundExpected,
    bound_total: bound.length,
    statuses,
    declined: declined.slice(0, MISSING_SAMPLE),
    missing: missing.slice(0, MISSING_SAMPLE),
    missing_count: missing.length,
    held_by_other_count: missing.filter((m) => m.held_by_certificate_id).length,
  };
}

/**
 * @param {object} p
 * @param {Array<{ sku?: string, offerId: string }>} p.expected
 * @param {Map<string, string[]>} p.certificatesByOffer номера документов у офферов, найденных на Маркете
 * @param {string} p.number номер нашего документа
 * @param {Map<string, string>} [p.offerErrors] ошибки Маркета по офферам при последней привязке
 */
export function summarizeYmBinding({ expected = [], certificatesByOffer = new Map(), number, offerErrors = new Map() }) {
  const key = certificateNumberKey(number);
  let bound = 0;
  const missing = [];
  for (const item of expected) {
    const offerId = String(item.offerId);
    const certs = certificatesByOffer.get(offerId);
    if (certs && certs.some((n) => certificateNumberKey(n) === key)) {
      bound += 1;
      continue;
    }
    const err = offerErrors.get(offerId);
    missing.push({
      sku: item.sku || null,
      offer_id: offerId,
      reason: err
        ? `Маркет отклонил: ${err}`
        : certs
          ? 'документ не привязан к офферу'
          : 'оффера нет на Маркете',
    });
  }
  return {
    marketplace: 'ym',
    expected: expected.length,
    bound,
    missing: missing.slice(0, MISSING_SAMPLE),
    missing_count: missing.length,
    not_on_marketplace_count: missing.filter((m) => m.reason === 'оффера нет на Маркете').length,
  };
}

/** Ошибки offer-mappings/update по офферам: Map(offerId → текст). Предупреждения не считаем. */
export function ymOfferMappingErrors(data) {
  const out = new Map();
  const results = data?.results ?? data?.result?.results ?? [];
  for (const r of Array.isArray(results) ? results : []) {
    const offerId = String(r?.offerId || '').trim();
    const errs = Array.isArray(r?.errors) ? r.errors : [];
    if (!offerId || !errs.length) continue;
    out.set(offerId, errs.map((e) => e?.message || e?.type).filter(Boolean).join('; ') || 'ошибка');
  }
  return out;
}
