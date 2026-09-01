/**
 * Настройки отправки цен на маркетплейсы (на уровне profile).
 */

/** Sentinel «без категории» — как на странице цен/товаров. */
export const PRICE_PUSH_CATEGORY_NONE = '__no_category__';

export const PRICE_PUSH_SCOPE_ALL = 'all';
export const PRICE_PUSH_SCOPE_CATEGORIES = 'categories';
/** Категории и явный список товаров (пересечение фильтров). */
export const PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS = 'categories_and_products';
/** @deprecated Сохранено для старых настроек; в UI не используется. */
export const PRICE_PUSH_SCOPE_PRODUCTS = 'products';

const SCOPES = new Set([
  PRICE_PUSH_SCOPE_ALL,
  PRICE_PUSH_SCOPE_CATEGORIES,
  PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS,
  PRICE_PUSH_SCOPE_PRODUCTS,
]);

function parseObject(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parsePositiveIntList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0))];
}

function parseCategoryIdList(raw) {
  if (raw == null || raw === '') return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return [...new Set(arr.map((v) => String(v).trim()).filter(Boolean))];
}

function parseBoolFlag(value, defaultValue = true) {
  if (value === undefined || value === null) return defaultValue;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return defaultValue;
}

function floorRub(minPrice) {
  if (minPrice == null || minPrice === '') return null;
  const n = Number(minPrice);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(1, Math.ceil(n));
}

export function parsePricePushSettings(raw) {
  const src = parseObject(raw);
  const scopeRaw = String(src.scope || PRICE_PUSH_SCOPE_ALL).trim();
  const scope = SCOPES.has(scopeRaw) ? scopeRaw : PRICE_PUSH_SCOPE_ALL;
  const pushFbs = parseBoolFlag(src.pushFbs ?? src.push_fbs, true);
  const pushFbo = parseBoolFlag(src.pushFbo ?? src.push_fbo, true);
  return {
    scope,
    categoryIds: parseCategoryIdList(src.categoryIds),
    productIds: parsePositiveIntList(src.productIds),
    pushFbs: pushFbs || !pushFbo,
    pushFbo: pushFbo || !pushFbs,
  };
}

export function mergePricePushSettings(current, incoming) {
  const base = parsePricePushSettings(current);
  const patch = incoming && typeof incoming === 'object' ? incoming : {};
  const next = { ...base };

  if (patch.scope != null) {
    const scopeRaw = String(patch.scope).trim();
    if (SCOPES.has(scopeRaw)) next.scope = scopeRaw;
  }
  if (patch.categoryIds !== undefined) {
    next.categoryIds = parseCategoryIdList(patch.categoryIds);
  }
  if (patch.productIds !== undefined) {
    next.productIds = parsePositiveIntList(patch.productIds);
  }
  if (patch.pushFbs !== undefined || patch.push_fbs !== undefined) {
    next.pushFbs = parseBoolFlag(patch.pushFbs ?? patch.push_fbs, next.pushFbs);
  }
  if (patch.pushFbo !== undefined || patch.push_fbo !== undefined) {
    next.pushFbo = parseBoolFlag(patch.pushFbo ?? patch.push_fbo, next.pushFbo);
  }

  if (!next.pushFbs && !next.pushFbo) {
    next.pushFbs = true;
  }

  if (next.scope === PRICE_PUSH_SCOPE_CATEGORIES && !next.categoryIds.length) {
    next.scope = PRICE_PUSH_SCOPE_ALL;
  }
  if (next.scope === PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS) {
    if (!next.categoryIds.length || !next.productIds.length) {
      if (next.categoryIds.length && !next.productIds.length) {
        next.scope = PRICE_PUSH_SCOPE_CATEGORIES;
      } else {
        next.scope = PRICE_PUSH_SCOPE_ALL;
        next.categoryIds = [];
        next.productIds = [];
      }
    }
  }
  if (next.scope === PRICE_PUSH_SCOPE_PRODUCTS && !next.productIds.length) {
    next.scope = PRICE_PUSH_SCOPE_ALL;
  }

  if (next.scope === PRICE_PUSH_SCOPE_ALL) {
    next.categoryIds = [];
    next.productIds = [];
  }
  if (next.scope === PRICE_PUSH_SCOPE_CATEGORIES) {
    next.productIds = [];
  }

  return next;
}

/**
 * Фильтры для resolvePushProductIds по сохранённым настройкам profile.
 */
export function filtersFromPricePushSettings(raw, profileId) {
  const settings = parsePricePushSettings(raw);
  const filters = {};
  const pid = Number(profileId);
  if (Number.isFinite(pid) && pid > 0) filters.profileId = pid;

  if (settings.scope === PRICE_PUSH_SCOPE_CATEGORIES && settings.categoryIds.length) {
    filters.categoryIds = settings.categoryIds;
  } else if (
    settings.scope === PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS &&
    settings.categoryIds.length &&
    settings.productIds.length
  ) {
    filters.categoryIds = settings.categoryIds;
    filters.productIds = settings.productIds;
  } else if (settings.scope === PRICE_PUSH_SCOPE_PRODUCTS && settings.productIds.length) {
    filters.productIds = settings.productIds;
  }

  return filters;
}

export function describePricePushScope(settings, { categoryNamesById = {} } = {}) {
  const s = parsePricePushSettings(settings);
  if (s.scope === PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS) {
    const catPart = describeCategoryIds(s.categoryIds, categoryNamesById);
    return `${catPart}, ${s.productIds.length} товар(ов)`;
  }
  if (s.scope === PRICE_PUSH_SCOPE_PRODUCTS) {
    return `выбранные товары (${s.productIds.length})`;
  }
  if (s.scope === PRICE_PUSH_SCOPE_CATEGORIES) {
    return describeCategoryIds(s.categoryIds, categoryNamesById);
  }
  return 'все товары';
}

function describeCategoryIds(categoryIds, categoryNamesById = {}) {
  const names = categoryIds.map((id) => {
    if (id === PRICE_PUSH_CATEGORY_NONE) return 'без категории';
    return categoryNamesById[id] || categoryNamesById[String(id)] || `#${id}`;
  });
  return names.length
    ? `категории: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}`
    : 'все товары';
}

export function describePricePushSchemes(settings) {
  const s = parsePricePushSettings(settings);
  if (s.pushFbs && s.pushFbo) return 'мин. цены FBS и FBO';
  if (s.pushFbs) return 'мин. цены FBS';
  if (s.pushFbo) return 'мин. цены FBO';
  return 'мин. цены';
}

/**
 * Какую мин. цену отправлять на МП по выбранным схемам (на карточке одна цена).
 * legacy min_price: Ozon/YM ≈ FBS, WB ≈ FBO.
 */
export function resolvePushFloorForMarketplace(row, marketplace, schemes) {
  const pushFbs = schemes?.pushFbs !== false;
  const pushFbo = schemes?.pushFbo !== false;
  if (!pushFbs && !pushFbo) return null;

  const mp = String(marketplace || '').toLowerCase();
  const fbs = floorRub(row?.min_price_fbs);
  const fbo = floorRub(row?.min_price_fbo);
  const legacy = floorRub(row?.min_price);

  const candidates = [];
  if (pushFbs) {
    if (fbs != null) candidates.push(fbs);
    else if (legacy != null && mp !== 'wb') candidates.push(legacy);
  }
  if (pushFbo) {
    if (fbo != null) candidates.push(fbo);
    else if (legacy != null && mp === 'wb') candidates.push(legacy);
  }

  if (!candidates.length) return null;
  return Math.max(...candidates);
}
