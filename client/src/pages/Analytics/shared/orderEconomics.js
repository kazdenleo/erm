/**
 * Факт по заказу: цена продажи, затраты, сколько пришло от МП.
 */

export function mpFeesFromRow(row) {
  if (!row) return 0;
  if (row.expensesTotal != null && Number.isFinite(Number(row.expensesTotal))) {
    return Number(row.expensesTotal) || 0;
  }
  return (
    (Number(row.commissionAmount) || 0) +
    (Number(row.logisticsAmount) || 0) +
    (Number(row.storageAmount) || 0) +
    (Number(row.penaltyAmount) || 0) +
    (Number(row.acquiringAmount) || 0) +
    (Number(row.otherDeductions) || 0)
  );
}

export function isWbMarketplace(mp) {
  const v = String(mp || '').toLowerCase();
  return v === 'wb' || v === 'wildberries';
}

export function marketplaceRevenueAmount(row) {
  if (!row) return 0;
  const received = Number(row.receivedAmount ?? row.payoutAmount) || 0;
  const costAmount = Number(row.costAmount) || 0;
  const additionalExpensesAmount = Number(row.additionalExpensesAmount) || 0;
  const wbLogistics =
    Number(row.wbLogisticsAmount) ||
    (isWbMarketplace(row.marketplace) ? Number(row.logisticsAmount) || 0 : 0);
  return received - costAmount - additionalExpensesAmount - wbLogistics;
}

export function orderEconomicsFromRow(row) {
  if (!row) {
    return {
      saleAmount: 0,
      costAmount: 0,
      additionalExpensesAmount: 0,
      mpFees: 0,
      costsTotal: 0,
      receivedAmount: 0,
      revenueAmount: 0,
    };
  }
  const costAmount = Number(row.costAmount) || 0;
  const additionalExpensesAmount = Number(row.additionalExpensesAmount) || 0;
  const mpFees = mpFeesFromRow(row);
  const receivedAmount = Number(row.receivedAmount ?? row.payoutAmount) || 0;
  return {
    saleAmount: Number(row.saleAmount ?? row.retailAmount) || 0,
    costAmount,
    additionalExpensesAmount,
    mpFees,
    costsTotal: Number(row.costsTotal) || mpFees,
    receivedAmount,
    revenueAmount: marketplaceRevenueAmount({ ...row, receivedAmount, costAmount, additionalExpensesAmount }),
  };
}

export function formatRub(n) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatQty(n) {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}
