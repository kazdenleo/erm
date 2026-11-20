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

function emptyMpModes() {
  return { pushMinPrice: false, pushSellingPrice: false };
}

function parseMpModeRow(row, { allowMin = true } = {}) {
  const src = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  const min = parseBoolFlag(src.pushMinPrice ?? src.min ?? src.push_min_price, false);
  const selling = parseBoolFlag(
    src.pushSellingPrice ?? src.selling ?? src.push_selling_price,
    false
  );
  return {
    pushMinPrice: allowMin ? min === true : false,
    pushSellingPrice: selling === true,
  };
}

/**
 * Что пушить глобально (legacy): мин. цена и/или продажная.
 * Legacy syncSellingPriceToMin=true → оба вкл.; false → только мин.
 */
function parsePushPriceModes(src) {
  const hasNew =
    'pushMinPrice' in src ||
    'push_min_price' in src ||
    'pushSellingPrice' in src ||
    'push_selling_price' in src;
  if (hasNew) {
    return {
      pushMinPrice: parseBoolFlag(src.pushMinPrice ?? src.push_min_price, true),
      pushSellingPrice: parseBoolFlag(src.pushSellingPrice ?? src.push_selling_price, false),
    };
  }
  if ('syncSellingPriceToMin' in src || 'sync_selling_price_to_min' in src) {
    const sync = parseBoolFlag(src.syncSellingPriceToMin ?? src.sync_selling_price_to_min, false);
    return { pushMinPrice: true, pushSellingPrice: sync };
  }
  return { pushMinPrice: true, pushSellingPrice: false };
}

/**
 * Режимы по МП. WB/YM: мин. цена в API нет → pushMinPrice всегда false.
 * Без marketplacePush — миграция из pushOzon/pushMinPrice/…
 */
function parseMarketplacePush(src) {
  if (src.marketplacePush && typeof src.marketplacePush === 'object') {
    const mp = src.marketplacePush;
    return {
      ozon: parseMpModeRow(mp.ozon, { allowMin: true }),
      wb: parseMpModeRow(mp.wb, { allowMin: false }),
      ym: parseMpModeRow(mp.ym, { allowMin: false }),
    };
  }
  const modes = parsePushPriceModes(src);
  const flags = parseMarketplaceFlags(src);
  return {
    ozon: {
      pushMinPrice: flags.pushOzon === true && modes.pushMinPrice === true,
      pushSellingPrice: flags.pushOzon === true && modes.pushSellingPrice === true,
    },
    wb: {
      pushMinPrice: false,
      pushSellingPrice: flags.pushWb === true && modes.pushSellingPrice === true,
    },
    ym: {
      pushMinPrice: false,
      pushSellingPrice: flags.pushYm === true && modes.pushSellingPrice === true,
    },
  };
}

function deriveMpFlags(marketplacePush) {
  const ozonOn =
    marketplacePush.ozon.pushMinPrice === true || marketplacePush.ozon.pushSellingPrice === true;
  const wbOn =
    marketplacePush.wb.pushMinPrice === true || marketplacePush.wb.pushSellingPrice === true;
  const ymOn =
    marketplacePush.ym.pushMinPrice === true || marketplacePush.ym.pushSellingPrice === true;
  return {
    pushOzon: ozonOn,
    pushWb: wbOn,
    pushYm: ymOn,
    pushMinPrice:
      marketplacePush.ozon.pushMinPrice === true ||
      marketplacePush.wb.pushMinPrice === true ||
      marketplacePush.ym.pushMinPrice === true,
    pushSellingPrice:
      marketplacePush.ozon.pushSellingPrice === true ||
      marketplacePush.wb.pushSellingPrice === true ||
      marketplacePush.ym.pushSellingPrice === true,
  };
}

export function parsePricePushSettings(raw) {
  const src = parseObject(raw);
  const scopeRaw = String(src.scope || PRICE_PUSH_SCOPE_ALL).trim();
  const scope = SCOPES.has(scopeRaw) ? scopeRaw : PRICE_PUSH_SCOPE_ALL;
  // Обе схемы могут быть выключены — «не отправлять цены на МП» по схемам.
  const pushFbs = parseBoolFlag(src.pushFbs ?? src.push_fbs, true);
  const pushFbo = parseBoolFlag(src.pushFbo ?? src.push_fbo, true);
  const marketplacePush = parseMarketplacePush(src);
  const derived = deriveMpFlags(marketplacePush);
  return {
    scope,
    categoryIds: parseCategoryIdList(src.categoryIds),
    productIds: parsePositiveIntList(src.productIds),
    excludeProductIds: parsePositiveIntList(src.excludeProductIds ?? src.exclude_product_ids),
    pushFbs,
    pushFbo,
    marketplacePush,
    pushOzon: derived.pushOzon,
    pushWb: derived.pushWb,
    pushYm: derived.pushYm,
    pushMinPrice: derived.pushMinPrice,
    pushSellingPrice: derived.pushSellingPrice,
    minMarkupRules: parseMinMarkupRules(src.minMarkupRules ?? src.min_markup_rules),
    highDrrPercent: clampHighDrrPercent(
      src.highDrrPercent ?? src.high_drr_percent,
      HIGH_DRR_DEFAULT_PERCENT
    ),
  };
}

