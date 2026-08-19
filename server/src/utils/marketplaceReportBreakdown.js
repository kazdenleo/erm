/**
 * Детализация сумм для подсказок в аналитике FBS/FBO.
 */

import { categorizeOzonServiceName } from './ozonFinanceReportAmounts.js';
import { categorizeYmServiceName } from './ymFinanceReportAmounts.js';

const OZON_SERVICE_LABELS = {
  MarketplaceServiceItemDirectFlowLogistic: 'Логистика (прямой поток)',
  MarketplaceServiceItemDropoffSC: 'Обработка / сдача на СЦ',
  MarketplaceServiceItemDeliveryToHandoverPlaceOzon: 'Доставка до места передачи',
  MarketplaceServiceItemRedistributionLastMileCourier: 'Последняя миля (курьер)',
  MarketplaceServiceBrandCommission: 'Продвижение бренда',
};

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pushPart(bucket, label, amount) {
  const n = Math.abs(toNum(amount));
  if (n <= 0) return;
  const existing = bucket.find((x) => x.label === label);
  if (existing) existing.amount += n;
  else bucket.push({ label, amount: n });
}

function mergeBuckets(partsList) {
  const out = {
    retail: [],
    commission: [],
    logistics: [],
    storage: [],
    penalty: [],
    acquiring: [],
    other: [],
  };
  for (const parts of partsList) {
    if (!parts) continue;
    for (const key of Object.keys(out)) {
      for (const item of parts[key] || []) {
        pushPart(out[key], item.label, item.amount);
      }
    }
  }
  return out;
}

function sumBucket(bucket) {
  return (bucket || []).reduce((s, x) => s + toNum(x.amount), 0);
}

export function buildOzonLineBreakdown(line) {
  const raw = line?.raw_json || line?.rawJson || {};
  const op = String(line?.operation_type || raw?.operation_type || '');
  const opLabel = String(raw?.operation_type_name || op);
  const parts = {
    retail: [],
    commission: [],
    logistics: [],
    storage: [],
    penalty: [],
    acquiring: [],
    other: [],
  };

  if (op === 'OperationAgentDeliveredToCustomer') {
    pushPart(parts.retail, 'Начисления за продажу (accruals_for_sale)', raw?.accruals_for_sale ?? line?.retail_amount);
    pushPart(parts.commission, 'Комиссия Ozon (sale_commission)', raw?.sale_commission);
    for (const s of raw?.services || []) {
      const label = OZON_SERVICE_LABELS[s?.name] || s?.name || 'Услуга Ozon';
      const cat = categorizeOzonServiceName(s?.name);
      const bucket =
        cat === 'commission'
          ? parts.commission
          : cat === 'logistics'
            ? parts.logistics
            : cat === 'storage'
              ? parts.storage
              : parts.other;
      pushPart(bucket, label, s?.price);
    }
  } else if (op === 'MarketplaceServiceBrandCommission') {
    pushPart(parts.commission, 'Продвижение бренда', line?.commission_amount || raw?.amount);
  } else if (op.startsWith('DefectFine') || op.includes('Fine')) {
    pushPart(parts.penalty, opLabel, line?.penalty_amount || raw?.amount);
  } else if (op.includes('Return')) {
    pushPart(parts.logistics, opLabel, line?.logistics_amount || line?.other_deductions || raw?.amount);
  } else if (op.includes('Package')) {
    pushPart(parts.other, opLabel, line?.other_deductions || raw?.amount);
  } else {
    if (toNum(line?.commission_amount) > 0) pushPart(parts.commission, opLabel, line.commission_amount);
    if (toNum(line?.logistics_amount) > 0) pushPart(parts.logistics, opLabel, line.logistics_amount);
    if (toNum(line?.storage_amount) > 0) pushPart(parts.storage, opLabel, line.storage_amount);
    if (toNum(line?.penalty_amount) > 0) pushPart(parts.penalty, opLabel, line.penalty_amount);
    if (toNum(line?.acquiring_amount) > 0) pushPart(parts.acquiring, opLabel, line.acquiring_amount);
    if (toNum(line?.other_deductions) > 0) pushPart(parts.other, opLabel, line.other_deductions);
  }

  return parts;
}

