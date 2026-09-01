/**
 * Настройки отправки цен на маркетплейсы (на уровне profile).
 */

/** Sentinel «без категории» — как на странице цен/товаров. */
export const PRICE_PUSH_CATEGORY_NONE = '__no_category__';

export const PRICE_PUSH_SCOPE_ALL = 'all';
export const PRICE_PUSH_SCOPE_CATEGORIES = 'categories';
export const PRICE_PUSH_SCOPE_PRODUCTS = 'products';

const SCOPES = new Set([
  PRICE_PUSH_SCOPE_ALL,
  PRICE_PUSH_SCOPE_CATEGORIES,
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

export function parsePricePushSettings(raw) {
  const src = parseObject(raw);
  const scopeRaw = String(src.scope || PRICE_PUSH_SCOPE_ALL).trim();
  const scope = SCOPES.has(scopeRaw) ? scopeRaw : PRICE_PUSH_SCOPE_ALL;
  return {
    scope,
    categoryIds: parseCategoryIdList(src.categoryIds),
    productIds: parsePositiveIntList(src.productIds),
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

  if (next.scope === PRICE_PUSH_SCOPE_CATEGORIES && !next.categoryIds.length) {
    next.scope = PRICE_PUSH_SCOPE_ALL;
  }
  if (next.scope === PRICE_PUSH_SCOPE_PRODUCTS && !next.productIds.length) {
    next.scope = PRICE_PUSH_SCOPE_ALL;
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
  } else if (settings.scope === PRICE_PUSH_SCOPE_PRODUCTS && settings.productIds.length) {
    filters.productIds = settings.productIds;
  }

  return filters;
}

export function describePricePushScope(settings, { categoryNamesById = {} } = {}) {
  const s = parsePricePushSettings(settings);
  if (s.scope === PRICE_PUSH_SCOPE_PRODUCTS) {
    return `выбранные товары (${s.productIds.length})`;
  }
  if (s.scope === PRICE_PUSH_SCOPE_CATEGORIES) {
    const names = s.categoryIds.map((id) => {
      if (id === PRICE_PUSH_CATEGORY_NONE) return 'без категории';
      return categoryNamesById[id] || categoryNamesById[String(id)] || `#${id}`;
    });
    return names.length
      ? `категории: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}`
      : 'все товары';
  }
  return 'все товары';
}
