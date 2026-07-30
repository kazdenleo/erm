/**
 * Габариты для логистики/мин. цен строго из данных маркетплейса:
 * Ozon — ozon_attributes, иначе ozon_draft.dimensions, иначе ERP при связи dimensions↔ozon;
 * WB — атрибуты упаковки / wb_draft.dimensions;
 * YM — ym_draft.weightDimensions.
 * Без общего ERP fallback (products.volume) для известных МП.
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

/** Связь dimensions↔mp включена (по умолчанию — да, как normalizeMpFieldLinks). */
function isDimensionsLinked(product, mp) {
  const code = String(mp || '').toLowerCase();
  const raw = product?.mp_field_links;
  if (raw == null || raw === '') return true;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return true;
    }
  }
  if (!obj || typeof obj !== 'object') return true;
  if (!Object.prototype.hasOwnProperty.call(obj, 'dimensions')) return true;
  const v = obj.dimensions;
  if (Array.isArray(v)) {
    return v.map((x) => String(x || '').toLowerCase()).includes(code);
  }
  if (v && typeof v === 'object') return !!v[code];
  return false;
}

/** Ozon: атрибуты «Длина/Ширина/Высота, мм», иначе draft/связанный ERP (как в карточке). */
export function extractOzonDimensionsMm(product) {
  const attrs = parseAttrs(product?.ozon_attributes);
  if (attrs) {
    const length = pickAttr(attrs, [9802, '9802']);
    const width = pickAttr(attrs, [6605, 9799, '6605', '9799']);
    const height = pickAttr(attrs, [6606, 6859, '6606', '6859']); // 6859 = толщина
    if (length != null && width != null && height != null) {
      return { length, width, height, source: 'ozon_attributes' };
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

  if (isDimensionsLinked(product, 'ozon')) {
    const length = num(product?.length);
    const width = num(product?.width);
    const height = num(product?.height);
    if (length != null && width != null && height != null) {
      return { length, width, height, source: 'product_linked' };
    }
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

/** WB Content API: габариты предмета/товара (см) в characteristics. */
export const WB_ITEM_DIM_CHARC = {
  length: '90652',
  width: '90673',
  height: '90630',
};

/** charcID габаритов товара или упаковки WB — не дублировать в общем списке характеристик. */
export function isWbDedicatedDimCharcId(id) {
  const s = String(id ?? '');
  if (!s) return false;
  return (
    s === WB_PACK_DIM_CHARC.length ||
    s === WB_PACK_DIM_CHARC.width ||
    s === WB_PACK_DIM_CHARC.height ||
    s === WB_ITEM_DIM_CHARC.length ||
    s === WB_ITEM_DIM_CHARC.width ||
    s === WB_ITEM_DIM_CHARC.height
  );
}

/**
 * Классификация названия атрибута МП: габариты товара / упаковки / иное.
 * @returns {'product'|'pack'|null}
 */
export function classifyMarketplaceDimAttrName(name) {
  const n = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!n) return null;
  if (/^(длина|ширина|высота)\s+(упаковк|товара\s+в\s+упаковк)/.test(n)) return 'pack';
  if (/^вес\s+(с\s+)?упаковк/.test(n)) return 'pack';
  if (/^вес\s+товара\s+с\s+упаковк/.test(n)) return 'pack';
  if (/^габарит(ы)?\s+упаковк/.test(n)) return 'pack';
  if (/^(длина|ширина|высота)\s+товар/.test(n)) return 'product';
  if (/^вес\s+товар/.test(n)) return 'product';
  if (/^габарит(ы)?\s+товар/.test(n)) return 'product';
  if (/^вес\s+без\s+упаковк/.test(n)) return 'product';
  return null;
}

/**
 * WB: только упаковка — атрибуты 90849/90745/90846 (см) или wb_draft.dimensions (мм).
 * Габариты «предмета» (90652/90673/90630) для логистики не используем.
 */
export function extractWbDimensionsMm(product) {
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
