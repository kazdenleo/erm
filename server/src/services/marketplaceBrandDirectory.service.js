/**
 * Справочники брендов МП: поиск для формы бренда, ночное обновление.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import directoryRepo from '../repositories/marketplace_brand_directory.repository.pg.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';
import {
  MP_BRAND_MARKETPLACES,
  brandNameNorm,
  normalizeBrandName,
  normalizeDirectoryBrandEntries,
  normalizeMpBrandMarketplace,
  rankDirectoryBrands,
} from '../utils/marketplaceBrandDirectory.js';

const OZON_BRAND_ATTR_ID = 85;
const WB_PREFIXES = [
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'абвгдежзийклмнопрстуфхцчшщэюя'.split(''),
  ...'0123456789'.split(''),
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function listProfileIds() {
  const r = await query('SELECT id FROM profiles ORDER BY id');
  return (r.rows || []).map((row) => Number(row.id)).filter((n) => Number.isFinite(n) && n > 0);
}

async function collectSearchSeeds(profileId) {
  const pid = Number(profileId);
  const seeds = new Set();
  const r = await query(
    `SELECT TRIM(b.name) AS name
     FROM brands b
     WHERE b.profile_id = $1 AND TRIM(COALESCE(b.name, '')) <> ''
     UNION
     SELECT TRIM(bmm.mp_brand_name)
     FROM brand_marketplace_mappings bmm
     JOIN brands b ON b.id = bmm.brand_id
     WHERE b.profile_id = $1 AND TRIM(COALESCE(bmm.mp_brand_name, '')) <> ''
     UNION
     SELECT TRIM(p.mp_wb_brand)
     FROM products p
     WHERE p.profile_id = $1 AND TRIM(COALESCE(p.mp_wb_brand, '')) <> ''
     UNION
     SELECT TRIM(p.mp_ozon_brand)
     FROM products p
     WHERE p.profile_id = $1 AND TRIM(COALESCE(p.mp_ozon_brand, '')) <> ''
     UNION
     SELECT TRIM(p.ym_draft->>'vendor')
     FROM products p
     WHERE p.profile_id = $1 AND TRIM(COALESCE(p.ym_draft->>'vendor', '')) <> ''`,
    [pid]
  );
  for (const row of r.rows || []) {
    const name = normalizeBrandName(row.name);
    if (name) seeds.add(name);
  }
  return [...seeds];
}

async function findOzonCategoryPairs(profileId, limit = 8) {
  const pid = Number(profileId);
  const out = [];
  const seen = new Set();
  const r = await query(
    `SELECT uc.marketplace_mappings
     FROM user_categories uc
     WHERE uc.profile_id = $1 AND uc.marketplace_mappings IS NOT NULL
     ORDER BY uc.updated_at DESC NULLS LAST
     LIMIT 80`,
    [pid]
  );
  for (const row of r.rows || []) {
    const pair = pickOzonPairFromMappings(parseMarketplaceMappings(row.marketplace_mappings));
    if (!pair) continue;
    const key = `${pair.descId}:${pair.typeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
    if (out.length >= limit) break;
  }
  return out;
}

async function profileHasMarketplace(profileId, marketplace) {
  const type = marketplace === 'wb' ? 'wildberries' : marketplace === 'ym' ? 'yandex' : marketplace;
  try {
    const cfg = await integrationsService.getMarketplaceConfig(type, { profileId });
    if (marketplace === 'ozon') return integrationsService._hasOzonCredentials(cfg);
    if (marketplace === 'wb') return integrationsService._hasWbCredentials(cfg);
    if (marketplace === 'ym') return integrationsService._hasYandexCredentials(cfg);
  } catch {
    return false;
  }
  return false;
}

async function upsertAndCount(profileId, marketplace, items, source) {
  const list = normalizeDirectoryBrandEntries(items);
  if (!list.length) return 0;
  return directoryRepo.upsertMany(profileId, marketplace, list, source);
}

/**
 * Поиск бренда в локальном справочнике; при малом числе совпадений — живой запрос к МП.
 */
export async function searchMarketplaceBrands(opts = {}) {
  const marketplace = normalizeMpBrandMarketplace(opts.marketplace || opts.mp);
  const q = normalizeBrandName(opts.q ?? opts.pattern ?? opts.name ?? '');
  const profileId = Number(opts.profileId ?? opts.profile_id) || 0;
  if (!MP_BRAND_MARKETPLACES.includes(marketplace) || q.length < 1) return [];

  let local = [];
  if (profileId > 0) {
    try {
      local = await directoryRepo.search({ profileId, marketplace, q, limit: 50 });
    } catch (e) {
      logger.debug('[MP brand dir] local search failed', e?.message);
    }
  }

  const needLive = q.length >= 1 && local.length < 5 && opts.live !== false;
  let live = [];
  if (needLive) {
    try {
      if (marketplace === 'wb') {
        live = await integrationsService.fetchWildberriesBrandsFromApi({
          q,
          subjectId: opts.subjectId ?? opts.subject_id,
          profileId: profileId || null,
          organizationId: opts.organizationId ?? opts.organization_id ?? null,
        });
      } else if (marketplace === 'ozon' && profileId > 0) {
        live = await searchOzonBrandsLive(q, profileId, opts);
      }
    } catch (e) {
      logger.debug('[MP brand dir] live search failed', { marketplace, err: e?.message });
    }
    if (profileId > 0 && live.length) {
      upsertAndCount(profileId, marketplace, live, 'api').catch(() => {});
    }
  }

  return rankDirectoryBrands([...local, ...live], q, 50);
}