/** Режимы пуша для одного МП из настроек профиля. */
export function resolveMarketplacePushModes(settingsRaw, marketplace) {
  const s =
    settingsRaw && typeof settingsRaw === 'object' && settingsRaw.marketplacePush
      ? settingsRaw
      : parsePricePushSettings(settingsRaw);
  const key = normalizeMarketplaceKey(marketplace) || String(marketplace || '').toLowerCase();
  const row = s.marketplacePush?.[key] || emptyMpModes();
  if (key === PRICE_PUSH_MARKETPLACE_WB || key === PRICE_PUSH_MARKETPLACE_YM) {
    return { pushMinPrice: false, pushSellingPrice: row.pushSellingPrice === true };
  }
  return {
    pushMinPrice: row.pushMinPrice === true,
    pushSellingPrice: row.pushSellingPrice === true,
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
  if (patch.marketplacePush && typeof patch.marketplacePush === 'object') {
    const mp = patch.marketplacePush;
    next.marketplacePush = {
      ozon: parseMpModeRow(
        { ...next.marketplacePush.ozon, ...(mp.ozon && typeof mp.ozon === 'object' ? mp.ozon : {}) },
        { allowMin: true }
      ),
      wb: parseMpModeRow(
        { ...next.marketplacePush.wb, ...(mp.wb && typeof mp.wb === 'object' ? mp.wb : {}) },
        { allowMin: false }
      ),
      ym: parseMpModeRow(
        { ...next.marketplacePush.ym, ...(mp.ym && typeof mp.ym === 'object' ? mp.ym : {}) },
        { allowMin: false }
      ),
    };
  } else {
    // Legacy: отдельные флаги МП / глобальные режимы → раскладываем в marketplacePush.
    let mp = { ...next.marketplacePush };
    const modes = {
      pushMinPrice: next.pushMinPrice,
      pushSellingPrice: next.pushSellingPrice,
    };
    if (
      patch.pushMinPrice !== undefined ||
      patch.push_min_price !== undefined ||
      patch.pushSellingPrice !== undefined ||
      patch.push_selling_price !== undefined ||
      patch.syncSellingPriceToMin !== undefined ||
      patch.sync_selling_price_to_min !== undefined
    ) {
      const parsed = parsePushPriceModes({ ...next, ...patch });
      modes.pushMinPrice = parsed.pushMinPrice;
      modes.pushSellingPrice = parsed.pushSellingPrice;
    }
    let ozonOn = next.pushOzon;
    let wbOn = next.pushWb;
    let ymOn = next.pushYm;
    if (Array.isArray(patch.marketplaces) || Array.isArray(patch.pushMarketplaces)) {
      const flags = parseMarketplaceFlags(patch);
      ozonOn = flags.pushOzon;
      wbOn = flags.pushWb;
      ymOn = flags.pushYm;
    } else {
      if (patch.pushOzon !== undefined || patch.push_ozon !== undefined) {
        ozonOn = parseBoolFlag(patch.pushOzon ?? patch.push_ozon, ozonOn);
      }
      if (patch.pushWb !== undefined || patch.push_wb !== undefined) {
        wbOn = parseBoolFlag(patch.pushWb ?? patch.push_wb, wbOn);
      }
      if (patch.pushYm !== undefined || patch.push_ym !== undefined) {
        ymOn = parseBoolFlag(patch.pushYm ?? patch.push_ym, ymOn);
      }
    }
    mp = {
      ozon: {
        pushMinPrice: ozonOn === true && modes.pushMinPrice === true,
        pushSellingPrice: ozonOn === true && modes.pushSellingPrice === true,
      },
      wb: {
        pushMinPrice: false,
        pushSellingPrice: wbOn === true && modes.pushSellingPrice === true,
      },
      ym: {
        pushMinPrice: false,
        pushSellingPrice: ymOn === true && modes.pushSellingPrice === true,
      },
    };
    next.marketplacePush = mp;
  }
  Object.assign(next, deriveMpFlags(next.marketplacePush));
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

/** Есть ли что отправлять: мин. цена и/или продажная хотя бы на одном МП. */
export function hasPricePushContentEnabled(settings) {
  const s = parsePricePushSettings(settings);
  return s.pushMinPrice === true || s.pushSellingPrice === true;
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
