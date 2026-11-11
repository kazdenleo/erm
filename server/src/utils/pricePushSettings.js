/**
 * Настройки отправки цен на маркетплейсы (на уровне profile).
 */

import { parseMinMarkupRules } from './minMarkupRules.js';
import { clampHighDrrPercent, HIGH_DRR_DEFAULT_PERCENT } from './highDrrSettings.js';

/** Sentinel «без категории» — как на странице цен/товаров. */
export const PRICE_PUSH_CATEGORY_NONE = '__no_category__';

export const PRICE_PUSH_SCOPE_ALL = 'all';
export const PRICE_PUSH_SCOPE_CATEGORIES = 'categories';
/** Категории и явный список товаров (пересечение фильтров). */
export const PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS = 'categories_and_products';
/** @deprecated Сохранено для старых настроек; в UI не используется. */
export const PRICE_PUSH_SCOPE_PRODUCTS = 'products';

/** Ключи МП в настройках / пуше (как в product_marketplace_prices.marketplace). */
export const PRICE_PUSH_MARKETPLACE_OZON = 'ozon';
export const PRICE_PUSH_MARKETPLACE_WB = 'wb';
export const PRICE_PUSH_MARKETPLACE_YM = 'ym';

export const PRICE_PUSH_MARKETPLACES = Object.freeze([
  PRICE_PUSH_MARKETPLACE_OZON,
  PRICE_PUSH_MARKETPLACE_WB,
  PRICE_PUSH_MARKETPLACE_YM,
]);

const SCOPES = new Set([
  PRICE_PUSH_SCOPE_ALL,
  PRICE_PUSH_SCOPE_CATEGORIES,
  PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS,
  PRICE_PUSH_SCOPE_PRODUCTS,
]);

const MP_ALIASES = Object.freeze({
  ozon: PRICE_PUSH_MARKETPLACE_OZON,
  wb: PRICE_PUSH_MARKETPLACE_WB,
  wildberries: PRICE_PUSH_MARKETPLACE_WB,
  ym: PRICE_PUSH_MARKETPLACE_YM,
  yandex: PRICE_PUSH_MARKETPLACE_YM,
  yandexmarket: PRICE_PUSH_MARKETPLACE_YM,
});

function normalizeMarketplaceKey(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase();
  return MP_ALIASES[key] || null;
}

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

function parseMarketplaceFlags(src) {
  // Явный список marketplaces: ['ozon','wb'] — остальные выкл.; пустой массив = все выкл.
  if (Array.isArray(src.marketplaces) || Array.isArray(src.pushMarketplaces)) {
    const enabled = new Set(
      (src.marketplaces ?? src.pushMarketplaces)
        .map(normalizeMarketplaceKey)
        .filter(Boolean)
    );
    return {
      pushOzon: enabled.has(PRICE_PUSH_MARKETPLACE_OZON),
      pushWb: enabled.has(PRICE_PUSH_MARKETPLACE_WB),
      pushYm: enabled.has(PRICE_PUSH_MARKETPLACE_YM),
    };
  }
  return {
    pushOzon: parseBoolFlag(src.pushOzon ?? src.push_ozon, true),
    pushWb: parseBoolFlag(src.pushWb ?? src.push_wb, true),
    pushYm: parseBoolFlag(src.pushYm ?? src.push_ym, true),
  };
}

