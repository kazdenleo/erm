function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function normalizePlanDays(v) {
  const n = toInt(v);
  if (n === 60 || n === 90) return n;
  return 30;
}

function normalizeOrdersDays(v) {
  const n = toInt(v);
  if (n >= 1 && n <= 366) return n;
  return 30;
}

function normalizeZeroStockBoostPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(200, Math.max(0, Math.round(n)));
}

export function calcAvgOrdersPerDay(orders, ordersDays) {
  const d = Math.max(1, normalizeOrdersDays(ordersDays));
  const o = toInt(orders);
  if (o <= 0) return 0;
  return Math.round((o / d) * 100) / 100;
}

function applyZeroStockBoost(toSupply, availability, boostPercent) {
  const boost = normalizeZeroStockBoostPercent(boostPercent);
  if (boost <= 0 || toInt(availability) !== 0) return toInt(toSupply);
  const base = toInt(toSupply);
  if (base <= 0) return 0;
  return Math.ceil(base * (1 + boost / 100));
}

export function calcClusterToSupply({
  availability,
  orders,
  planDays = 30,
  ordersDays = 30,
  zeroStockBoostPercent = 0,
}) {
  const avg = calcAvgOrdersPerDay(orders, ordersDays);
  const forecastQty = avg * normalizePlanDays(planDays);
  let toSupply = forecastQty - toInt(availability);
  if (toInt(availability) === 0) {
    toSupply = applyZeroStockBoost(Math.max(0, toSupply), 0, zeroStockBoostPercent);
  } else {
    toSupply = Math.max(0, Math.ceil(toSupply));
  }
  return toSupply;
}

export function applyForecastSettings(rows, { planDays, ordersDays, zeroStockBoostPercent }) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  return rows.map((row) => {
    const clusterMetrics = {};
    let rowSupply = 0;
    let rowOrders = 0;

    for (const [clusterKey, metrics] of Object.entries(row.clusterMetrics || {})) {
      const orders = toInt(metrics?.orders);
      const availability = toInt(metrics?.availability);
      const toSupply = calcClusterToSupply({
        availability,
        orders,
        planDays,
        ordersDays,
        zeroStockBoostPercent,
      });
      clusterMetrics[clusterKey] = {
        ...metrics,
        orders,
        availability,
        avgOrdersPerDay: calcAvgOrdersPerDay(orders, ordersDays),
        toSupply,
      };
      rowSupply += toSupply;
      rowOrders += orders;
    }

    return {
      ...row,
      clusterMetrics,
      toSupply: rowSupply,
      ordersCount: rowOrders,
    };
  });
}

export function sumClusterSupplyTotals(rows, clusterKeys = null) {
  const totals = {};
  const keys = clusterKeys ? new Set(clusterKeys) : null;

  for (const row of rows || []) {
    for (const [clusterKey, metrics] of Object.entries(row.clusterMetrics || {})) {
      if (keys && !keys.has(clusterKey)) continue;
      totals[clusterKey] = (totals[clusterKey] || 0) + toInt(metrics?.toSupply);
    }
  }
  return totals;
}
