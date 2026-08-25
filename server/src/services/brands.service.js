/**
 * Brands Service — сопоставления с МП, подсказки из каталога
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';

const MP_KEYS = ['ozon', 'wb', 'ym'];

function normalizeMpKey(marketplace) {
  const m = String(marketplace || '').trim().toLowerCase();
  if (m === 'wildberries') return 'wb';
  if (m === 'yandex' || m === 'yandexmarket') return 'ym';
  return m;
}

function parseMarketplaceMappings(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return typeof p === 'object' && p ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

function pickOzonPairFromMappings(mm) {
  const oz = mm?.ozon ?? mm?.Ozon ?? null;
  if (!oz || typeof oz !== 'object') return null;
  const descId = Number(oz.description_category_id ?? oz.descriptionCategoryId ?? oz.desc_id ?? 0);
  const typeId = Number(oz.type_id ?? oz.typeId ?? 0);
  if (descId > 0 && typeId > 0) return { descId, typeId };
  const composite = String(oz.category_id ?? oz.categoryId ?? oz.id ?? '').trim();
  const m = /^(\d+)[_:\-](\d+)$/.exec(composite);
  if (m) {
    const d = Number(m[1]);
    const t = Number(m[2]);
    if (d > 0 && t > 0) return { descId: d, typeId: t };
  }
  return null;
}

export async function attachBrandDetails(brand) {
  if (!brand?.id) return brand;
  const repo = repositoryFactory.getBrandsRepository();
  const mappings = repo?.findMarketplaceMappings
    ? await repo.findMarketplaceMappings(brand.id)
    : [];
  return {
    ...brand,
    marketplace_mappings: mappings,
    ozon_brand_promotion_enabled: brand.ozon_brand_promotion_enabled === true,
    manufacturer_country: brand.manufacturer_country ?? null,
  };
}

/**
 * Кандидаты названий бренда с МП из товаров аккаунта.
 */
export async function collectMpBrandCandidatesFromProducts(brandId, profileId) {
  const bid = Number(brandId);
  const pid = Number(profileId);
  if (!Number.isFinite(bid) || bid < 1) return { ozon: [], wb: [], ym: [] };

  const profileSql = Number.isFinite(pid) && pid > 0 ? ' AND p.profile_id = $2' : '';
  const params = Number.isFinite(pid) && pid > 0 ? [bid, pid] : [bid];

  const r = await query(
    `SELECT
       NULLIF(TRIM(p.mp_ozon_brand), '') AS ozon_name,
       NULLIF(TRIM(p.mp_wb_brand), '') AS wb_name,
       COUNT(*)::int AS cnt
     FROM products p
     WHERE p.brand_id = $1${profileSql}
     GROUP BY 1, 2`,
    params
  );

  const ozonMap = new Map();
  const wbMap = new Map();
  for (const row of r.rows || []) {
    if (row.ozon_name) {
      const k = row.ozon_name;
      ozonMap.set(k, (ozonMap.get(k) || 0) + Number(row.cnt) || 0);
    }
    if (row.wb_name) {
      const k = row.wb_name;
      wbMap.set(k, (wbMap.get(k) || 0) + Number(row.cnt) || 0);
    }
  }

  const toList = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, source: 'products' }));

  return {
    ozon: toList(ozonMap),
    wb: toList(wbMap),
    ym: [],
  };
}

async function resolveOzonCategoryPairForBrand(brandId, profileId) {
  const bid = Number(brandId);
  const pid = Number(profileId);
  const r = await query(
    `SELECT uc.marketplace_mappings
     FROM products p
     JOIN user_categories uc ON uc.id = p.user_category_id
     WHERE p.brand_id = $1
       ${Number.isFinite(pid) && pid > 0 ? 'AND p.profile_id = $2' : ''}
     ORDER BY p.updated_at DESC NULLS LAST
     LIMIT 20`,
    Number.isFinite(pid) && pid > 0 ? [bid, pid] : [bid]
  );
  for (const row of r.rows || []) {
    const pair = pickOzonPairFromMappings(parseMarketplaceMappings(row.marketplace_mappings));
    if (pair) return pair;
  }

  if (Number.isFinite(pid) && pid > 0) {
    const r2 = await query(
      `SELECT marketplace_mappings FROM user_categories
       WHERE profile_id = $1 AND marketplace_mappings IS NOT NULL
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 30`,
      [pid]
    );
    for (const row of r2.rows || []) {
      const pair = pickOzonPairFromMappings(parseMarketplaceMappings(row.marketplace_mappings));
      if (pair) return pair;
    }
  }
  return null;
}

/**
 * Поиск бренда Ozon (атрибут 85) + кандидаты из товаров.
 */