export function parsePricePushSettings(raw) {
  const src = parseObject(raw);
  const scopeRaw = String(src.scope || PRICE_PUSH_SCOPE_ALL).trim();
  const scope = SCOPES.has(scopeRaw) ? scopeRaw : PRICE_PUSH_SCOPE_ALL;
  // Обе схемы могут быть выключены — «не отправлять цены на МП» по схемам.
  const pushFbs = parseBoolFlag(src.pushFbs ?? src.push_fbs, true);
  const pushFbo = parseBoolFlag(src.pushFbo ?? src.push_fbo, true);
  const mpFlags = parseMarketplaceFlags(src);
  return {
    scope,
    categoryIds: parseCategoryIdList(src.categoryIds),
    productIds: parsePositiveIntList(src.productIds),
    excludeProductIds: parsePositiveIntList(src.excludeProductIds ?? src.exclude_product_ids),
    pushFbs,
    pushFbo,
    pushOzon: mpFlags.pushOzon,
    pushWb: mpFlags.pushWb,
    pushYm: mpFlags.pushYm,
    minMarkupRules: parseMinMarkupRules(src.minMarkupRules ?? src.min_markup_rules),
    highDrrPercent: clampHighDrrPercent(
      src.highDrrPercent ?? src.high_drr_percent,
      HIGH_DRR_DEFAULT_PERCENT
    ),
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
  if (patch.excludeProductIds !== undefined || patch.exclude_product_ids !== undefined) {
    next.excludeProductIds = parsePositiveIntList(
      patch.excludeProductIds ?? patch.exclude_product_ids
    );
  }
  if (patch.pushFbs !== undefined || patch.push_fbs !== undefined) {
    next.pushFbs = parseBoolFlag(patch.pushFbs ?? patch.push_fbs, next.pushFbs);
  }
  if (patch.pushFbo !== undefined || patch.push_fbo !== undefined) {
    next.pushFbo = parseBoolFlag(patch.pushFbo ?? patch.push_fbo, next.pushFbo);
  }
  if (Array.isArray(patch.marketplaces) || Array.isArray(patch.pushMarketplaces)) {
    const flags = parseMarketplaceFlags(patch);
    next.pushOzon = flags.pushOzon;
    next.pushWb = flags.pushWb;
    next.pushYm = flags.pushYm;
  } else {
    if (patch.pushOzon !== undefined || patch.push_ozon !== undefined) {
      next.pushOzon = parseBoolFlag(patch.pushOzon ?? patch.push_ozon, next.pushOzon);
    }
    if (patch.pushWb !== undefined || patch.push_wb !== undefined) {
      next.pushWb = parseBoolFlag(patch.pushWb ?? patch.push_wb, next.pushWb);
    }
    if (patch.pushYm !== undefined || patch.push_ym !== undefined) {
      next.pushYm = parseBoolFlag(patch.pushYm ?? patch.push_ym, next.pushYm);
    }
  }
  if (patch.minMarkupRules !== undefined || patch.min_markup_rules !== undefined) {
    next.minMarkupRules = parseMinMarkupRules(patch.minMarkupRules ?? patch.min_markup_rules);
  }
  if (patch.highDrrPercent !== undefined || patch.high_drr_percent !== undefined) {
    next.highDrrPercent = clampHighDrrPercent(
      patch.highDrrPercent ?? patch.high_drr_percent,
      next.highDrrPercent
    );
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

  // Исключения не должны пересекаться с явным списком отправки
  if (next.excludeProductIds.length && next.productIds.length) {
    const exclude = new Set(next.excludeProductIds);
    next.productIds = next.productIds.filter((id) => !exclude.has(id));
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

  if (settings.excludeProductIds.length) {
    filters.excludeProductIds = settings.excludeProductIds;
  }

  return filters;
}

/**
 * Товар входит в область автоотправки цен профиля?
 * (ручной push-one / schedule после пересчёта тоже должны это учитывать)
 */
export function isProductInPricePushScope(product, settingsRaw) {
  if (!product) return false;
  const s = parsePricePushSettings(settingsRaw);
  const productId = Number(product.id ?? product.product_id);
  if (!Number.isFinite(productId) || productId < 1) return false;

  if (s.excludeProductIds.includes(productId)) return false;

  if (s.scope === PRICE_PUSH_SCOPE_ALL) return true;

  if (s.scope === PRICE_PUSH_SCOPE_PRODUCTS) {
    return s.productIds.includes(productId);
  }

  const catRaw = product.user_category_id ?? product.userCategoryId ?? null;
  const catKey =
    catRaw == null || String(catRaw).trim() === '' ? PRICE_PUSH_CATEGORY_NONE : String(catRaw).trim();
  const inCategory = s.categoryIds.includes(catKey);

  if (s.scope === PRICE_PUSH_SCOPE_CATEGORIES) {
    return inCategory;
  }

  if (s.scope === PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS) {
    return inCategory && s.productIds.includes(productId);
  }

  return true;
}

export function describePricePushScope(settings, { categoryNamesById = {} } = {}) {
  const s = parsePricePushSettings(settings);
  let base = 'все товары';
  if (s.scope === PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS) {
    const catPart = describeCategoryIds(s.categoryIds, categoryNamesById);
    base = `${catPart}, ${s.productIds.length} товар(ов)`;
  } else if (s.scope === PRICE_PUSH_SCOPE_PRODUCTS) {
    base = `выбранные товары (${s.productIds.length})`;
  } else if (s.scope === PRICE_PUSH_SCOPE_CATEGORIES) {
    base = describeCategoryIds(s.categoryIds, categoryNamesById);
  }
  if (s.excludeProductIds.length) {
    base += `, исключений: ${s.excludeProductIds.length}`;
  }
  return base;
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
  if (!s.pushFbs && !s.pushFbo) return 'не отправлять (FBS и FBO выкл.)';
  if (s.pushFbs && s.pushFbo) return 'мин. цены FBS и FBO';
  if (s.pushFbs) return 'мин. цены FBS';
  if (s.pushFbo) return 'мин. цены FBO';
  return 'мин. цены';
}

/** Есть ли хотя бы одна схема для отправки цен на МП. */
export function hasPricePushSchemeEnabled(settings) {
  const s = parsePricePushSettings(settings);
  return s.pushFbs === true || s.pushFbo === true;
}

/** Список включённых МП для пуша: ozon / wb / ym. */
export function enabledPushMarketplaces(settings) {
  const s = parsePricePushSettings(settings);
  const out = [];
  if (s.pushOzon) out.push(PRICE_PUSH_MARKETPLACE_OZON);
  if (s.pushWb) out.push(PRICE_PUSH_MARKETPLACE_WB);
  if (s.pushYm) out.push(PRICE_PUSH_MARKETPLACE_YM);
  return out;
}

/** Есть ли хотя бы один маркетплейс для отправки. */
export function hasPricePushMarketplaceEnabled(settings) {
  return enabledPushMarketplaces(settings).length > 0;
}

/**
 * Пересечение явного списка МП (опционально) с настройками профиля.
 * @returns {string[]|null} null = без ограничения (все включённые в настройках);
 *   [] = ничего не пушить.
 */
export function resolvePushMarketplacesAllowList(settings, requestedMarketplaces = null) {
  const enabled = enabledPushMarketplaces(settings);
  if (!enabled.length) return [];
  if (!Array.isArray(requestedMarketplaces)) return enabled;
  const want = new Set(
    requestedMarketplaces.map(normalizeMarketplaceKey).filter(Boolean)
  );
  if (!want.size) return [];
  return enabled.filter((mp) => want.has(mp));
}

export function describePricePushMarketplaces(settings) {
  const list = enabledPushMarketplaces(settings);
  if (!list.length) return 'не отправлять (все МП выкл.)';
  const labels = {
    [PRICE_PUSH_MARKETPLACE_OZON]: 'Ozon',
    [PRICE_PUSH_MARKETPLACE_WB]: 'WB',
    [PRICE_PUSH_MARKETPLACE_YM]: 'Яндекс',
  };
  if (list.length === PRICE_PUSH_MARKETPLACES.length) return 'все МП';
  return list.map((mp) => labels[mp] || mp).join(', ');
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
