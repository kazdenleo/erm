/**
 * Габариты для логистики/мин. цен:
 * Ozon — связь → ERP; иначе ozon_draft; иначе attrs; иначе упаковка ERP (L×W×H);
 * WB — связь → ERP; иначе pack attrs / wb_draft; иначе упаковка ERP;
 * YM — связь → ERP; иначе ym_draft.weightDimensions; иначе упаковка ERP.
 * products.volume как fallback не используем (только явное L×W×H).
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

function isKnownMarketplace(mp) {
  return (
    mp === 'ozon' ||
    mp === 'wb' ||
    mp === 'wildberries' ||
    mp === 'ym' ||
    mp === 'yandex'
  );
}

/** Связь dimensions↔mp включена (по умолчанию — нет). */
function isDimensionsLinked(product, mp) {
  const code = String(mp || '').toLowerCase();
  const raw = product?.mp_field_links;
  if (raw == null || raw === '') return false;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  if (!obj || typeof obj !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(obj, 'dimensions')) return false;
  const v = obj.dimensions;
  if (Array.isArray(v)) {
    return v.map((x) => String(x || '').toLowerCase()).includes(code);
  }
  if (v && typeof v === 'object') return !!v[code];
  return false;
}

/** Ozon: упаковка как в push — связь → ERP; иначе draft; иначе attrs (9802/…). */
export function extractOzonDimensionsMm(product) {
  if (isDimensionsLinked(product, 'ozon')) {
    const length = num(product?.length);
    const width = num(product?.width);
    const height = num(product?.height);
    if (length != null && width != null && height != null) {
      return { length, width, height, source: 'product_linked' };
    }
  }

  const draft = parseDraft(product?.ozon_draft);
  const wd = draft?.dimensions;
  if (wd && typeof wd === 'object') {
    const length = num(wd.length);
    const width = num(wd.width);
    const height = num(wd.height);
    if (length != null && width != null && height != null) {
      return { length, width, height, source: 'ozon_draft.dimensions' };
    }
  }

  const attrs = parseAttrs(product?.ozon_attributes);
  if (attrs) {
    const length = pickAttr(attrs, [9802, '9802']);
    const width = pickAttr(attrs, [6605, 9799, '6605', '9799']);
    const height = pickAttr(attrs, [6606, 6859, '6606', '6859']); // 6859 = толщина
    if (length != null && width != null && height != null) {
      return { length, width, height, source: 'ozon_attributes' };
    }
  }

  return extractErpPackagingMm(product);
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

/** WB Content API: габариты предмета/товара (см) в characteristics. */
export const WB_ITEM_DIM_CHARC = {
  length: '90652',
  width: '90673',
  height: '90630',
};

export function isWbPackDimCharcId(id) {
  const s = String(id ?? '');
  if (!s) return false;
  return (
    s === WB_PACK_DIM_CHARC.length ||
    s === WB_PACK_DIM_CHARC.width ||
    s === WB_PACK_DIM_CHARC.height
  );
}

export function isWbItemDimCharcId(id) {
  const s = String(id ?? '');
  if (!s) return false;
  return (
    s === WB_ITEM_DIM_CHARC.length ||
    s === WB_ITEM_DIM_CHARC.width ||
    s === WB_ITEM_DIM_CHARC.height
  );
}

/** charcID габаритов товара или упаковки WB. */
export function isWbDedicatedDimCharcId(id) {
  return isWbPackDimCharcId(id) || isWbItemDimCharcId(id);
}

/**
 * Классификация названия атрибута МП: габариты товара / упаковки / иное.
 * @returns {'product'|'pack'|null}
 */
function normalizeDimAttrName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

export function classifyMarketplaceDimAttrName(name) {
  const n = normalizeDimAttrName(name);
  if (!n) return null;
  // «… без упаковки» — габариты товара; иначе любое «с/в упаковке» — логистика, не категория «товар».
  if (!/без\s+упаковк/.test(n) && /упаковк/.test(n)) {
    if (/^(длина|ширина|высота|глубина|вес|габарит)/.test(n)) return 'pack';
  }
  if (/^(длина|ширина|высота|глубина)\s+(упаковк|товара\s+(в|с)\s+упаковк)/.test(n)) return 'pack';
  if (/^вес\s+(с\s+)?упаковк/.test(n)) return 'pack';
  if (/^вес\s+в\s+упаковк/.test(n)) return 'pack';
  if (/^вес\s+товара\s+с\s+упаковк/.test(n)) return 'pack';
  if (/^вес\s+товара\s+в\s+упаковк/.test(n)) return 'pack';
  if (/^габарит(ы)?\s+упаковк/.test(n)) return 'pack';
  if (/^(длина|ширина|высота)\s+товар/.test(n)) return 'product';
  if (/^вес\s+товар/.test(n)) return 'product';
  if (/^вес\s+товар[аы]?,?\s*г/.test(n)) return 'product';
  if (/^габарит(ы)?\s+товар/.test(n)) return 'product';
  if (/^вес\s+без\s+упаковк/.test(n)) return 'product';
  // Категорийные «Длина / Ширина / Высота» Ozon (не кабель и не упаковка)
  if (/^(длина|ширина|высота|глубина)(\s*[,:(–-]\s*|\s+)(мм|см|м|mm|cm|m)\)?$/.test(n)) return 'product';
  if (/^(длина|ширина|высота|глубина)$/.test(n)) return 'product';
  if (/^(length|width|height|depth)(\s*[,:(–-]\s*|\s+)(mm|cm|m)\)?$/.test(n)) return 'product';
  if (/^(length|width|height|depth)$/.test(n)) return 'product';
  return null;
}

/** Ось габарита товара Ozon: length | width | height | weight. */
export function ozonProductDimAxis(attrOrName) {
  const n = normalizeDimAttrName(
    attrOrName && typeof attrOrName === 'object' ? attrOrName.name : attrOrName
  );
  if (!n || classifyMarketplaceDimAttrName(n) !== 'product') return null;
  if (/^(длина|глубина|length|depth)(?:$|[\s,:(])/.test(n)) return 'length';
  if (/^(ширина|width)(?:$|[\s,:(])/.test(n)) return 'width';
  if (/^(высота|height)(?:$|[\s,:(])/.test(n)) return 'height';
  if (/^(вес|weight)(?:$|[\s,:(])/.test(n)) return 'weight';
  return null;
}

/** Известные id атрибутов упаковки Ozon. */
export const OZON_PACK_DIM_ATTR_IDS = {
  length: ['9802'],
  width: ['6605', '9799'],
  height: ['6606', '6859'],
  weight: ['4497', '4383'],
};

/** Ось габарита упаковки Ozon: length | width | height | weight. */
export function ozonPackDimAxis(attrOrName) {
  const id = String(
    attrOrName && typeof attrOrName === 'object'
      ? attrOrName.id ?? attrOrName.attribute_id ?? ''
      : ''
  );
  if (id) {
    for (const [axis, ids] of Object.entries(OZON_PACK_DIM_ATTR_IDS)) {
      if (ids.includes(id)) return axis;
    }
  }
  const n = normalizeDimAttrName(
    attrOrName && typeof attrOrName === 'object' ? attrOrName.name : attrOrName
  );
  if (!n || classifyMarketplaceDimAttrName(n) !== 'pack') return null;
  if (/^(длина|глубина|length|depth)(?:$|[\s,:(])/.test(n)) return 'length';
  if (/^(ширина|width)(?:$|[\s,:(])/.test(n)) return 'width';
  if (/^(высота|height)(?:$|[\s,:(])/.test(n)) return 'height';
  if (/^(вес|weight)(?:$|[\s,:(])/.test(n)) return 'weight';
  return null;
}

export function wbProductDimAxis(attr) {
  const id = String(
    attr?.charcID ?? attr?.characteristic_id ?? attr?.id ?? attr?.attribute_id ?? ''
  );
  if (id === WB_ITEM_DIM_CHARC.length) return 'length';
  if (id === WB_ITEM_DIM_CHARC.width) return 'width';
  if (id === WB_ITEM_DIM_CHARC.height) return 'height';
  if (isWbPackDimCharcId(id)) return null;
  const axis = ozonProductDimAxis(attr?.name ?? attr);
  return axis === 'length' || axis === 'width' || axis === 'height' ? axis : null;
}

/**
 * Значение характеристики товара: L/W/H — Ozon мм, WB/YM см (YM мм, если в названии «мм»);
 * вес — граммы, для YM в кг если в названии «кг».
 */
export function productDimAttrStoredFromMm(attrOrName, mmVal, mp) {
  if (mmVal === '' || mmVal == null) return '';
  const n = Number(mmVal);
  if (!Number.isFinite(n) || n <= 0) return '';
  const code = String(mp || '').toLowerCase();
  const name = attrOrName && typeof attrOrName === 'object' ? attrOrName.name : attrOrName;
  const s = String(name || '').toLowerCase();
  if (ozonProductDimAxis(attrOrName) === 'weight') {
    if (code === 'ozon') return String(Math.round(n));
    if (/кг|\bkg\b/.test(s)) return String(Math.round((n / 1000) * 1000) / 1000);
    return String(Math.round(n));
  }
  if (code === 'ozon') return String(Math.round(n));
  if (code !== 'wb' && /мм|\bmm\b/.test(s)) return String(Math.round(n));
  return String(Math.max(1, Math.round(n / 10)));
}

/** Атрибут уже покрыт полями product_length/width/height/weight — не дублировать в форме. */
export function isCoveredByDedicatedProductDimFields(name) {
  return classifyMarketplaceDimAttrName(name) === 'product';
}

/**
 * Подпись объёма для UI (литры).
 * @param {unknown} length
 * @param {unknown} width
 * @param {unknown} height
 * @param {'mm'|'cm'} [unit='mm']
 * @param {{ roundUpToWholeCm?: boolean }} [opts] — как логистика WB: каждая сторона в целых см вверх
 * @returns {string|null}
 */
export function formatVolumeLitersLabel(length, width, height, unit = 'mm', opts = {}) {
  const L = Number(length);
  const W = Number(width);
  const H = Number(height);
  if (!(L > 0 && W > 0 && H > 0)) return null;
  let liters;
  if (opts.roundUpToWholeCm) {
    const toCm = (v) => (unit === 'cm' ? Math.ceil(v) : Math.ceil(v / 10));
    liters = (toCm(L) * toCm(W) * toCm(H)) / 1000;
  } else {
    liters = unit === 'cm' ? (L * W * H) / 1000 : (L * W * H) / 1_000_000;
  }
  if (!(liters > 0)) return null;
  return `${(Math.round(liters * 1000) / 1000).toFixed(2)} л`;
}

/**
 * WB: упаковка — при связи dimensions↔wb → ERP (как push/UI);
 * иначе атрибуты 90849/90745/90846 (см) или wb_draft.dimensions (мм).
 * Габариты «предмета» для логистики не используем.
 */
export function extractWbDimensionsMm(product) {
  if (isDimensionsLinked(product, 'wb') || isDimensionsLinked(product, 'wildberries')) {
    const length = num(product?.length);
    const width = num(product?.width);
    const height = num(product?.height);
    if (length != null && width != null && height != null) {
      return { length, width, height, source: 'product_linked' };
    }
  }

  const attrs = parseAttrs(product?.wb_attributes);

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

  return extractErpPackagingMm(product);
}

/**
 * YM: как push — связь dimensions↔ym → ERP (мм); иначе ym_draft.weightDimensions (см).
 * Иначе устаревший draft (округлённые см) даёт неверный объём при актуальных ERP-габаритах.
 */
export function extractYmDimensionsMm(product) {
  if (isDimensionsLinked(product, 'ym')) {
    const length = num(product?.length);
    const width = num(product?.width);
    const height = num(product?.height);
    if (length != null && width != null && height != null) {
      return { length, width, height, source: 'product_linked' };
    }
  }

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
  return extractErpPackagingMm(product);
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

/** Упаковка с вкладки «Основное» (мм), если у МП нет своих валидных габаритов. */
function extractErpPackagingMm(product) {
  const dims = extractGeneralDimensionsMm(product);
  if (!dims) return null;
  return { ...dims, source: 'product_packaging' };
}

/**
 * @param {object|null|undefined} product
 * @param {string|null|undefined} marketplace — ozon|wb|ym
 * @param {{ allowGeneralFallback?: boolean }} [opts] — только явный true включает ERP
 * @returns {{ length: number, width: number, height: number, source: string }|null}
 */
export function resolveMarketplaceDimensionsMm(product, marketplace, opts = {}) {
  const mp = String(marketplace || '').toLowerCase();
  let dims = null;
  if (mp === 'ozon') dims = extractOzonDimensionsMm(product);
  else if (mp === 'wb' || mp === 'wildberries') dims = extractWbDimensionsMm(product);
  else if (mp === 'ym' || mp === 'yandex') dims = extractYmDimensionsMm(product);
  else return extractGeneralDimensionsMm(product);

  if (dims) return dims;
  if (opts.allowGeneralFallback === true) return extractGeneralDimensionsMm(product);
  return null;
}

/**
 * @param {object|null|undefined} product
 * @param {string|null|undefined} marketplace
 * @param {{ allowGeneralFallback?: boolean }} [opts]
 * @returns {number|null} литры
 */
export function resolveMarketplaceVolumeLiters(product, marketplace, opts = {}) {
  const mp = String(marketplace || '').toLowerCase();
  const dims = resolveMarketplaceDimensionsMm(product, marketplace, opts);
  if (dims) return litersFromMm(dims.length, dims.width, dims.height);

  if (isKnownMarketplace(mp) && opts.allowGeneralFallback !== true) return null;

  const direct = product?.volume ?? product?.volume_liters ?? product?.volumeLiters ?? product?.effectiveVolume;
  return num(direct);
}