export async function suggestOzonBrandMapping(brand, profileId) {
  const name = String(brand?.name || '').trim();
  if (!name) return { candidates: [], pair: null };

  const fromProducts = await collectMpBrandCandidatesFromProducts(brand.id, profileId);
  const candidates = [...(fromProducts.ozon || [])];

  const pair = await resolveOzonCategoryPairForBrand(brand.id, profileId);
  if (pair) {
    try {
      const found = await integrationsService.searchOzonAttributeValues(85, pair.descId, pair.typeId, name);
      for (const item of found || []) {
        const mpName = String(item.value ?? item.name ?? '').trim();
        const mpId = item.id != null ? String(item.id) : item.dictionary_value_id != null ? String(item.dictionary_value_id) : null;
        if (!mpName) continue;
        if (!candidates.some((c) => c.name.toLowerCase() === mpName.toLowerCase())) {
          candidates.unshift({
            name: mpName,
            mp_brand_id: mpId,
            count: 0,
            source: 'ozon_api',
          });
        }
      }
    } catch {
      /* API недоступен — остаются кандидаты из товаров */
    }
  }

  return { candidates, pair };
}

export async function syncBrandMappingsFromCatalog(brandId, profileId, { apply = true } = {}) {
  const repo = repositoryFactory.getBrandsRepository();
  const brand = await repo.findById(brandId);
  if (!brand) {
    const err = new Error('Бренд не найден');
    err.statusCode = 404;
    throw err;
  }

  const fromProducts = await collectMpBrandCandidatesFromProducts(brandId, profileId);
  const ozonSuggest = await suggestOzonBrandMapping(brand, profileId);
  let wbFromDir = [];
  try {
    wbFromDir = await integrationsService.getWildberriesBrands({
      q: brand.name,
      profileId,
    });
  } catch {
    wbFromDir = [];
  }
  const wbCandidates = [
    ...wbFromDir.map((b) => ({
      name: b.name,
      mp_brand_id: b.id,
      count: 0,
      source: 'wb_directory',
    })),
    ...(fromProducts.wb || []),
  ];

  const suggestions = {
    ozon: ozonSuggest.candidates,
    wb: wbCandidates,
    ym: fromProducts.ym,
    ozon_category_pair: ozonSuggest.pair,
  };

  if (!apply) return { suggestions, applied: [] };

  const applied = [];
  const upsert = async (marketplace, top) => {
    if (!top?.name) return;
    const row = await repo.upsertMarketplaceMapping(brandId, marketplace, {
      mp_brand_name: top.name,
      mp_brand_id: top.mp_brand_id ?? null,
      mp_meta: { source: top.source || 'sync' },
    });
    if (row) applied.push({ marketplace, ...row });
  };

  await upsert('ozon', ozonSuggest.candidates[0]);
  await upsert('wb', wbCandidates[0]);

  return { suggestions, applied };
}

export function normalizeMappingsPayload(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const raw of items) {
    const marketplace = normalizeMpKey(raw.marketplace);
    if (!MP_KEYS.includes(marketplace)) continue;
    out.push({
      marketplace,
      mp_brand_name: raw.mp_brand_name ?? raw.mpBrandName ?? null,
      mp_brand_id: raw.mp_brand_id ?? raw.mpBrandId ?? null,
      mp_meta: raw.mp_meta ?? raw.mpMeta ?? null,
    });
  }
  return out;
}

function promoSettingsChanged(updates, prev) {
  const keys = [
    'ozonBrandPromotionEnabled',
    'ozon_brand_promotion_enabled',
    'ozonBrandPromotionPercent',
    'ozon_brand_promotion_percent',
  ];
  if (!keys.some((k) => Object.prototype.hasOwnProperty.call(updates, k))) return false;
  const enabled =
    updates.ozonBrandPromotionEnabled ?? updates.ozon_brand_promotion_enabled ?? prev?.ozon_brand_promotion_enabled;
  const percent =
    updates.ozonBrandPromotionPercent ?? updates.ozon_brand_promotion_percent ?? prev?.ozon_brand_promotion_percent;
  return (
    enabled !== prev?.ozon_brand_promotion_enabled ||
    String(percent ?? '') !== String(prev?.ozon_brand_promotion_percent ?? '')
  );
}

/** Фоновый пересчёт мин. цен Ozon для товаров бренда (из кэша калькулятора). */
export function scheduleOzonMinPriceRecalcForBrand(brandId) {
  const bid = Number(brandId);
  if (!Number.isFinite(bid) || bid < 1) return;

  setImmediate(async () => {
    try {
      const pricesService = (await import('./prices.service.js')).default;
      const r = await query(
        `SELECT id FROM products
         WHERE brand_id = $1 AND COALESCE(is_archived, false) = false
         ORDER BY id`,
        [bid]
      );
      for (const row of r.rows || []) {
        try {
          await pricesService.recalculateAndSaveForProduct(row.id, { useCalculatorCache: true });
        } catch (e) {
          console.warn(`[Brands Service] Ozon min price recalc failed for product ${row.id}:`, e.message);
        }
      }
      console.log(`[Brands Service] Ozon min price recalc finished for brand ${bid}, products: ${r.rows?.length ?? 0}`);
    } catch (e) {
      console.warn('[Brands Service] Ozon min price recalc schedule failed:', e.message);
    }
  });
}

export { promoSettingsChanged };

export default {
  attachBrandDetails,
  collectMpBrandCandidatesFromProducts,
  suggestOzonBrandMapping,
  syncBrandMappingsFromCatalog,
  normalizeMappingsPayload,
  scheduleOzonMinPriceRecalcForBrand,
  promoSettingsChanged,
};