export function buildWbLineBreakdown(line) {
  const raw = line?.raw_json || line?.rawJson || {};
  const op = String(line?.operation_type || raw?.supplier_oper_name || '');
  const parts = {
    retail: [],
    commission: [],
    logistics: [],
    storage: [],
    penalty: [],
    acquiring: [],
    other: [],
  };

  if (op === 'Продажа') {
    pushPart(parts.retail, 'Цена для комиссии WB (retail_price)', line?.retail_amount ?? raw?.retail_price);
    if (toNum(raw?.retail_amount) > 0 && toNum(raw?.retail_amount) !== toNum(line?.retail_amount ?? raw?.retail_price)) {
      pushPart(parts.retail, 'Оплата покупателя (retail_amount)', raw.retail_amount);
    }
    const pct = toNum(raw?.commission_percent);
    if (pct > 0) {
      pushPart(parts.commission, `Комиссия WB ${pct}%`, line?.commission_amount);
    } else {
      pushPart(parts.commission, 'Комиссия WB (ppvz_sales_commission)', line?.commission_amount ?? raw?.ppvz_sales_commission);
    }
    if (toNum(raw?.acquiring_fee) > 0) pushPart(parts.acquiring, 'Эквайринг', raw.acquiring_fee);
  } else if (op === 'Логистика') {
    pushPart(parts.logistics, 'Логистика (delivery_rub)', line?.logistics_amount ?? raw?.delivery_rub);
  } else if (op === 'Обработка товара') {
    pushPart(parts.logistics, 'Приёмка на складе (acceptance)', line?.logistics_amount ?? raw?.acceptance);
  } else if (op.includes('Возмещение') && op.includes('перевозк')) {
    pushPart(parts.logistics, 'Возмещение издержек (rebill_logistic_cost)', line?.logistics_amount ?? raw?.rebill_logistic_cost);
  } else if (op.includes('ПВЗ')) {
    pushPart(parts.logistics, 'Выдача/возврат ПВЗ (ppvz_reward)', line?.logistics_amount ?? raw?.ppvz_reward);
  } else if (op === 'Штраф') {
    pushPart(parts.penalty, 'Штраф WB', line?.penalty_amount ?? raw?.penalty);
  } else if (op === 'Возврат') {
    pushPart(parts.retail, 'Возврат', line?.retail_amount);
    pushPart(parts.commission, 'Комиссия по возврату', line?.commission_amount);
  } else {
    if (toNum(line?.commission_amount) > 0) pushPart(parts.commission, op, line.commission_amount);
    if (toNum(line?.logistics_amount) > 0) pushPart(parts.logistics, op, line.logistics_amount);
    if (toNum(line?.penalty_amount) > 0) pushPart(parts.penalty, op, line.penalty_amount);
    if (toNum(line?.other_deductions) > 0) pushPart(parts.other, op, line.other_deductions);
  }

  return parts;
}

function ymBreakdownLabel(raw, serviceName, opLabel, { preferSource = false } = {}) {
  const src = String(raw?.transactionSource || raw?.TRANSACTION_SOURCE || '').trim();
  const name = String(serviceName || '').trim();
  if (preferSource && src) return src;
  const cat = name ? categorizeYmServiceName(name) : 'other';
  if (name && cat !== 'other') return name;
  if (src) return src;
  return name || opLabel || 'Удержание Яндекса';
}

