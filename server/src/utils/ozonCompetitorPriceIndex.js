/**
 * Индекс цен Ozon из ответа POST /v5/product/info/prices.
 * ozon_index_data — минимальная цена конкурентов на Ozon, не наша цена.
 */

function parseMoney(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function parseIndexValue(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function normalizeOzonColorIndex(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^COLOR_INDEX_/, '');
  if (raw === 'GREEN' || raw === 'YELLOW' || raw === 'RED') return raw;
  if (raw === 'WITHOUT_INDEX') return 'WITHOUT_INDEX';
  return null;
}

export function ozonColorIndexLabel(color) {
  if (color === 'GREEN') return 'выгодный';
  if (color === 'YELLOW') return 'средний';
  if (color === 'RED') return 'невыгодный';
  if (color === 'WITHOUT_INDEX') return 'нет индекса';
  return null;
}

/**
 * @param {object} item элемент data.items из /v5/product/info/prices
 */
export function parseOzonCompetitorPriceIndex(item) {
  const indexes = item?.price_indexes || item?.price?.price_indexes || null;
  const ozon = indexes?.ozon_index_data || indexes?.ozonIndexData || {};
  const external = indexes?.external_index_data || indexes?.externalIndexData || {};
  const color = normalizeOzonColorIndex(indexes?.color_index ?? indexes?.colorIndex);
  return {
    competitor_min_price: parseMoney(ozon.min_price ?? ozon.minimal_price ?? ozon.minPrice),
    external_min_price: parseMoney(external.min_price ?? external.minimal_price ?? external.minPrice),
    price_index_value: parseIndexValue(ozon.price_index_value ?? ozon.priceIndexValue),
    color_index: color,
  };
}
