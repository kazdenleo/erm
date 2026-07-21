/**
 * Разбор сумм строк united-netting отчёта Яндекс.Маркета.
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function categorizeYmServiceName(name) {
  const n = String(name || '').toLowerCase();
  if (
    n.includes('размещен') ||
    n.includes('комисс') ||
    n.includes('вознагражден') ||
    n.includes('биллинг')
  ) {
    return 'commission';
  }
  if (
    n.includes('доставк') ||
    n.includes('логист') ||
    n.includes('отгрузк') ||
    n.includes('сортиров') ||
    n.includes('невыкуп') ||
    n.includes('возврат') && n.includes('достав')
  ) {
    return 'logistics';
  }
  if (n.includes('хранен')) {
    return 'storage';
  }
  if (
    n.includes('приём платеж') ||
    n.includes('прием платеж') ||
    n.includes('перевод платеж') ||
    n.includes('эквайр')
  ) {
    return 'acquiring';
  }
  if (n.includes('штраф') || n.includes('не вовремя')) {
    return 'penalty';
  }
  if (n.includes('скидк') || n.includes('лояльност') || n.includes('балл') || n.includes('акци')) {
    return 'other';
  }
  return 'other';
}

/** @param {object} row — строка XLSX / raw_json */
export function extractYmFinanceAmounts(row) {
  const sum = toNum(row?.transactionSum ?? row?.TRANSACTION_SUM);
  const abs = Math.abs(sum);
  const src = String(row?.transactionSource ?? row?.TRANSACTION_SOURCE ?? '').toLowerCase();
  const type = String(row?.transactionType ?? row?.TRANSACTION_TYPE ?? '').toLowerCase();
  const serviceName = String(row?.offerOrServiceName ?? row?.OFFER_OR_SERVICE_NAME ?? '').trim();

  const amounts = {
    retail_amount: 0,
    commission_amount: 0,
    logistics_amount: 0,
    storage_amount: 0,
    penalty_amount: 0,
    acquiring_amount: 0,
    other_deductions: 0,
    payout_amount: sum,
  };

  if (src.includes('плат') && src.includes('покупател')) {
    amounts.retail_amount = abs;
    return amounts;
  }
  if (src.includes('возврат') && src.includes('плат') && src.includes('покупател')) {
    amounts.retail_amount = abs;
    return amounts;
  }
  if (src.includes('премия') || (src.includes('продаж') && sum > 0)) {
    amounts.retail_amount = abs;
    return amounts;
  }
  if (src.includes('баллы') || src.includes('скидк')) {
    amounts.other_deductions = abs;
    return amounts;
  }
  if (src.includes('услуг') && (src.includes('яндекс') || src.includes('маркет'))) {
    const cat = categorizeYmServiceName(serviceName);
    if (cat === 'commission') amounts.commission_amount = abs;
    else if (cat === 'logistics') amounts.logistics_amount = abs;
    else if (cat === 'storage') amounts.storage_amount = abs;
    else if (cat === 'acquiring') amounts.acquiring_amount = abs;
    else if (cat === 'penalty') amounts.penalty_amount = abs;
    else amounts.other_deductions = abs;
    return amounts;
  }
  if (src.includes('вознагражден') || src.includes('комисс')) {
    amounts.commission_amount = abs;
    return amounts;
  }
  if (src.includes('доставк') || src.includes('логист') || src.includes('сортиров')) {
    amounts.logistics_amount = abs;
    return amounts;
  }
  if (src.includes('хранен')) {
    amounts.storage_amount = abs;
    return amounts;
  }
  if (src.includes('штраф') || src.includes('претенз')) {
    amounts.penalty_amount = abs;
    return amounts;
  }
  if (src.includes('эквайр') || src.includes('платеж')) {
    amounts.acquiring_amount = abs;
    return amounts;
  }

  if (sum < 0 || type.includes('удерж') || type.includes('списан')) {
    amounts.other_deductions = abs;
  } else if (sum > 0) {
    amounts.retail_amount = abs;
  }
  return amounts;
}
