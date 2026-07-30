/**
 * Габариты для логистики/мин. цен по маркетплейсу.
 * Ozon / WB — из ozon_attributes / wb_attributes; YM — из ym_draft.weightDimensions (см/кг).
 * Fallback — общие products.length/width/height (мм).
 */

function parseAttrs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseDraft(raw) {
  return parseAttrs(raw);
}

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    const inner = v.value ?? v.name ?? v.text ?? null;
    return num(inner);
  }
  const n = Number(String(v).replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function litersFromMm(length, width, height) {
  if (length == null || width == null || height == null) return null;
  const liters = (length * width * height) / 1_000_000;
  if (!(liters > 0)) return null;
  return Math.round(liters * 1000) / 1000;
}

function pickAttr(attrs, keys) {
  if (!attrs) return null;
  for (const k of keys) {
    const v = num(attrs[k] ?? attrs[String(k)]);
    if (v != null) return v;
  }
  return null;
}

/** Ozon: атрибуты «Длина/Ширина/Высота, мм» (типовые id). */
export function extractOzonDimensionsMm(product) {
  const attrs = parseAttrs(product?.ozon_attributes);
  if (!attrs) return null;
  const length = pickAttr(attrs, [9802, '9802']);
  const width = pickAttr(attrs, [6605, 9799, '6605', '9799']);
  const height = pickAttr(attrs, [6606, 6859, '6606', '6859']); // 6859 = толщина
  if (length != null && width != null && height != null) {
    return { length, width, height, source: 'ozon_attributes' };
  }
  return null;
}

/**
 * WB Content API: габариты упаковки (см) в characteristics.
 * При отсутствии в категории всё равно пишем из card.dimensions — для объёма/логистики.
 */
export const WB_PACK_DIM_CHARC = {
  length: '90849',
  width: '90745',
  height: '90846',
};

/**
 * WB: сначала «* упаковки» (см), затем wb_draft.dimensions (мм), затем «* предмета».
 * charcID стабильны между категориями.
 */
export function extractWbDimensionsMm(product) {
  const attrs = parseAttrs(product?.wb_attributes);

  // Упаковка — см (атрибуты категории)
  if (attrs) {
    const packL = pickAttr(attrs, [90849, '90849']);
    const packW = pickAttr(attrs, [90745, '90745']);
    const packH = pickAttr(attrs, [90846, '90846']);
    if (packL != null && packW != null && packH != null) {
      return {
        length: Math.round(packL * 10),
        width: Math.round(packW * 10),
        height: Math.round(packH * 10),
        source: 'wb_attributes_pack',
      };
    }
  }

  // Габариты упаковки из Content API (card.dimensions) — в wb_draft в мм
  const draft = parseDraft(product?.wb_draft);
  const wd = draft?.dimensions;
  if (wd && typeof wd === 'object') {
    const length = num(wd.length);
    const width = num(wd.width);
    const height = num(wd.height);
    if (length != null && width != null && height != null) {
      return { length, width, height, source: 'wb_draft.dimensions' };
    }
  }

  if (!attrs) return null;

  // Предмет — мм
  const itemLmm = pickAttr(attrs, [12153433, 64099, '12153433', '64099']);
  const itemWmm = pickAttr(attrs, [7594048, '7594048']);
  const itemHmm = pickAttr(attrs, [7594043, '7594043']);
  if (itemLmm != null && itemWmm != null && itemHmm != null) {
    return { length: itemLmm, width: itemWmm, height: itemHmm, source: 'wb_attributes_item_mm' };
  }

  // Предмет — см (длина/ширина/высота/глубина)
  const itemLcm = pickAttr(attrs, [90675, '90675']);
  const itemWcm = pickAttr(attrs, [90673, '90673']);
  const itemHcm = pickAttr(attrs, [90630, '90630']);
  const itemDepthCm = pickAttr(attrs, [90652, '90652']);
  const L = itemLcm ?? itemDepthCm;
  if (L != null && itemWcm != null && itemHcm != null) {
    return {
      length: Math.round(L * 10),
      width: Math.round(itemWcm * 10),
      height: Math.round(itemHcm * 10),
      source: 'wb_attributes_item_cm',
    };
  }

  return null;
}

/** YM: weightDimensions в ym_draft (см / кг), как в Partner API. */
export function extractYmDimensionsMm(product) {
  const draft = parseDraft(product?.ym_draft);
  const wd = draft?.weightDimensions;
  if (wd && typeof wd === 'object') {
    const lengthCm = num(wd.length);
    const widthCm = num(wd.width);
    const heightCm = num(wd.height);
    if (lengthCm != null && widthCm != null && heightCm != null) {
      return {
        length: Math.round(lengthCm * 10),
        width: Math.round(widthCm * 10),
        height: Math.round(heightCm * 10),
        source: 'ym_draft.weightDimensions',
      };
    }
  }
  return null;
}

export function extractGeneralDimensionsMm(product) {
  if (!product || typeof product !== 'object') return null;
  const length = num(product.length);
  const width = num(product.width);
  const height = num(product.height);
  if (length != null && width != null && height != null) {
    return { length, width, height, source: 'product' };
  }
  return null;
}

/**
 * @param {object|null|undefined} product
 * @param {string|null|undefined} marketplace — ozon|wb|ym
 * @returns {{ length: number, width: number, height: number, source: string }|null}
 */
export function resolveMarketplaceDimensionsMm(product, marketplace) {
  const mp = String(marketplace || '').toLowerCase();
  let dims = null;
  if (mp === 'ozon') dims = extractOzonDimensionsMm(product);
  else if (mp === 'wb' || mp === 'wildberries') dims = extractWbDimensionsMm(product);
  else if (mp === 'ym' || mp === 'yandex') dims = extractYmDimensionsMm(product);
  return dims || extractGeneralDimensionsMm(product);
}

/**
 * @param {object|null|undefined} product
 * @param {string|null|undefined} marketplace
 * @returns {number|null} литры
 */
export function resolveMarketplaceVolumeLiters(product, marketplace) {
  const dims = resolveMarketplaceDimensionsMm(product, marketplace);
  if (!dims) {
    const direct = product?.volume ?? product?.volume_liters ?? product?.volumeLiters ?? product?.effectiveVolume;
    const n = num(direct);
    return n;
  }
  return litersFromMm(dims.length, dims.width, dims.height);
}
