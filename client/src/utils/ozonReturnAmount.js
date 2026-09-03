/**
 * Ozon: база для «Обратной логистики» — средняя логистика (мин + макс) / 2 × доля невыкупа.
 */

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ozonRawCommissions(calculator) {
  return calculator?.fullCommissions || calculator?.rawCommissions || {};
}

function readRawLogisticsMin(calculator, scheme) {
  const raw = ozonRawCommissions(calculator);
  if (scheme === 'FBO') {
    return numOrNull(raw.fbo_direct_flow_trans_min_amount);
  }
  return numOrNull(raw.fbs_direct_flow_trans_min_amount);
}

function readRawLogisticsMax(calculator, scheme) {
  const raw = ozonRawCommissions(calculator);
  if (scheme === 'FBO') {
    return numOrNull(raw.fbo_direct_flow_trans_max_amount);
  }
  return numOrNull(raw.fbs_direct_flow_trans_max_amount);
}

export function resolveOzonLogisticsCostsForReturn(calculator, commission, priceScheme) {
  const scheme = String(priceScheme || '').toUpperCase();
  let logisticsCost = 0;
  let logisticsCostMax = null;

  if (scheme === 'FBO') {
    logisticsCost =
      numOrNull(commission?.direct_flow_trans_amount) ??
      numOrNull(calculator?.logistics_cost_fbo) ??
      readRawLogisticsMin(calculator, 'FBO') ??
      0;
    logisticsCostMax =
      numOrNull(commission?.direct_flow_trans_amount_max) ??
      numOrNull(calculator?.logistics_cost_fbo_max) ??
      readRawLogisticsMax(calculator, 'FBO');
  } else {
    logisticsCost =
      numOrNull(calculator?.logistics_cost) ??
      numOrNull(commission?.direct_flow_trans_amount) ??
      readRawLogisticsMin(calculator, 'FBS') ??
      0;
    logisticsCostMax =
      numOrNull(commission?.direct_flow_trans_amount_max) ??
      numOrNull(calculator?.logistics_cost_max) ??
      readRawLogisticsMax(calculator, 'FBS');
  }

  if (logisticsCost > 0) logisticsCost = Math.round(logisticsCost);
  if (logisticsCostMax != null && logisticsCostMax > 0) logisticsCostMax = Math.round(logisticsCostMax);
  if (logisticsCostMax != null && logisticsCostMax <= logisticsCost) logisticsCostMax = null;

  return { logisticsCost, logisticsCostMax };
}

/** @returns {{ unitAmount: number, logisticsMin: number, logisticsMax: number|null }} */
export function computeOzonReturnUnitAmount(logisticsMin, logisticsMax, returnAmountAtMax) {
  const min = Number(logisticsMin) || 0;
  const max = numOrNull(logisticsMax);
  const atMax = Number(returnAmountAtMax);

  if (max != null && min > 0 && max > min) {
    const unitAmount = Math.round(((min + max) / 2) * 100) / 100;
    return { unitAmount, logisticsMin: min, logisticsMax: max };
  }

  const fallback = Number.isFinite(atMax) && atMax > 0 ? atMax : min > 0 ? min : 0;
  return { unitAmount: fallback, logisticsMin: min, logisticsMax: max };
}

/** @deprecated используйте computeOzonReturnUnitAmount */
export function scaleOzonReturnAmountByLogistics(returnAmountAtMax, logisticsCost, logisticsCostMax) {
  const r = computeOzonReturnUnitAmount(logisticsCost, logisticsCostMax, returnAmountAtMax);
  return {
    scaled: r.unitAmount,
    atMax: Number(returnAmountAtMax) || 0,
    logisticsCost: r.logisticsMin,
    logisticsCostMax: r.logisticsMax,
  };
}

export function resolveOzonReturnUnitAmount(returnAmountAtMax, calculator, commission, priceScheme) {
  const { logisticsCost, logisticsCostMax } = resolveOzonLogisticsCostsForReturn(
    calculator,
    commission,
    priceScheme
  );
  return computeOzonReturnUnitAmount(logisticsCost, logisticsCostMax, returnAmountAtMax).unitAmount;
}
