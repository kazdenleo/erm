/**
 * ABC-классификация товаров (пороги 80% / 15% / 5%).
 * Метрики: soldAmount (выручка), netIncome (прибыль), soldQty (штуки).
 */

export const ABC_METRICS = [
  { value: 'soldAmount', label: 'Выручка', field: 'soldAmount' },
  { value: 'netIncome', label: 'Прибыль', field: 'netIncome' },
  { value: 'soldQty', label: 'Штуки', field: 'soldQty' },
];

export const ABC_THRESHOLDS = { A: 0.8, B: 0.95 };

/**
 * @param {Array<object>} products
 * @param {'soldAmount'|'netIncome'|'soldQty'} metric
 * @returns {{ items: Array, groups: { A: object, B: object, C: object }, totalMetric: number }}
 */
export function classifyAbc(products, metric = 'soldAmount') {
  const meta = ABC_METRICS.find((m) => m.value === metric) || ABC_METRICS[0];
  const field = meta.field;
  const rows = (Array.isArray(products) ? products : []).map((p) => ({
    ...p,
    metricValue: Number(p[field]) || 0,
  }));

  rows.sort((a, b) => b.metricValue - a.metricValue);

  const totalMetric = rows.reduce((s, r) => s + Math.max(0, r.metricValue), 0);
  let cum = 0;

  for (const row of rows) {
    const contrib = Math.max(0, row.metricValue);
    const prevShare = totalMetric > 0 ? cum / totalMetric : 1;
    cum += contrib;
    const cumulativeShare = totalMetric > 0 ? cum / totalMetric : 1;
    row.share = totalMetric > 0 ? contrib / totalMetric : 0;
    row.cumulativeShare = cumulativeShare;

    if (totalMetric <= 0 || contrib === 0) {
      row.abcClass = 'C';
    } else if (prevShare < ABC_THRESHOLDS.A) {
      row.abcClass = 'A';
    } else if (prevShare < ABC_THRESHOLDS.B) {
      row.abcClass = 'B';
    } else {
      row.abcClass = 'C';
    }
  }

  const makeGroup = (cls) => {
    const items = rows.filter((r) => r.abcClass === cls);
    const metricSum = items.reduce((s, r) => s + Math.max(0, r.metricValue), 0);
    return {
      abcClass: cls,
      productsCount: items.length,
      metricSum,
      share: totalMetric > 0 ? metricSum / totalMetric : 0,
      soldQty: items.reduce((s, r) => s + (Number(r.soldQty) || 0), 0),
      soldAmount: items.reduce((s, r) => s + (Number(r.soldAmount) || 0), 0),
      netIncome: items.reduce((s, r) => s + (Number(r.netIncome) || 0), 0),
    };
  };

  return {
    items: rows,
    groups: {
      A: makeGroup('A'),
      B: makeGroup('B'),
      C: makeGroup('C'),
    },
    totalMetric,
  };
}
