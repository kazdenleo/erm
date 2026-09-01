/**
 * Построение данных для Recharts: товары, МП, сравнение периодов.
 */

const MP_LABELS = {
  ozon: 'Ozon',
  wb: 'Wildberries',
  ym: 'Яндекс',
};

const MP_COLORS = {
  ozon: '#005bff',
  wb: '#cb11ab',
  ym: '#ffcc00',
};

const PERIOD_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea'];

const PRODUCT_COLORS = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#4f46e5',
  '#be185d',
  '#0f766e',
  '#a16207',
];

export function marketplaceLabel(mp) {
  return MP_LABELS[mp] || mp || '—';
}

export function marketplaceColor(mp) {
  return MP_COLORS[mp] || '#64748b';
}

export function periodColor(index) {
  return PERIOD_COLORS[index % PERIOD_COLORS.length];
}

export function productColor(index) {
  return PRODUCT_COLORS[index % PRODUCT_COLORS.length];
}

export function productRowKey(p) {
  const pid = Number(p?.productId) || 0;
  if (pid > 0) return `p:${pid}`;
  return `s:${String(p?.sku || '').trim() || '—'}`;
}

export function productLabel(p) {
  const article = p?.erpSku || p?.sku || '—';
  const name = String(p?.productName || '').trim();
  if (name && name !== '—') return `${article}`;
  return article;
}

/** Серии по выбранным товарам (один период). */
export function buildProductChartData(period, selectedKeys, metric = 'soldAmount') {
  if (!period?.products?.length || !selectedKeys?.length) return { data: [], seriesKeys: [] };

  const selected = period.products.filter((p) => selectedKeys.includes(productRowKey(p)));
  if (!selected.length) return { data: [], seriesKeys: [] };

  const bucketSet = new Set();
  for (const p of selected) {
    for (const b of p.buckets || []) bucketSet.add(b.bucket);
  }
  const buckets = [...bucketSet].sort();

  const seriesKeys = selected.map((p, idx) => {
    const key = productRowKey(p);
    return {
      key,
      label: productLabel(p),
      color: productColor(idx),
    };
  });

  const data = buckets.map((bucket, idx) => {
    const label =
      selected[0]?.buckets?.find((b) => b.bucket === bucket)?.bucketLabel || bucket;
    const row = { index: idx + 1, label, bucket };
    for (const p of selected) {
      const key = productRowKey(p);
      const found = (p.buckets || []).find((b) => b.bucket === bucket);
      row[key] = Number(found?.[metric] ?? 0) || 0;
    }
    return row;
  });

  return { data, seriesKeys };
}

/** Один товар: линии штук и выручки (две оси). */
export function buildSingleProductDualMetricData(product) {
  if (!product?.buckets?.length) return { data: [], seriesKeys: [] };
  const data = product.buckets.map((b, idx) => ({
    index: idx + 1,
    label: b.bucketLabel || b.bucket,
    bucket: b.bucket,
    soldQty: Number(b.soldQty) || 0,
    soldAmount: Number(b.soldAmount) || 0,
  }));
  return {
    data,
    seriesKeys: [
      { key: 'soldAmount', label: 'Выручка', color: '#2563eb', yAxisId: 'amount' },
      { key: 'soldQty', label: 'Штуки', color: '#16a34a', yAxisId: 'qty' },
    ],
  };
}

/** Серии для режима «по маркетплейсам» (один период / один товар). */
export function buildMarketplaceChartData(period, metric = 'soldAmount') {
  if (!period?.buckets?.length) return { data: [], seriesKeys: [] };

  const seriesKeys = (period.marketplaces || []).map((mp) => ({
    key: mp,
    label: marketplaceLabel(mp),
    color: marketplaceColor(mp),
  }));

  const data = period.buckets.map((bucket, idx) => {
    const row = {
      index: idx + 1,
      label: bucket.bucketLabel || bucket.bucket,
      bucket: bucket.bucket,
    };
    for (const mp of period.marketplaces || []) {
      const v = bucket.marketplaces?.[mp]?.[metric] ?? 0;
      row[mp] = Number(v) || 0;
    }
    row.total = bucket[metric] ?? 0;
    return row;
  });

  return { data, seriesKeys };
}

/** Серии для режима «сравнение периодов». */
export function buildCompareChartData(periods, metric = 'soldAmount', marketplace = null) {
  if (!periods?.length) return { data: [], seriesKeys: [] };

  const maxLen = Math.max(...periods.map((p) => p.buckets?.length || 0), 0);
  const seriesKeys = periods.map((p, idx) => ({
    key: p.id,
    label: p.label || `Период ${idx + 1}`,
    color: periodColor(idx),
  }));

  const data = [];
  for (let i = 0; i < maxLen; i += 1) {
    const primary = periods[0]?.buckets?.[i];
    const row = {
      index: i + 1,
      label: primary?.bucketLabel || `#${i + 1}`,
    };
    for (const p of periods) {
      const bucket = p.buckets?.[i];
      if (!bucket) {
        row[p.id] = null;
        continue;
      }
      if (marketplace) {
        row[p.id] = Number(bucket.marketplaces?.[marketplace]?.[metric] ?? 0) || 0;
      } else {
        row[p.id] = Number(bucket[metric] ?? 0) || 0;
      }
    }
    data.push(row);
  }

  return { data, seriesKeys };
}

export function formatMetricValue(metric, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (metric === 'soldQty') {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
  }
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(n);
}

export { MP_LABELS, MP_COLORS, PERIOD_COLORS, PRODUCT_COLORS };