async function searchOzonBrandsLive(q, profileId, opts = {}) {
  let pair = null;
  const descId = Number(opts.descriptionCategoryId ?? opts.description_category_id ?? 0);
  const typeId = Number(opts.typeId ?? opts.type_id ?? 0);
  if (descId > 0 && typeId > 0) pair = { descId, typeId };
  if (!pair) {
    const pairs = await findOzonCategoryPairs(profileId, 1);
    pair = pairs[0] || null;
  }
  if (!pair) return [];
  const found = await integrationsService.searchOzonAttributeValues(
    OZON_BRAND_ATTR_ID,
    pair.descId,
    pair.typeId,
    q,
    { profileId }
  );
  return normalizeDirectoryBrandEntries(found);
}

async function refreshWbForProfile(profileId, seeds) {
  if (!(await profileHasMarketplace(profileId, 'wb'))) {
    return { saved: 0, queries: 0, skipped: true };
  }
  const queries = [];
  for (const seed of seeds) {
    if (seed) queries.push(seed);
  }
  for (const prefix of WB_PREFIXES) queries.push(prefix);

  const seenQ = new Set();
  let saved = 0;
  let used = 0;
  const maxCalls = 180;
  for (const q of queries) {
    if (used >= maxCalls) break;
    const key = brandNameNorm(q);
    if (!key || seenQ.has(key)) continue;
    seenQ.add(key);
    used += 1;
    try {
      const list = await integrationsService.fetchWildberriesBrandsFromApi({
        q,
        profileId,
        skipErpAliases: true,
      });
      saved += await upsertAndCount(profileId, 'wb', list, 'api');
    } catch (e) {
      logger.debug('[MP brand dir] WB query failed', { q, err: e?.message });
    }
    await sleep(220);
  }
  return { saved, queries: used, skipped: false };
}

async function refreshOzonForProfile(profileId, seeds) {
  if (!(await profileHasMarketplace(profileId, 'ozon'))) {
    return { saved: 0, pages: 0, skipped: true };
  }
  const pairs = await findOzonCategoryPairs(profileId, 3);
  if (!pairs.length) {
    return { saved: 0, pages: 0, skipped: true, reason: 'no_category' };
  }

  let saved = 0;
  let pages = 0;
  const maxPagesPerPair = 80;

  for (const pair of pairs) {
    let lastValueId = 0;
    for (let page = 0; page < maxPagesPerPair; page += 1) {
      let result;
      try {
        result = await integrationsService.getOzonAttributeValues(
          OZON_BRAND_ATTR_ID,
          pair.descId,
          pair.typeId,
          { last_value_id: lastValueId, limit: 500, forceRefresh: true, profileId }
        );
      } catch (e) {
        logger.debug('[MP brand dir] Ozon page failed', { pair, err: e?.message });
        break;
      }
      const list = Array.isArray(result?.result) ? result.result : [];
      pages += 1;
      saved += await upsertAndCount(profileId, 'ozon', list, 'api');
      if (!list.length || !result?.has_next) break;
      const last = list[list.length - 1];
      const nextId = Number(last?.id ?? last?.dictionary_value_id ?? 0);
      if (!Number.isFinite(nextId) || nextId <= lastValueId) break;
      lastValueId = nextId;
      await sleep(180);
    }
  }

  const searchPair = pairs[0];
  for (const seed of seeds.slice(0, 80)) {
    try {
      const found = await integrationsService.searchOzonAttributeValues(
        OZON_BRAND_ATTR_ID,
        searchPair.descId,
        searchPair.typeId,
        seed,
        { profileId }
      );
      saved += await upsertAndCount(profileId, 'ozon', found, 'api');
    } catch (e) {
      logger.debug('[MP brand dir] Ozon search failed', { seed, err: e?.message });
    }
    await sleep(150);
  }

  return { saved, pages, skipped: false };
}

async function collectYmSeeds(profileId) {
  const pid = Number(profileId);
  const r = await query(
    `SELECT TRIM(b.name) AS name
     FROM brands b
     WHERE b.profile_id = $1 AND TRIM(COALESCE(b.name, '')) <> ''
     UNION
     SELECT TRIM(bmm.mp_brand_name)
     FROM brand_marketplace_mappings bmm
     JOIN brands b ON b.id = bmm.brand_id
     WHERE b.profile_id = $1 AND bmm.marketplace = 'ym' AND TRIM(COALESCE(bmm.mp_brand_name, '')) <> ''
     UNION
     SELECT TRIM(p.ym_draft->>'vendor')
     FROM products p
     WHERE p.profile_id = $1 AND TRIM(COALESCE(p.ym_draft->>'vendor', '')) <> ''`,
    [pid]
  );
  return [...new Set((r.rows || []).map((row) => normalizeBrandName(row.name)).filter(Boolean))];
}