export function buildYmLineBreakdown(line) {
  const raw = line?.raw_json || line?.rawJson || {};
  const src = String(raw?.transactionSource || raw?.TRANSACTION_SOURCE || '');
  const srcLc = src.toLowerCase();
  const typ = String(raw?.transactionType || raw?.TRANSACTION_TYPE || '');
  const typLc = typ.toLowerCase();
  const serviceName = String(raw?.offerOrServiceName || raw?.OFFER_OR_SERVICE_NAME || '').trim();
  const opLabel = [typ, src].filter(Boolean).join(' / ') || line?.operation_type;
  const parts = {
    retail: [],
    commission: [],
    logistics: [],
    storage: [],
    penalty: [],
    acquiring: [],
    other: [],
  };

  if (srcLc.includes('плат') && srcLc.includes('покупател')) {
    pushPart(parts.retail, 'Платёж покупателя', line?.retail_amount ?? raw?.transactionSum);
  } else if (srcLc.includes('баллы') && (typLc.includes('начисл') || toNum(raw?.transactionSum) > 0)) {
    pushPart(
      parts.retail,
      src || 'Баллы за скидку Маркета',
      line?.retail_amount ?? raw?.transactionSum
    );
  } else if (srcLc.includes('услуг') && (srcLc.includes('яндекс') || srcLc.includes('маркет'))) {
    const label = ymBreakdownLabel(raw, serviceName, opLabel);
    const cat = categorizeYmServiceName(serviceName);
    const bucket =
      cat === 'commission'
        ? parts.commission
        : cat === 'logistics'
          ? parts.logistics
          : cat === 'storage'
            ? parts.storage
            : cat === 'acquiring'
              ? parts.acquiring
              : cat === 'penalty'
                ? parts.penalty
                : parts.other;
    pushPart(bucket, label, Math.abs(toNum(raw?.transactionSum ?? line?.payout_amount)));
  } else if (srcLc.includes('скидк') || srcLc.includes('баллы')) {
    pushPart(
      parts.other,
      ymBreakdownLabel(raw, serviceName, opLabel, { preferSource: true }),
      line?.other_deductions ?? raw?.transactionSum
    );
  } else {
    if (toNum(line?.commission_amount) > 0) pushPart(parts.commission, opLabel, line.commission_amount);
    if (toNum(line?.logistics_amount) > 0) pushPart(parts.logistics, opLabel, line.logistics_amount);
    if (toNum(line?.acquiring_amount) > 0) pushPart(parts.acquiring, opLabel, line.acquiring_amount);
    if (toNum(line?.penalty_amount) > 0) pushPart(parts.penalty, opLabel, line.penalty_amount);
    if (toNum(line?.other_deductions) > 0) {
      pushPart(parts.other, ymBreakdownLabel(raw, serviceName, opLabel), line.other_deductions);
    }
  }

  return parts;
}

export function buildLineBreakdown(line) {
  const mp = String(line?.marketplace || '').toLowerCase();
  if (mp === 'ozon') return buildOzonLineBreakdown(line);
  if (mp === 'wb' || mp === 'wildberries') return buildWbLineBreakdown(line);
  if (mp === 'ym' || mp === 'yandex' || mp === 'yandexmarket') return buildYmLineBreakdown(line);
  return {
    retail: [],
    commission: [],
    logistics: [],
    storage: [],
    penalty: [],
    acquiring: [],
    other: [],
  };
}

export function buildOrderBreakdownFromLines(lines) {
  const merged = mergeBuckets((lines || []).map((l) => buildLineBreakdown(l)));
  return {
    ...merged,
    totals: {
      retail: sumBucket(merged.retail),
      commission: sumBucket(merged.commission),
      logistics: sumBucket(merged.logistics),
      storage: sumBucket(merged.storage),
      penalty: sumBucket(merged.penalty),
      acquiring: sumBucket(merged.acquiring),
      other: sumBucket(merged.other),
      otherCombined: sumBucket(merged.penalty) + sumBucket(merged.acquiring) + sumBucket(merged.other),
    },
  };
}

export function formatBreakdownTooltip(title, items, total = null) {
  if (!items?.length) return null;
  const lines = items.map((x) => `• ${x.label}: ${formatRubShort(x.amount)}`);
  if (total != null && items.length > 1) {
    lines.push(`—\nИтого: ${formatRubShort(total)}`);
  }
  return `${title}\n${lines.join('\n')}`;
}

function formatRubShort(n) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(toNum(n));
}

export function buildAmountTooltips(breakdown) {
  if (!breakdown) return {};
  const t = breakdown.totals || {};
  return {
    retail: formatBreakdownTooltip('Выручка', breakdown.retail, t.retail),
    commission: formatBreakdownTooltip('Комиссия', breakdown.commission, t.commission),
    logistics: formatBreakdownTooltip('Логистика и обработка', breakdown.logistics, t.logistics),
    storage: formatBreakdownTooltip('Хранение', breakdown.storage, t.storage),
    other: formatBreakdownTooltip(
      'Прочие удержания',
      [...(breakdown.penalty || []), ...(breakdown.acquiring || []), ...(breakdown.other || [])],
      t.otherCombined
    ),
  };
}
