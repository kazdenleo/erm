/**
 * Разбор сумм операций Ozon Finance API (transaction list).
 * Имена services — латиница (MarketplaceServiceItemDirectFlowLogistic и т.д.).
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function categorizeOzonServiceName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('commission') || n.includes('комисси') || n.includes('вознагражден')) {
    return 'commission';
  }
  if (n.includes('storage') || n.includes('хранен')) {
    return 'storage';
  }
  if (
    n.includes('logistic') ||
    n.includes('delivery') ||
    n.includes('dropoff') ||
    n.includes('handover') ||
    n.includes('lastmile') ||
    n.includes('sorting') ||
    n.includes('redistribution') ||
    n.includes('return') ||
    n.includes('логист') ||
    n.includes('доставк')
  ) {
    return 'logistics';
  }
  if (n.includes('package') || n.includes('materials')) {
    return 'other';
  }
  return 'other';
}

export function categorizeOzonOperationKind(operationType) {
  const t = String(operationType || '').toLowerCase();
  if (t.includes('deliveredtocustomer')) return 'sale';
  if (t.includes('commission')) return 'commission';
  if (t.includes('defectfine') || (t.includes('fine') && !t.includes('cancelled'))) return 'penalty';
  if (t.includes('return')) return 'return';
  if (t.includes('storage')) return 'storage';
  return 'other';
}

/** @param {object} op — строка Ozon Finance API или raw_json из БД */
export function extractOzonFinanceAmounts(op) {
  const operationType = op?.operation_type ?? op?.type ?? null;
  const kind = categorizeOzonOperationKind(operationType);
  const amount = toNum(op?.amount);

  const amounts = {
    retail_amount: 0,
    commission_amount: 0,
    logistics_amount: 0,
    storage_amount: 0,
    penalty_amount: 0,
    acquiring_amount: 0,
    other_deductions: 0,
    payout_amount: amount,
  };

  const services = Array.isArray(op?.services) ? op.services : [];
  if (services.length) {
    for (const s of services) {
      const n = Math.abs(toNum(s?.price));
      const cat = categorizeOzonServiceName(s?.name);
      if (cat === 'commission') amounts.commission_amount += n;
      else if (cat === 'logistics') amounts.logistics_amount += n;
      else if (cat === 'storage') amounts.storage_amount += n;
      else amounts.other_deductions += n;
    }
  } else {
    const abs = Math.abs(amount);
    if (kind === 'penalty') amounts.penalty_amount = abs;
    else if (kind === 'commission') amounts.commission_amount = abs;
    else if (kind === 'storage') amounts.storage_amount = abs;
    else if (kind === 'return') amounts.logistics_amount = abs;
    else if (kind !== 'sale') amounts.other_deductions = abs;
  }

  if (kind === 'sale') {
    const accruals = toNum(op?.accruals_for_sale);
    const saleCommission = Math.abs(toNum(op?.sale_commission));
    if (accruals > 0) {
      amounts.retail_amount = accruals;
    } else if (amount > 0) {
      amounts.retail_amount = amount;
    }
    if (saleCommission > 0) {
      amounts.commission_amount += saleCommission;
    }
  }

  return amounts;
}