async function refreshYmForProfile(profileId, seeds) {
  const harvested = (seeds || []).map((name) => ({ name, id: null }));
  const saved = await upsertAndCount(profileId, 'ym', harvested, 'harvest');
  return { saved, skipped: false };
}

export async function refreshMarketplaceBrandDirectories({ profileId = null } = {}) {
  const ids = profileId != null && Number(profileId) > 0 ? [Number(profileId)] : await listProfileIds();
  const summary = { profiles: 0, wb: 0, ozon: 0, ym: 0, errors: 0 };

  for (const pid of ids) {
    summary.profiles += 1;
    let seeds = [];
    try {
      seeds = await collectSearchSeeds(pid);
      const mappingRows = seeds.map((name) => ({ name, id: null }));
      await upsertAndCount(pid, 'wb', mappingRows, 'harvest');
      await upsertAndCount(pid, 'ozon', mappingRows, 'harvest');
    } catch (e) {
      logger.warn('[MP brand dir] seeds failed', { profileId: pid, err: e?.message });
    }

    try {
      const wb = await refreshWbForProfile(pid, seeds);
      summary.wb += wb.saved || 0;
    } catch (e) {
      summary.errors += 1;
      logger.warn('[MP brand dir] WB refresh failed', { profileId: pid, err: e?.message });
    }

    try {
      const oz = await refreshOzonForProfile(pid, seeds);
      summary.ozon += oz.saved || 0;
    } catch (e) {
      summary.errors += 1;
      logger.warn('[MP brand dir] Ozon refresh failed', { profileId: pid, err: e?.message });
    }

    try {
      const ymSeeds = await collectYmSeeds(pid);
      const ym = await refreshYmForProfile(pid, ymSeeds);
      summary.ym += ym.saved || 0;
    } catch (e) {
      summary.errors += 1;
      logger.warn('[MP brand dir] YM refresh failed', { profileId: pid, err: e?.message });
    }
  }

  logger.info('[MP brand dir] nightly refresh done', summary);
  return summary;
}

async function findBrandIdForProduct(product) {
  const brandId = Number(product?.brand_id ?? product?.brandId);
  if (Number.isFinite(brandId) && brandId > 0) return brandId;
  const name = normalizeBrandName(product?.brand ?? product?.brand_name);
  if (!name) return null;
  const pid = Number(product?.profile_id ?? product?.profileId);
  const params = [name];
  let sql = `SELECT id FROM brands WHERE LOWER(TRIM(name)) = LOWER($1)`;
  if (Number.isFinite(pid) && pid > 0) {
    sql += ' AND profile_id = $2';
    params.push(pid);
  }
  sql += ' ORDER BY id LIMIT 1';
  const r = await query(sql, params);
  const id = Number(r.rows?.[0]?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function mappingFromRow(row) {
  if (!row) return null;
  const name = normalizeBrandName(row.mp_brand_name ?? row.mpBrandName);
  const id = row.mp_brand_id ?? row.mpBrandId ?? null;
  if (!name && (id == null || String(id).trim() === '')) return null;
  return {
    name: name || null,
    id: id != null && String(id).trim() !== '' ? String(id).trim() : null,
  };
}

export async function resolveMappedBrand(product, marketplace) {
  const mp = normalizeMpBrandMarketplace(marketplace);
  if (!mp || !MP_BRAND_MARKETPLACES.includes(mp)) return null;
  try {
    const repo = repositoryFactory.getBrandsRepository();
    const brandId = await findBrandIdForProduct(product);
    if (Number.isFinite(brandId) && brandId > 0 && repo?.findMarketplaceMappings) {
      const mappings = await repo.findMarketplaceMappings(brandId);
      const hit = mappingFromRow(
        (mappings || []).find((m) => normalizeMpBrandMarketplace(m.marketplace) === mp)
      );
      if (hit) return hit;
    }

    const name = normalizeBrandName(product?.brand ?? product?.brand_name);
    const pid = Number(product?.profile_id ?? product?.profileId);
    if (!name) return null;
    const params = [mp, name];
    let sql = `SELECT bmm.mp_brand_name, bmm.mp_brand_id
       FROM brand_marketplace_mappings bmm
       JOIN brands b ON b.id = bmm.brand_id
       WHERE bmm.marketplace = $1
         AND LOWER(TRIM(b.name)) = LOWER($2)
         AND TRIM(COALESCE(bmm.mp_brand_name, '')) <> ''`;
    if (Number.isFinite(pid) && pid > 0) {
      sql += ' AND b.profile_id = $3';
      params.push(pid);
    }
    sql += ' ORDER BY bmm.updated_at DESC NULLS LAST LIMIT 1';
    const r = await query(sql, params);
    return mappingFromRow(r.rows?.[0]);
  } catch (e) {
    logger.warn('[MP brand dir] mapping lookup:', e?.message || e);
    return null;
  }
}

export default {
  searchMarketplaceBrands,
  refreshMarketplaceBrandDirectories,
  resolveMappedBrand,
};
