/**
 * Products Service
 * Бизнес-логика для работы с товарами
 */

import repositoryFactory from '../config/repository-factory.js';
import {
  stockListOnHandQuantity,
  stockListReservedQuantity,
  stockListAvailableQuantity
} from '../repositories/products.repository.pg.js';
import { query } from '../config/database.js';
import { resolveProfileKitsEnabled } from '../utils/profileFeatureFlags.js';
import { isProfileSupplierSyncEnabled } from '../utils/profileSupplierSync.js';
import pricesService from './prices.service.js';
import integrationsService from './integrations.service.js';
import {
  buildProductsExcelBuffer,
  normalizeProductExportOptions,
  buildMpAttributeCacheScope,
  filterMpAttributeCachesByCategoryScope,
  filterMpDictValueCachesForOzonCategoryScope,
  filterMpCachesForExport,
  filterMpDictValueCachesForExport,
  parseUserCategoryMarketplaceMappings,
  resolveOzonDescTypePair
} from './productsExport.service.js';
import { importProductImagesFromExcelUrls } from './productImagesImport.service.js';
import {
  parseProductsImportWorkbook,
  mapImportRowToApiPayload,
  parseRowProductId,
  buildOzonDictionaryLabelToValueIdMap,
  buildOzonDictionaryIdToLabelMap,
  resolveOzonAttributesDictionaryLabels
} from './productsImport.service.js';
import { resolveMarketplaceListingByErpSku } from './productMarketplaceLink.service.js';
import { sanitizeWbVendorCode } from '../utils/wbVendorCode.js';
import marketplaceProductCardPush from './marketplaceProductCardPush.service.js';
import {
  getProductParticipation,
  getProductParticipationBatch,
  buildProductDeleteBlockedMessage,
} from './productParticipation.service.js';
import { barcodeStringsFromProduct, normalizeBarcodeRows } from '../utils/productBarcodes.js';

const MAX_EXPORT_PRODUCTS = 25000;

function parseWbDraftColumn(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function patchWbNmIdDraft(existingDraft, nmId) {
  const draft = existingDraft && typeof existingDraft === 'object' ? { ...existingDraft } : {};
  const nm = nmId != null && String(nmId).trim() !== '' && /^\d+$/.test(String(nmId).trim())
    ? String(nmId).trim()
    : null;
  if (nm) {
    draft.nmId = nm;
    draft.nmID = nm;
  } else {
    delete draft.nmId;
    delete draft.nmID;
    delete draft.nm_id;
  }
  return Object.keys(draft).length > 0 ? draft : null;
}

function pickNumericMarketplaceId(...values) {
  for (const v of values) {
    const s = v != null ? String(v).trim() : '';
    if (s && /^\d+$/.test(s)) return s;
  }
  return null;
}

function normalizeQuestionMarketplaceCode(marketplace) {
  const s = String(marketplace || '').toLowerCase();
  if (s === 'ozon') return 'ozon';
  if (s === 'wildberries' || s === 'wb') return 'wb';
  if (s === 'yandex' || s === 'ym') return 'ym';
  return s || null;
}

/** Номер карточки на МП из полей товара ERP (как на фронте в questionsDisplay). */
function pickProductMarketplaceNumber(product, marketplace) {
  if (!product) return null;
  const mp = normalizeQuestionMarketplaceCode(marketplace);
  if (mp === 'ozon') {
    // Ozon: для покупателя — поле sku из API (не product_id / id).
    return pickNumericMarketplaceId(product.ozon_market_sku);
  }
  if (mp === 'wb') {
    return pickNumericMarketplaceId(product.sku_wb, product.wb_nmid, product.nmId, product.nm_id);
  }
  if (mp === 'ym') {
    return pickNumericMarketplaceId(
      product.ym_market_sku,
      product.ym_product_id,
      product.marketplace_ym_product_id,
      product.marketSku,
      product.market_sku
    );
  }
  return null;
}

function pickOzonMarketSkuFromInfo(info) {
  const sku = info?.sku;
  const skuStr = sku != null ? String(sku).trim() : '';
  if (skuStr && /^\d+$/.test(skuStr)) return skuStr;
  return null;
}

/** camelCase с фронта → snake_case для PostgreSQL */
function normalizeMarketplaceCardTextFields(obj) {
  if (!obj || typeof obj !== 'object') return;
  const pairs = [
    ['mpOzonName', 'mp_ozon_name'],
    ['mpOzonDescription', 'mp_ozon_description'],
    ['mpOzonBrand', 'mp_ozon_brand'],
    ['mpWbVendorCode', 'mp_wb_vendor_code'],
    ['mpWbName', 'mp_wb_name'],
    ['mpWbDescription', 'mp_wb_description'],
    ['mpWbBrand', 'mp_wb_brand'],
    ['mpYmName', 'mp_ym_name'],
    ['mpYmDescription', 'mp_ym_description']
  ];
  for (const [camel, snake] of pairs) {
    if (Object.prototype.hasOwnProperty.call(obj, camel)) {
      const v = obj[camel];
      obj[snake] = v != null && String(v).trim() !== '' ? String(v).trim() : null;
      delete obj[camel];
    }
  }
}

async function loadCategoryMappingsMapById(categoryIds) {
  const unique = [
    ...new Set(
      (categoryIds || [])
        .map((x) => String(x).trim())
        .filter((x) => x && x !== '__no_category__')
    ),
  ];
  if (unique.length === 0) return {};
  try {
    const r = await query(
      `SELECT id, marketplace_mappings FROM user_categories WHERE id::text = ANY($1::text[])`,
      [unique]
    );
    const out = {};
    for (const row of r.rows || []) {
      out[String(row.id)] = parseUserCategoryMarketplaceMappings(row.marketplace_mappings);
    }
    return out;
  } catch (e) {
    console.warn('[Products Service] loadCategoryMappingsMapById:', e.message);
    return {};
  }
}

/**
 * Если для ключей scope ещё нет строк в cache_entries (mp_attributes) — запрашиваем схему у API МП и кэшируем.
 * Иначе в Excel нет столбцов характеристик, пока кто-то не откроет атрибуты в UI.
 */
async function ensureMpAttributeCachesForScope(scope, exportOpts, existingCaches) {
  const rows = Array.isArray(existingCaches) ? existingCaches : [];
  const keySet = new Set(rows.map((r) => String(r.cache_key || '')));

  if (!scope || !exportOpts) return;

  if (exportOpts.includeMpOzon && scope.ozonKeys && scope.ozonKeys.size > 0) {
    for (const key of scope.ozonKeys) {
      const m = String(key).match(/^ozon:(\d+):(\d+)$/);
      if (!m) continue;
      const fullKey = `ozon:${m[1]}:${m[2]}`;
      if (keySet.has(fullKey)) continue;
      try {
        await integrationsService.getOzonCategoryAttributes(Number(m[1]), Number(m[2]), {});
        keySet.add(fullKey);
      } catch (e) {
        console.warn('[Products Service] ensureMpAttributeCachesForScope Ozon:', fullKey, e.message);
      }
    }
  }

  if (exportOpts.includeMpWb && scope.wbKeys && scope.wbKeys.size > 0) {
    for (const key of scope.wbKeys) {
      const m = String(key).match(/^wb:(\d+)$/);
      if (!m) continue;
      const fullKey = `wb:${m[1]}`;
      if (keySet.has(fullKey)) continue;
      try {
        await integrationsService.getWildberriesCategoryAttributes(Number(m[1]), {});
        keySet.add(fullKey);
      } catch (e) {
        console.warn('[Products Service] ensureMpAttributeCachesForScope WB:', fullKey, e.message);
      }
    }
  }

  if (exportOpts.includeMpYm && Array.isArray(scope.ymPrefixes) && scope.ymPrefixes.length > 0) {
    for (const prefix of scope.ymPrefixes) {
      const has = rows.some((r) => String(r.cache_key || '').startsWith(prefix));
      if (has) continue;
      const m = String(prefix).match(/^ym:(\d+):$/);
      if (!m) continue;
      try {
        await integrationsService.getYandexCategoryContentParameters(m[1], {});
      } catch (e) {
        console.warn('[Products Service] ensureMpAttributeCachesForScope YM:', prefix, e.message);
      }
    }
  }
}

async function assertKitsFeatureAllowed(productData, profileId, { existingProduct = null } = {}) {
  const rawProfileId =
    profileId ??
    productData?.profileId ??
    productData?.profile_id ??
    existingProduct?.profile_id ??
    existingProduct?.profileId ??
    null;
  const kitsEnabled = await resolveProfileKitsEnabled(rawProfileId);
  if (kitsEnabled) return;

  const nextType = productData?.product_type ?? productData?.productType;
  const wantsKitType = String(nextType || '').toLowerCase() === 'kit';
  const wantsKitComponents =
    Array.isArray(productData?.kit_components) && productData.kit_components.length > 0;
  if (wantsKitType || wantsKitComponents) {
    const error = new Error('Комплекты отключены в настройках аккаунта');
    error.statusCode = 403;
    throw error;
  }
}

class ProductsService {
  constructor() {
    this.repository = repositoryFactory.getProductsRepository();
    this.brandsRepository = repositoryFactory.getBrandsRepository();
  }

  async getAll(options = {}) {
    const items = await this.repository.findAll(options);
    return this._attachParticipationFlags(items);
  }

  /** Сводка остатков по складам (и категориям внутри склада) для главной. */
  async getHomeStockSummary(options = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const list = await this.getAll(options);
      let totalQty = 0;
      let totalCostSum = 0;
      let skusWithStock = 0;
      const map = new Map();
      for (const p of list) {
        const qty = Math.max(0, Number(p.quantity) || 0);
        const unitCost = p.cost != null && p.cost !== '' ? Number(p.cost) : null;
        const lineCost = unitCost != null && Number.isFinite(unitCost) ? qty * unitCost : 0;
        totalQty += qty;
        totalCostSum += lineCost;
        if (qty > 0) skusWithStock += 1;
        const cid =
          p.user_category_id != null && String(p.user_category_id).trim() !== ''
            ? String(p.user_category_id)
            : '_none';
        const label = (p.category_name || p.categoryName || 'Без категории').trim() || 'Без категории';
        if (!map.has(cid)) map.set(cid, { categoryId: cid, name: label, qty: 0, costSum: 0 });
        const row = map.get(cid);
        row.qty += qty;
        row.costSum += lineCost;
      }
      const rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      return {
        warehouses: [
          {
            warehouseId: 'all',
            name: 'Все склады',
            totalQty,
            totalCostSum,
            skusWithStock,
            rows,
          },
        ],
        rows,
        totalQty,
        totalCostSum,
        skusWithStock,
      };
    }
    const profileId = options.profileId ?? options.profile_id ?? null;
    return this.repository.getHomeStockSummary(profileId);
  }

  _isTruthyFlag(value) {
    return value === true || value === 'true' || value === '1' || value === 1;
  }

  _isStockListInStockOnly(options = {}) {
    return this._isTruthyFlag(options.inStockOnly);
  }

  _isStockListReservedOnly(options = {}) {
    return this._isTruthyFlag(options.reservedOnly);
  }

  _isStockListAvailableOnly(options = {}) {
    return this._isTruthyFlag(options.availableOnly);
  }

  _needsStockListPostFilter(options = {}) {
    return (
      this._isStockListInStockOnly(options) ||
      this._isStockListReservedOnly(options) ||
      this._isStockListAvailableOnly(options)
    );
  }

  _passesStockListPostFilter(product, options = {}) {
    if (this._isStockListInStockOnly(options) && stockListOnHandQuantity(product) <= 0) {
      return false;
    }
    if (this._isStockListReservedOnly(options) && stockListReservedQuantity(product) <= 0) {
      return false;
    }
    if (this._isStockListAvailableOnly(options) && stockListAvailableQuantity(product) <= 0) {
      return false;
    }
    return true;
  }

  async getPage(options = {}) {
    if (options.listView === 'stock') {
      if (this._needsStockListPostFilter(options)) {
        return this._getStockListPostFilterPage(options);
      }
      const [items, total] = await Promise.all([
        this.repository.findAll({ ...options, listView: 'stock' }),
        this.repository.countAll(options)
      ]);
      const withFlags = await this._attachParticipationFlags(items);
      await this._syncStockListReservedColumn(withFlags, options);
      return { items: withFlags, total };
    }
    const items = await this.repository.findAll(options);
    const total = await this.repository.countAll(options);
    const withFlags = await this._attachParticipationFlags(items);
    return { items: withFlags, total };
  }

  /**
   * Список остатков с пост-фильтром по колонкам (наличие / резерв / доступно):
   * обход каталога с SQL-фильтрами, затем отбор по метрикам таблицы и пагинация.
   */
  async _getStockListPostFilterPage(options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    let page = Math.max(1, Number(options.page) || 0);
    if (!Number.isFinite(page) || page < 1) {
      const off = Math.max(0, Number(options.offset) || 0);
      page = Math.floor(off / limit) + 1;
    }
    const targetOffset = (page - 1) * limit;
    const sqlBatch = 200;
    let sqlOffset = 0;
    const pageItems = [];
    let total = 0;

    const {
      page: _page,
      limit: _limit,
      offset: _offset,
      inStockOnly: _inStockOnly,
      reservedOnly: _reservedOnly,
      availableOnly: _availableOnly,
      ...scanFilters
    } = options;

    const whRaw = scanFilters.warehouseId ?? scanFilters.warehouse_id ?? null;
    const warehouseScoped =
      whRaw != null && String(whRaw).trim() !== '' && Number.isFinite(Number(whRaw)) && Number(whRaw) > 0;
    /** При выбранном складе «только в наличии» можно отсечь пустые строки в SQL, не обходя весь каталог. */
    const sqlInStockOnly = warehouseScoped && this._isStockListInStockOnly(options);

    while (true) {
      const batch = await this.repository.findAll({
        ...scanFilters,
        listView: 'stock',
        limit: sqlBatch,
        offset: sqlOffset,
        inStockOnly: sqlInStockOnly,
        deferInStockPostFilter: !sqlInStockOnly,
      });
      if (batch.length === 0) break;

      for (const product of batch) {
        if (!this._passesStockListPostFilter(product, options)) continue;
        if (total >= targetOffset && pageItems.length < limit) {
          pageItems.push(product);
        }
        total += 1;
      }

      if (batch.length < sqlBatch) break;
      sqlOffset += sqlBatch;
    }

    const withFlags = await this._attachParticipationFlags(pageItems);
    await this._syncStockListReservedColumn(withFlags, options);
    return { items: withFlags, total };
  }

  /**
   * Список остатков уже подставляет резерв из журнала в ответ API; здесь выравниваем products.reserved_quantity,
   * чтобы резерв заказов и прочие проверки не опирались на устаревшую колонку (как после открытия истории).
   */
  async _syncStockListReservedColumn(products, options = {}) {
    if (!Array.isArray(products) || products.length === 0) return;
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const whRaw = options.warehouseId ?? options.warehouse_id ?? null;
    const warehouseScoped =
      whRaw != null && String(whRaw).trim() !== '' && Number.isFinite(Number(whRaw)) && Number(whRaw) > 0;
    if (warehouseScoped) return;

    const { syncProductReservedQuantityFromJournal } = await import('./sellableQuantity.service.js');
    const { isKitProductId, readKitSkuNetReserved } = await import('./kitStock.service.js');
    await Promise.all(
      products.map(async (p) => {
        const nid = typeof p.id === 'string' ? parseInt(p.id, 10) : Number(p.id);
        if (!Number.isFinite(nid) || nid < 1) return;
        try {
          if (await isKitProductId(nid)) {
            const rv = await readKitSkuNetReserved(nid, options);
            await syncProductReservedQuantityFromJournal(nid, { reserved: rv });
          } else {
            const rv =
              p.net_reserved_quantity ??
              p.reserved_quantity ??
              (await syncProductReservedQuantityFromJournal(nid, options));
            if (rv != null && Number.isFinite(Number(rv))) {
              p.reserved_quantity = Number(rv);
              p.net_reserved_quantity = Number(rv);
            }
          }
        } catch {
          /* ignore */
        }
      })
    );
  }

  async _attachParticipationFlags(products) {
    if (!Array.isArray(products) || products.length === 0) return products;
    if (!repositoryFactory.isUsingPostgreSQL()) return products;
    const [batch, kitComponentMap] = await Promise.all([
      getProductParticipationBatch(products.map((p) => p.id)),
      import('./kitStock.service.js').then(({ batchKitIdByComponentMap }) =>
        batchKitIdByComponentMap(products.map((p) => p.id))
      ),
    ]);
    return products.map((p) => {
      const info = batch.get(String(p.id)) || { hasParticipation: false, reasons: [] };
      const isArchived = Boolean(p.is_archived);
      const pid = typeof p.id === 'string' ? parseInt(p.id, 10) : Number(p.id);
      const isKitComponent = Number.isFinite(pid) && kitComponentMap.has(pid);
      return {
        ...p,
        isArchived,
        hasParticipation: info.hasParticipation,
        participationReasons: info.reasons,
        canDelete: !info.hasParticipation && !isArchived,
        is_kit_component: isKitComponent,
      };
    });
  }

  async getParticipation(id) {
    const product = await this.repository.findById(id);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    const participation = await getProductParticipation(id);
    const isArchived = Boolean(product.is_archived);
    return {
      productId: product.id,
      isArchived,
      ...participation,
      canDelete: !participation.hasParticipation && !isArchived,
    };
  }

  async archive(id) {
    const product = await this.repository.findById(id);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    const row = await this.repository.setArchived(id, true);
    if (!row) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    return await this.getByIdWithDetails(id);
  }

  async unarchive(id) {
    const product = await this.repository.findById(id);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    const row = await this.repository.setArchived(id, false);
    if (!row) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    return await this.getByIdWithDetails(id);
  }

  /**
   * Для страницы «Категории»: id товаров по ERP-категории без загрузки полных карточек.
   * @returns {Promise<Record<string, number[]>>}
   */
  async getProductIdsGroupedByUserCategory(options = {}) {
    return await this.repository.getProductIdsGroupedByUserCategory(options);
  }

  /**
   * Excel (.xlsx) с товарами и полями маркетплейсов (только PostgreSQL).
   * @param {{ organizationId?: string, categoryId?: string, search?: string, profileId?: number|string, exportOptions?: object }} filters
   * @returns {Promise<{ buffer: Buffer, productCount: number }>}
   */
  async exportToExcel(filters = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Экспорт в Excel доступен только при использовании PostgreSQL (USE_POSTGRESQL=true).');
      err.statusCode = 501;
      throw err;
    }
    const products = await this.repository.findAll({
      organizationId: filters.organizationId,
      categoryId: filters.categoryId,
      search: filters.search,
      profileId: filters.profileId,
      limit: MAX_EXPORT_PRODUCTS + 1,
      forExport: true
    });
    if (!Array.isArray(products)) {
      const err = new Error('Не удалось получить список товаров');
      err.statusCode = 500;
      throw err;
    }
    if (products.length > MAX_EXPORT_PRODUCTS) {
      const err = new Error(
        `Слишком много товаров для одного файла (>${MAX_EXPORT_PRODUCTS}). Уточните фильтры по организации или категории.`
      );
      err.statusCode = 400;
      throw err;
    }

    const orgRepo = repositoryFactory.getOrganizationsRepository();
    const orgOpts = {};
    if (filters.profileId != null && filters.profileId !== '') {
      orgOpts.profileId = filters.profileId;
    }
    const organizations = await orgRepo.findAll(orgOpts);
    const brands = await this.brandsRepository.findAll();
    let categories = [];
    try {
      const catRes = await query('SELECT id, name FROM user_categories ORDER BY name');
      categories = catRes.rows || [];
    } catch (e) {
      console.warn('[Products Service] export Excel: user_categories:', e.message);
    }

    let mpAttributeCaches = [];
    try {
      const cacheRes = await query(
        `SELECT cache_key, cache_value FROM cache_entries
         WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY cache_key`,
        ['mp_attributes']
      );
      mpAttributeCaches = cacheRes.rows || [];
    } catch (e) {
      console.warn('[Products Service] export Excel: mp_attributes cache:', e.message);
    }

    let mpDictValueCaches = [];
    try {
      const dictRes = await query(
        `SELECT cache_key, cache_value FROM cache_entries
         WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY cache_key`,
        ['mp_dict_values']
      );
      mpDictValueCaches = dictRes.rows || [];
    } catch (e) {
      console.warn('[Products Service] export Excel: mp_dict_values cache:', e.message);
    }

    const categoryIdSet = new Set();
    for (const p of products) {
      const raw = p.categoryId ?? p.user_category_id;
      if (raw != null && String(raw).trim() !== '') {
        categoryIdSet.add(String(raw).trim());
      }
    }
    if (filters.categoryId != null && String(filters.categoryId).trim() !== '') {
      categoryIdSet.add(String(filters.categoryId).trim());
    }
    const categoryIdsForScope = [...categoryIdSet];
    const categoryMappingsById = await loadCategoryMappingsMapById(categoryIdsForScope);

    const exportCategoryId =
      filters.categoryId != null && String(filters.categoryId).trim() !== ''
        ? String(filters.categoryId).trim()
        : null;

    let flatOzonCategories = [];
    try {
      flatOzonCategories = await integrationsService.getOzonCategories({ dbOnly: true });
      if (!flatOzonCategories.length) {
        flatOzonCategories = await integrationsService.getOzonCategories({ forceRefresh: false });
      }
    } catch (e) {
      console.warn('[Products Service] export Excel: список категорий Ozon для scope:', e.message);
    }

    const exportOpts = normalizeProductExportOptions(filters.exportOptions || {});
    const scope = buildMpAttributeCacheScope(
      products,
      categoryMappingsById,
      exportCategoryId,
      flatOzonCategories
    );
    if (exportOpts.includeMpOzon && scope.ozonKeys.size === 0 && categoryIdsForScope.length > 0) {
      for (const cid of categoryIdsForScope) {
        const mm = categoryMappingsById[cid] ?? categoryMappingsById[String(Number(cid))];
        if (!mm || typeof mm !== 'object') continue;
        const pair = resolveOzonDescTypePair(mm, flatOzonCategories);
        console.warn(
          '[Products Service] export Excel: нет ключа Ozon в scope для категории',
          cid,
          'ozon_pair:',
          pair,
          'mm.ozon_type:',
          mm.ozon != null ? typeof mm.ozon : 'null'
        );
        break;
      }
    }
    try {
      await ensureMpAttributeCachesForScope(scope, exportOpts, mpAttributeCaches);
      const cacheResReload = await query(
        `SELECT cache_key, cache_value FROM cache_entries
         WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY cache_key`,
        ['mp_attributes']
      );
      mpAttributeCaches = cacheResReload.rows || [];
    } catch (e) {
      console.warn('[Products Service] export Excel: ensure mp_attributes:', e.message);
    }
    const prefetchAttrCaches = filterMpAttributeCachesByCategoryScope(
      filterMpCachesForExport(mpAttributeCaches, exportOpts),
      scope
    );
    const prefetchDictCaches = filterMpDictValueCachesForOzonCategoryScope(
      filterMpDictValueCachesForExport(mpDictValueCaches, exportOpts),
      scope.ozonKeys
    );
    if (exportOpts.includeMpOzon && prefetchAttrCaches.length > 0) {
      try {
        await integrationsService.prefetchOzonDictionaryCachesFromMpAttributes(
          prefetchAttrCaches,
          prefetchDictCaches.map((r) => r.cache_key),
          { maxCalls: 400 }
        );
        const dictRes2 = await query(
          `SELECT cache_key, cache_value FROM cache_entries
           WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY cache_key`,
          ['mp_dict_values']
        );
        mpDictValueCaches = dictRes2.rows || [];
      } catch (e) {
        console.warn('[Products Service] export Excel: Ozon dict prefetch:', e.message);
      }
    }

    const dictionaries = {
      categories: categories.map((r) => ({ id: r.id, name: r.name })),
      organizations: organizations.map((o) => ({ id: o.id, name: o.name })),
      brands: brands.map((b) => b.name).filter((n) => n != null && String(n).trim() !== ''),
      productTypes: [
        { code: 'product', label: 'Товар' },
        { code: 'kit', label: 'Комплект' }
      ],
      mpAttributeCaches,
      mpDictValueCaches,
      categoryMappingsById,
      exportTemplateCategoryId: exportCategoryId,
      flatOzonCategories
    };

    const buffer = await buildProductsExcelBuffer(products, dictionaries, filters.exportOptions || {});
    return { buffer, productCount: products.length };
  }

  /**
   * Пустой шаблон Excel для импорта (те же колонки, что у экспорта + лист «Словари»).
   * При указании categoryId в справочник попадает только эта категория (удобно заполнять товары в одной категории).
   * @param {{ categoryId?: string, profileId?: number|string, exportOptions?: object }} filters
   * @returns {Promise<{ buffer: Buffer, categoryId: string|null, categoryName: string|null }>}
   */
  async exportImportTemplateExcel(filters = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Шаблон Excel доступен только при PostgreSQL (USE_POSTGRESQL=true).');
      err.statusCode = 501;
      throw err;
    }

    const orgRepo = repositoryFactory.getOrganizationsRepository();
    const orgOpts = {};
    if (filters.profileId != null && filters.profileId !== '') {
      orgOpts.profileId = filters.profileId;
    }
    const organizations = await orgRepo.findAll(orgOpts);
    const brands = await this.brandsRepository.findAll();

    let categories = [];
    try {
      const catRes = await query('SELECT id, name FROM user_categories ORDER BY name');
      categories = catRes.rows || [];
    } catch (e) {
      console.warn('[Products Service] import template Excel: user_categories:', e.message);
    }

    const rawCategoryId =
      filters.categoryId != null && String(filters.categoryId).trim() !== ''
        ? String(filters.categoryId).trim()
        : '';
    let categoryName = null;
    if (rawCategoryId) {
      const found = categories.find((c) => String(c.id) === rawCategoryId);
      if (!found) {
        const err = new Error('Категория не найдена');
        err.statusCode = 404;
        throw err;
      }
      categories = [{ id: found.id, name: found.name }];
      categoryName = found.name != null ? String(found.name) : null;
    }

    let mpAttributeCaches = [];
    try {
      const cacheRes = await query(
        `SELECT cache_key, cache_value FROM cache_entries
         WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY cache_key`,
        ['mp_attributes']
      );
      mpAttributeCaches = cacheRes.rows || [];
    } catch (e) {
      console.warn('[Products Service] import template Excel: mp_attributes cache:', e.message);
    }

    let mpDictValueCaches = [];
    try {
      const dictRes = await query(
        `SELECT cache_key, cache_value FROM cache_entries
         WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY cache_key`,
        ['mp_dict_values']
      );
      mpDictValueCaches = dictRes.rows || [];
    } catch (e) {
      console.warn('[Products Service] import template Excel: mp_dict_values cache:', e.message);
    }

    const categoryMappingsById = rawCategoryId ? await loadCategoryMappingsMapById([rawCategoryId]) : {};

    let flatOzonCategoriesTpl = [];
    try {
      flatOzonCategoriesTpl = await integrationsService.getOzonCategories({ dbOnly: true });
      if (!flatOzonCategoriesTpl.length) {
        flatOzonCategoriesTpl = await integrationsService.getOzonCategories({ forceRefresh: false });
      }
    } catch (e) {
      console.warn('[Products Service] import template Excel: список категорий Ozon для scope:', e.message);
    }

    const templateExportOpts = normalizeProductExportOptions(filters.exportOptions || {});
    const templateScope = buildMpAttributeCacheScope(
      [],
      categoryMappingsById,
      rawCategoryId || null,
      flatOzonCategoriesTpl
    );
    try {
      await ensureMpAttributeCachesForScope(templateScope, templateExportOpts, mpAttributeCaches);
      const cacheResReloadTpl = await query(
        `SELECT cache_key, cache_value FROM cache_entries
         WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY cache_key`,
        ['mp_attributes']
      );
      mpAttributeCaches = cacheResReloadTpl.rows || [];
    } catch (e) {
      console.warn('[Products Service] import template Excel: ensure mp_attributes:', e.message);
    }
    const templatePrefetchAttr = filterMpAttributeCachesByCategoryScope(
      filterMpCachesForExport(mpAttributeCaches, templateExportOpts),
      templateScope
    );
    const templatePrefetchDict = filterMpDictValueCachesForOzonCategoryScope(
      filterMpDictValueCachesForExport(mpDictValueCaches, templateExportOpts),
      templateScope.ozonKeys
    );
    if (templateExportOpts.includeMpOzon && templatePrefetchAttr.length > 0) {
      try {
        await integrationsService.prefetchOzonDictionaryCachesFromMpAttributes(
          templatePrefetchAttr,
          templatePrefetchDict.map((r) => r.cache_key),
          { maxCalls: 400 }
        );
        const dictRes2 = await query(
          `SELECT cache_key, cache_value FROM cache_entries
           WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY cache_key`,
          ['mp_dict_values']
        );
        mpDictValueCaches = dictRes2.rows || [];
      } catch (e) {
        console.warn('[Products Service] import template Excel: Ozon dict prefetch:', e.message);
      }
    }

    const dictionaries = {
      categories: categories.map((r) => ({ id: r.id, name: r.name })),
      organizations: organizations.map((o) => ({ id: o.id, name: o.name })),
      brands: brands.map((b) => b.name).filter((n) => n != null && String(n).trim() !== ''),
      productTypes: [
        { code: 'product', label: 'Товар' },
        { code: 'kit', label: 'Комплект' }
      ],
      mpAttributeCaches,
      mpDictValueCaches,
      categoryMappingsById,
      exportTemplateCategoryId: rawCategoryId || null,
      flatOzonCategories: flatOzonCategoriesTpl
    };

    const buffer = await buildProductsExcelBuffer([], dictionaries, filters.exportOptions || {}, {
      forceHeaderAutoFilter: true,
      minDropdownDataRows: 2000
    });
    return { buffer, categoryId: rawCategoryId || null, categoryName };
  }

  /**
   * Импорт из Excel: строка с числовым ID → update; без ID → create (нужны sku и name).
   * @param {Buffer} buffer
   * @param {{ profileId?: number|string }} [ctx]
   */
  async importFromExcel(buffer, ctx = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Импорт из Excel доступен только при PostgreSQL (USE_POSTGRESQL=true).');
      err.statusCode = 501;
      throw err;
    }
    const { profileId } = ctx;
    const { rows, warnings } = await parseProductsImportWorkbook(buffer);

    const normName = (s) =>
      String(s || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

    let categories = [];
    try {
      const catRes = await query('SELECT id, name FROM user_categories ORDER BY name');
      categories = catRes.rows || [];
    } catch (e) {
      console.warn('[Products Service] import Excel: user_categories:', e.message);
    }
    const categoryByNormName = new Map(categories.map((c) => [normName(c.name), c.id]));

    const orgRepo = repositoryFactory.getOrganizationsRepository();
    const orgOpts = {};
    if (profileId != null && profileId !== '') orgOpts.profileId = profileId;
    const organizations = await orgRepo.findAll(orgOpts);
    const orgAllowedByNormName = new Map(organizations.map((o) => [normName(o.name), o.id]));

    let mpDictValueCachesForImport = [];
    try {
      const dictRes = await query(
        `SELECT cache_key, cache_value FROM cache_entries
         WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY cache_key`,
        ['mp_dict_values']
      );
      mpDictValueCachesForImport = dictRes.rows || [];
    } catch (e) {
      console.warn('[Products Service] import Excel: mp_dict_values cache:', e.message);
    }
    const ozonLabelToValueId = buildOzonDictionaryLabelToValueIdMap(mpDictValueCachesForImport);
    const ozonIdToLabel = buildOzonDictionaryIdToLabelMap(mpDictValueCachesForImport);

    const lookups = { categoryByNormName, orgAllowedByNormName };
    const summary = {
      updated: 0,
      created: 0,
      skipped: 0,
      errors: [],
      warnings: [...warnings]
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const excelRowIndex = i + 3;
      const productId = parseRowProductId(row);
      const imageHints = {
        mainUrl: row.image_main_url,
        galleryUrls: row.image_gallery_urls
      };
      let payload;
      try {
        payload = mapImportRowToApiPayload(row, lookups);
        if (payload.ozon_attributes && ozonLabelToValueId.size > 0) {
          payload.ozon_attributes = resolveOzonAttributesDictionaryLabels(
            payload.ozon_attributes,
            ozonLabelToValueId,
            ozonIdToLabel
          );
        }
      } catch (e) {
        summary.errors.push({ row: excelRowIndex, message: e.message || 'Ошибка разбора строки' });
        continue;
      }

      try {
        let savedProductId = productId ? String(productId) : null;
        if (productId) {
          const allowed = await this.repository.isProductImportableByProfile(productId, profileId);
          if (!allowed) {
            summary.errors.push({
              row: excelRowIndex,
              message:
                'Товар недоступен для импорта: нет организации или организация не входит в ваш профиль. Укажите организацию у товара в системе.'
            });
            continue;
          }
          await this.update(String(productId), payload);
          summary.updated++;
        } else {
          if (!payload.sku || !payload.name) {
            summary.skipped++;
            continue;
          }
          if (profileId != null && profileId !== '' && payload.organizationId != null && payload.organizationId !== '') {
            const ok = organizations.some((o) => String(o.id) === String(payload.organizationId));
            if (!ok) {
              summary.errors.push({
                row: excelRowIndex,
                message: 'Организация не найдена в вашем профиле (проверьте название на листе «Словари»).'
              });
              continue;
            }
          }
          // При импорте создание должно происходить в рамках профиля (аккаунта).
          const created = await this.create({ ...payload, profileId });
          savedProductId = created?.id != null ? String(created.id) : null;
          summary.created++;
        }

        if (savedProductId) {
          const mainS = String(imageHints.mainUrl ?? '').trim();
          const galS = String(imageHints.galleryUrls ?? '').trim();
          const wantedImages = mainS !== '' || galS !== '';
          if (wantedImages) {
            const imgRes = await importProductImagesFromExcelUrls(savedProductId, imageHints);
            if (imgRes?.skipped) {
              summary.warnings.push(
                `Строка ${excelRowIndex}: для загрузки фото нужны полные ссылки с http:// или https://`
              );
            } else if (imgRes && imgRes.ok === false) {
              const detail =
                imgRes.errors?.map((e) => `${e.url}: ${e.message}`).join('; ') || '';
              summary.errors.push({
                row: excelRowIndex,
                message: detail
                  ? `Фото не загружены: ${detail}`
                  : 'Указаны ссылки на фото, но ни один файл не сохранён.'
              });
            } else if (imgRes?.ok && imgRes.errors?.length) {
              summary.warnings.push(
                `Строка ${excelRowIndex}: часть ссылок на фото не загрузилась: ${imgRes.errors
                  .map((e) => `${e.url} (${e.message})`)
                  .join('; ')}`
              );
            }
          }
        }
      } catch (e) {
        summary.errors.push({ row: excelRowIndex, message: e.message || String(e) });
      }
    }

    return summary;
  }

  async getById(id) {
    const product = await this.repository.findById(id);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    return product;
  }

  async getByIdWithDetails(id) {
    let product;
    if (repositoryFactory.isUsingPostgreSQL()) {
      product = await this.repository.findByIdWithDetails(id);
    } else {
      product = await this.getById(id);
    }
    if (!product) return null;
    const [withFlags] = await this._attachParticipationFlags([product]);
    return withFlags;
  }

  /**
   * @param {string} sku
   * @param {{ profileId?: number|string|null }} [options] — для PostgreSQL: ограничить поиск аккаунтом (уникальность SKU по profile_id)
   */
  async getBySku(sku, options = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.findBySku(sku, options);
    } else {
      const products = await this.getAll();
      const pid = options.profileId ?? options.profile_id;
      const list =
        pid != null && pid !== ''
          ? products.filter((p) => String(p.profile_id ?? p.profileId ?? '') === String(pid))
          : products;
      return list.find((p) => p.sku === sku) || null;
    }
  }

  async getByBarcode(barcode) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.findByBarcode(barcode);
    }
    const products = await this.getAll();
    const b = String(barcode || '').trim();
    if (!b) return null;
    return products.find((p) => barcodeStringsFromProduct(p.barcodes).includes(b)) || null;
  }

  /** brand (строка) → brand_id в рамках profile_id товара. */
  async _resolveBrandIdFromName(target, existingProduct = null) {
    if (!target?.brand || target.brand_id) return;
    const brandName = String(target.brand).trim();
    if (!brandName) return;
    const profileId =
      target.profile_id ??
      target.profileId ??
      existingProduct?.profile_id ??
      existingProduct?.profileId ??
      null;
    const brandOpts = profileId != null && profileId !== '' ? { profileId } : {};
    const brands = await this.brandsRepository.findAll(brandOpts);
    let brand = brands.find(
      (b) => b.name && b.name.trim().toLowerCase() === brandName.toLowerCase()
    );
    if (!brand) {
      brand = await this.brandsRepository.create({ name: brandName, ...brandOpts }, brandOpts);
    }
    if (brand?.id != null) {
      target.brand_id = brand.id;
    }
  }

  async create(productData) {
    if (!productData || !productData.name || !productData.sku) {
      const error = new Error('Название и артикул обязательны');
      error.statusCode = 400;
      throw error;
    }
    normalizeMarketplaceCardTextFields(productData);

    const createProfileId = productData.profileId ?? productData.profile_id;
    if (repositoryFactory.isUsingPostgreSQL() && (createProfileId == null || createProfileId === '')) {
      const error = new Error('Создание товара доступно только для пользователя с привязкой к аккаунту');
      error.statusCode = 400;
      throw error;
    }

    // Проверка на дубликаты артикула в пределах аккаунта (PostgreSQL: уникальность по profile_id + sku)
    const existing = await this.getBySku(productData.sku, { profileId: createProfileId });
    if (existing) {
      const error = new Error('Товар с таким артикулом уже существует');
      error.statusCode = 400;
      throw error;
    }
    
    await this._resolveBrandIdFromName(productData);

    // Маппинг артикулов маркетплейсов: фронт отправляет sku_ozon, sku_wb, sku_ym (и может только marketplace_ozon_product_id без offer_id)
    if (
      !productData.marketplace_skus &&
      (productData.sku_ozon != null ||
        productData.sku_wb != null ||
        productData.sku_ym != null ||
        productData.marketplace_ozon_product_id != null ||
        productData.marketplace_ym_product_id != null)
    ) {
      productData.marketplace_skus = {};
      if (productData.sku_ozon && String(productData.sku_ozon).trim()) productData.marketplace_skus.ozon = String(productData.sku_ozon).trim();
      if (productData.sku_wb && String(productData.sku_wb).trim()) productData.marketplace_skus.wb = String(productData.sku_wb).trim();
      if (productData.sku_ym && String(productData.sku_ym).trim()) productData.marketplace_skus.ym = String(productData.sku_ym).trim();
    }
    if (productData.marketplace_skus?.ozon) {
      const explicit = productData.marketplace_ozon_product_id;
      if (
        explicit != null &&
        explicit !== '' &&
        Number.isFinite(Number(explicit))
      ) {
        productData.marketplace_ozon_product_id = Number(explicit);
      } else {
        try {
          const ozonProductId = await pricesService.getOzonProductIdByOfferId(productData.marketplace_skus.ozon);
          if (ozonProductId != null) productData.marketplace_ozon_product_id = ozonProductId;
        } catch (e) {
          console.warn('[Products Service] Could not resolve Ozon product_id for offer:', productData.marketplace_skus.ozon, e?.message);
        }
      }
    }
    if (productData.organizationId !== undefined) {
      productData.organization_id = productData.organizationId !== '' && productData.organizationId != null ? productData.organizationId : null;
    }
    if (productData.supplierId !== undefined || productData.supplier_id !== undefined) {
      const raw = productData.supplierId !== undefined ? productData.supplierId : productData.supplier_id;
      productData.supplier_id =
        raw != null && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : null;
    }
    // barcodes: нормализуем объекты { barcode, marketplaces }
    if (productData.barcodes != null) {
      productData.barcodes = normalizeBarcodeRows(productData.barcodes);
    }

    await assertKitsFeatureAllowed(productData, createProfileId);

    if (
      productData.ozon_attributes != null &&
      typeof productData.ozon_attributes === 'object' &&
      !Array.isArray(productData.ozon_attributes) &&
      Object.keys(productData.ozon_attributes).length > 0
    ) {
      try {
        const dictRes = await query(
          `SELECT cache_key, cache_value FROM cache_entries
           WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
          ['mp_dict_values']
        );
        const labelMap = buildOzonDictionaryLabelToValueIdMap(dictRes.rows || []);
        const idMap = buildOzonDictionaryIdToLabelMap(dictRes.rows || []);
        productData.ozon_attributes = resolveOzonAttributesDictionaryLabels(
          productData.ozon_attributes,
          labelMap,
          idMap
        );
      } catch (e) {
        console.warn('[Products Service] resolveOzonAttributesDictionaryLabels on create:', e?.message || e);
      }
    }

    // Складской остаток не задаётся из карточки или импорта — только через приёмки, списания, инвентаризации и т.д.
    delete productData.quantity;

    const createdProduct = await this.repository.create(productData);
    if (!createdProduct || createdProduct.id == null) {
      const error = new Error('Не удалось создать товар');
      error.statusCode = 500;
      throw error;
    }

    if (String(createdProduct.product_type || '').toLowerCase() === 'kit') {
      const { persistKitStock } = await import('./kitStock.service.js');
      await persistKitStock(createdProduct.id, {});
    }
    
    // Автоматически загружаем цены и наличие у поставщиков для нового товара
    if (createdProduct?.sku && createdProduct?.id != null) {
      try {
        console.log(`[Products Service] Auto-loading supplier stocks for new product: ${createdProduct.sku}`);
        await this.loadSupplierStocksForProduct(createdProduct);
        await this.repository.updateCostFromSupplierStocks(createdProduct.id);
      } catch (error) {
        console.error(`[Products Service] Error auto-loading supplier stocks for ${createdProduct.sku}:`, error.message);
      }
    }
    
    // Возвращаем товар заново с актуальной себестоимостью и остатками из supplier_stocks
    const productWithCost = createdProduct?.id != null ? await this.repository.findById(createdProduct.id) : null;
    const base = productWithCost || createdProduct;
    if (base?.id != null && repositoryFactory.isUsingPostgreSQL()) {
      const [withFlags] = await this._attachParticipationFlags([base]);
      return withFlags || base;
    }
    return base;
  }
  
  /**
   * Загрузить остатки и цены у поставщиков для товара
   */
  async loadSupplierStocksForProduct(product, opts = {}) {
    if (!product || !product.sku) {
      return;
    }

    const suppressMarketplacePush = opts.suppressMarketplacePush === true;

    try {
      // Получаем список активных поставщиков аккаунта товара
      const profileId = product.profile_id ?? product.profileId ?? null;
      if (profileId != null) {
        const prof = await repositoryFactory.getProfilesRepository().findById(profileId);
        if (!isProfileSupplierSyncEnabled(prof)) {
          return;
        }
      }
      const suppliersService = await import('./suppliers.service.js');
      const suppliers = await suppliersService.default.getAll({ profileId });
      const activeSuppliers = suppliers.filter(s => s.is_active !== false && s.code);
      
      if (activeSuppliers.length === 0) {
        console.log('[Products Service] No active suppliers found');
        return;
      }
      
      console.log(`[Products Service] Loading stocks from ${activeSuppliers.length} suppliers for SKU: ${product.sku}`);
      
      // Импортируем сервис для загрузки остатков
      const supplierStocksService = await import('./supplierStocks.service.js');
      
      // Загружаем данные от каждого поставщика асинхронно
      const { canonicalSupplierApiCode } = await import('../repositories/suppliers.repository.pg.js');
      const loadPromises = activeSuppliers.map(async (supplier) => {
        try {
          const supplierCode = canonicalSupplierApiCode(supplier.code) || supplier.code;
          console.log(`[Products Service] Loading stock from ${supplierCode} for SKU: ${product.sku} (forceRefresh: true)`);
          const stockData = await supplierStocksService.default.getSupplierStock({
            supplier: supplierCode,
            sku: product.sku,
            brand: product.brand || product.brand_name,
            forceRefresh: true, // Принудительно обновляем из API при ручном обновлении остатков
            supplierId: supplier.id,
            profileId
          });
          
          if (stockData) {
            console.log(`[Products Service] ✓ Loaded stock from ${supplier.code}: stock=${stockData.stock}, price=${stockData.price}`);
          } else {
            console.log(`[Products Service] No stock data from ${supplier.code} for SKU: ${product.sku}`);
          }
        } catch (error) {
          // Логируем ошибку, но не прерываем загрузку от других поставщиков
          console.error(`[Products Service] Error loading stock from ${supplier.code} for ${product.sku}:`, error.message);
        }
      });
      
      // Ждем завершения всех загрузок
      await Promise.allSettled(loadPromises);
      console.log(`[Products Service] Finished loading supplier stocks for SKU: ${product.sku}`);

      if (!suppressMarketplacePush && product.id != null) {
        const { scheduleWarehouseStockMarketplaceSync } = await import(
          './marketplaceWarehouseStockSync.service.js'
        );
        scheduleWarehouseStockMarketplaceSync(product.id, {
          source: 'supplier_stocks_updated',
          organizationId: product.organization_id ?? product.organizationId ?? null
        });
      }
    } catch (error) {
      console.error('[Products Service] Error in loadSupplierStocksForProduct:', error.message);
      throw error;
    }
  }

  async update(id, updates, opts = {}) {
    normalizeMarketplaceCardTextFields(updates);
    const existingForKits = await this.repository.findById(id);
    await assertKitsFeatureAllowed(updates, null, { existingProduct: existingForKits });
    // Остаток на складе меняется только складскими операциями (движения, резерв), не через PUT карточки или импорт.
    delete updates.quantity;
    if (updates.organizationId !== undefined) {
      updates.organization_id = updates.organizationId !== '' && updates.organizationId != null ? updates.organizationId : null;
    }
    if (updates.supplierId !== undefined || updates.supplier_id !== undefined) {
      const raw = updates.supplierId !== undefined ? updates.supplierId : updates.supplier_id;
      updates.supplier_id =
        raw != null && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : null;
    }
    let existingForBrand = null;
    if (updates.brand && !updates.brand_id) {
      existingForBrand = await this.repository.findById(id);
    }
    await this._resolveBrandIdFromName(updates, existingForBrand);

    if (updates.buyout_rate !== undefined && updates.buyout_rate !== null) {
      if (typeof updates.buyout_rate === 'string') {
        updates.buyout_rate = parseFloat(updates.buyout_rate);
      }
    }

    // Артикулы МП: обновляем только если в теле явно переданы поля sku_ozon/sku_wb/sku_ym (иначе частичный PUT не затирает МП)
    const mpSkuTouched =
      Object.prototype.hasOwnProperty.call(updates, 'sku_ozon') ||
      Object.prototype.hasOwnProperty.call(updates, 'sku_wb') ||
      Object.prototype.hasOwnProperty.call(updates, 'sku_ym');
    if (mpSkuTouched) {
      const toStr = (v) => (v != null && String(v).trim() !== '') ? String(v).trim() : null;
      updates.marketplace_skus = {};
      if (Object.prototype.hasOwnProperty.call(updates, 'sku_ozon')) {
        updates.marketplace_skus.ozon = toStr(updates.sku_ozon);
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'sku_ym')) {
        updates.marketplace_skus.ym = toStr(updates.sku_ym);
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'sku_wb')) {
        const nmRaw = toStr(updates.sku_wb);
        const vendorExplicit = Object.prototype.hasOwnProperty.call(updates, 'mp_wb_vendor_code');
        const vendor = vendorExplicit ? sanitizeWbVendorCode(toStr(updates.mp_wb_vendor_code)) : undefined;
        let existing = null;
        const needExisting =
          !vendorExplicit ||
          nmRaw == null ||
          !Object.prototype.hasOwnProperty.call(updates, 'wb_draft');
        if (needExisting) {
          existing = await this.getById(id);
        }
        const vendorForSkus =
          vendor !== undefined
            ? vendor
            : sanitizeWbVendorCode(toStr(existing?.mp_wb_vendor_code));
        updates.marketplace_skus.wb = vendorForSkus;
        // Не затирать клиентский wb_draft (габариты и пр.): база = входящий draft, иначе из БД
        const baseDraft = Object.prototype.hasOwnProperty.call(updates, 'wb_draft')
          ? parseWbDraftColumn(updates.wb_draft)
          : parseWbDraftColumn(existing?.wb_draft);
        updates.wb_draft = patchWbNmIdDraft(baseDraft, nmRaw);
        updates.sku_wb = nmRaw;
      }
      if (updates.marketplace_skus.ozon) {
        const explicit = updates.marketplace_ozon_product_id;
        if (
          explicit != null &&
          explicit !== '' &&
          Number.isFinite(Number(explicit))
        ) {
          updates.marketplace_ozon_product_id = Number(explicit);
        } else {
          try {
            const ozonProductId = await pricesService.getOzonProductIdByOfferId(updates.marketplace_skus.ozon);
            if (ozonProductId != null) updates.marketplace_ozon_product_id = ozonProductId;
          } catch (e) {
            console.warn('[Products Service] Could not resolve Ozon product_id for offer:', updates.marketplace_skus.ozon, e?.message);
          }
        }
      }
      if (
        updates.marketplace_ym_product_id != null &&
        updates.marketplace_ym_product_id !== '' &&
        Number.isFinite(Number(updates.marketplace_ym_product_id))
      ) {
        updates.marketplace_ym_product_id = Number(updates.marketplace_ym_product_id);
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(updates, 'mp_wb_vendor_code') &&
      !Object.prototype.hasOwnProperty.call(updates, 'sku_wb')
    ) {
      const toStr = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
      const vendor = sanitizeWbVendorCode(toStr(updates.mp_wb_vendor_code));
      updates.marketplace_skus = {
        ...(updates.marketplace_skus && typeof updates.marketplace_skus === 'object'
          ? updates.marketplace_skus
          : {}),
        wb: vendor,
      };
    }
    // Баркоды: явно пробрасываем массив в репозиторий (нормализуем для надёжности)
    if (Object.prototype.hasOwnProperty.call(updates, 'barcodes')) {
      updates.barcodes = normalizeBarcodeRows(updates.barcodes);
    }

    // Подписи словаря Ozon из Excel/таблицы → id значения (как при импорте), иначе в JSON остаётся текст и селект в UI «пустой»
    if (
      updates.ozon_attributes != null &&
      typeof updates.ozon_attributes === 'object' &&
      !Array.isArray(updates.ozon_attributes) &&
      Object.keys(updates.ozon_attributes).length > 0
    ) {
      try {
        const dictRes = await query(
          `SELECT cache_key, cache_value FROM cache_entries
           WHERE cache_type = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
          ['mp_dict_values']
        );
        const labelMap = buildOzonDictionaryLabelToValueIdMap(dictRes.rows || []);
        const idMap = buildOzonDictionaryIdToLabelMap(dictRes.rows || []);
        updates.ozon_attributes = resolveOzonAttributesDictionaryLabels(
          updates.ozon_attributes,
          labelMap,
          idMap
        );
      } catch (e) {
        console.warn('[Products Service] resolveOzonAttributesDictionaryLabels on update:', e?.message || e);
      }
    }

    const updated = await this.repository.update(id, updates);
    if (!updated) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'kit_components')) {
      const { persistKitStock } = await import('./kitStock.service.js');
      await persistKitStock(updated.id, {});
    }

    const priceAffectingKeys = ['cost', 'weight', 'length', 'width', 'height'];
    const shouldRecalcPrices = priceAffectingKeys.some(key => Object.prototype.hasOwnProperty.call(updates, key));
    if (shouldRecalcPrices) {
      pricesService.recalculateAndSaveForProduct(updated.id).catch(err => {
        console.error('[Products Service] Recalc min prices after update failed:', err?.message || err);
      });
    }

    // Автопуш карточки на МП отключён: UI подсвечивает dirty-поля и пушит только
    // подтверждённые маркетплейсы через POST /products/:id/push-card/:marketplace
    void opts.skipMarketplaceCardPush;

    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.getByIdWithDetails(id);
    }
    return updated;
  }

  async delete(id) {
    const product = await this.repository.findById(id);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }

    const participation = await getProductParticipation(id);
    if (participation.hasParticipation) {
      const error = new Error(buildProductDeleteBlockedMessage(participation));
      error.statusCode = 409;
      error.details = { reasons: participation.reasons, kinds: participation.kinds };
      throw error;
    }

    const deleted = await this.repository.delete(id);
    if (!deleted) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    return { id, deleted: true };
  }

  async count(options = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.count(options);
    } else {
      const products = await this.getAll();
      return products.length;
    }
  }

  async replaceAll(products) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      // Только для старого хранилища
      if (!Array.isArray(products)) {
        const error = new Error('Ожидается массив товаров');
        error.statusCode = 400;
        throw error;
      }
      return await this.repository.replaceAll(products);
    } else {
      throw new Error('Метод replaceAll не поддерживается для PostgreSQL. Используйте create/update/delete');
    }
  }
  
  /**
   * Принудительно обновить остатки и цены у поставщиков для всех товаров или конкретного товара
   */
  async refreshSupplierStocks(productId = null, opts = {}) {
    try {
      let productsToUpdate = [];
      const scopeProfileId = opts.profileId ?? opts.profile_id ?? null;

      if (productId) {
        // Обновляем остатки для конкретного товара
        const product = await this.getById(productId);
        if (!product) {
          const error = new Error('Товар не найден');
          error.statusCode = 404;
          throw error;
        }
        const productProfileId = product.profile_id ?? product.profileId ?? null;
        if (productProfileId != null) {
          const prof = await repositoryFactory.getProfilesRepository().findById(productProfileId);
          if (!isProfileSupplierSyncEnabled(prof)) {
            return {
              total: 0,
              success: 0,
              failed: 0,
              details: [],
              marketplacePushScheduled: 0,
              skipped: true,
              reason: 'supplier_sync_disabled'
            };
          }
        }
        productsToUpdate = [product];
        console.log(`[Products Service] Refreshing supplier stocks for product ID: ${productId}, SKU: ${product.sku}`);
      } else if (scopeProfileId != null && scopeProfileId !== '') {
        const prof = await repositoryFactory.getProfilesRepository().findById(scopeProfileId);
        if (!isProfileSupplierSyncEnabled(prof)) {
          console.log(
            `[Products Service] Supplier stocks refresh skipped: integration disabled for profile ${scopeProfileId}`
          );
          return {
            total: 0,
            success: 0,
            failed: 0,
            details: [],
            marketplacePushScheduled: 0,
            skipped: true,
            reason: 'supplier_sync_disabled'
          };
        }
        productsToUpdate = await this.getAll({ profileId: scopeProfileId });
        console.log(
          `[Products Service] Refreshing supplier stocks for profile ${scopeProfileId}: ${productsToUpdate.length} products`
        );
      } else {
        const enabledProfiles = await repositoryFactory.getProfilesRepository().findSupplierSyncEnabled();
        if (enabledProfiles.length === 0) {
          console.log('[Products Service] Supplier stocks refresh skipped: no profiles with integration enabled');
          return {
            total: 0,
            success: 0,
            failed: 0,
            details: [],
            marketplacePushScheduled: 0,
            skipped: true,
            reason: 'no_enabled_profiles'
          };
        }
        productsToUpdate = [];
        for (const prof of enabledProfiles) {
          const batch = await this.getAll({ profileId: prof.id });
          productsToUpdate.push(...batch);
        }
        console.log(
          `[Products Service] Refreshing supplier stocks for ${productsToUpdate.length} products across ${enabledProfiles.length} profile(s)`
        );
      }
      
      const results = {
        total: productsToUpdate.length,
        success: 0,
        failed: 0,
        details: [],
        marketplacePushScheduled: 0
      };

      const isBulkRefresh = !productId;
      const successProductIds = [];

      const concurrency = Math.max(
        1,
        Math.min(12, parseInt(process.env.SUPPLIER_STOCKS_REFRESH_CONCURRENCY || '2', 10) || 2)
      );
      let index = 0;

      const processOne = async (product) => {
        if (!product.sku) {
          results.failed++;
          results.details.push({
            productId: product.id,
            sku: product.sku || 'N/A',
            status: 'skipped',
            reason: 'No SKU'
          });
          return;
        }
        try {
          await this.loadSupplierStocksForProduct(product, {
            suppressMarketplacePush: isBulkRefresh
          });
          if (product.id) {
            await this.repository.updateCostFromSupplierStocks(product.id);
          }
          results.success++;
          if (product.id != null) {
            successProductIds.push(product.id);
          }
          results.details.push({
            productId: product.id,
            sku: product.sku,
            status: 'success'
          });
        } catch (error) {
          results.failed++;
          results.details.push({
            productId: product.id,
            sku: product.sku,
            status: 'error',
            error: error.message
          });
          console.error(`[Products Service] Error refreshing stocks for ${product.sku}:`, error.message);
        }
      };

      const workers = Array.from({ length: Math.min(concurrency, productsToUpdate.length) }, async () => {
        while (index < productsToUpdate.length) {
          const product = productsToUpdate[index++];
          await processOne(product);
        }
      });
      await Promise.all(workers);

      if (isBulkRefresh && successProductIds.length > 0) {
        const { syncMarketplaceStocksForProductIds } = await import(
          './marketplaceWarehouseStockSync.service.js'
        );
        const ids = [...successProductIds];
        results.marketplacePushScheduled = ids.length;
        setImmediate(() => {
          syncMarketplaceStocksForProductIds(ids, { source: 'supplier_stocks_scheduled' }).catch(
            (e) => {
              console.error(
                '[Products Service] MP push after supplier stocks failed:',
                e?.message || e
              );
            }
          );
        });
      }

      console.log(
        `[Products Service] Supplier stocks refresh completed: ${results.success} success, ${results.failed} failed` +
          (results.marketplacePushScheduled
            ? `, MP push scheduled for ${results.marketplacePushScheduled} products`
            : '')
      );
      return results;
      
    } catch (error) {
      console.error('[Products Service] Error in refreshSupplierStocks:', error.message);
      throw error;
    }
  }

  /**
   * Связать товар ERP с карточкой на маркетплейсе по артикулу ERP (кабинет организации).
   * @param {number|string} productId
   * @param {'ozon'|'wb'|'ym'|string} marketplace
   * @param {{ profileId?: number|string|null }} [options]
   */
  async linkProductToMarketplace(productId, marketplace, options = {}) {
    const product = await this.getByIdWithDetails(productId);
    if (!product) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }
    const orgId = product.organization_id ?? product.organizationId;
    const erpSku = product.sku;
    const bodyHints = options.hints && typeof options.hints === 'object' ? options.hints : {};
    const hints = {
      sku_ozon: bodyHints.sku_ozon ?? product.sku_ozon ?? product.marketplace_skus?.ozon ?? null,
      ozon_product_id:
        bodyHints.ozon_product_id ??
        product.marketplace_ozon_product_id ??
        product.ozon_product_id ??
        null,
      mp_wb_vendor_code: bodyHints.mp_wb_vendor_code ?? product.mp_wb_vendor_code ?? null,
      sku_wb: bodyHints.sku_wb ?? product.sku_wb ?? product.marketplace_skus?.wb ?? null,
      sku_ym: bodyHints.sku_ym ?? product.sku_ym ?? product.marketplace_skus?.ym ?? null,
      _product: product
    };
    const resolved = await resolveMarketplaceListingByErpSku({
      marketplace,
      erpSku,
      profileId: options.profileId ?? product.profile_id ?? product.profileId ?? null,
      organizationId: orgId,
      hints
    });

    const updates = {
      mp_linked: { [resolved.marketplace]: true }
    };
    if (resolved.marketplace === 'ozon') {
      updates.sku_ozon = resolved.sku_ozon;
      updates.marketplace_ozon_product_id = resolved.marketplace_ozon_product_id;
    } else if (resolved.marketplace === 'wb') {
      const vendor = resolved.mp_wb_vendor_code ? sanitizeWbVendorCode(resolved.mp_wb_vendor_code) : null;
      updates.mp_wb_vendor_code = vendor;
      updates.sku_wb = resolved.sku_wb;
      updates.marketplace_skus = { wb: vendor };
      updates.wb_draft = patchWbNmIdDraft(parseWbDraftColumn(product.wb_draft), resolved.sku_wb);
    } else if (resolved.marketplace === 'ym') {
      updates.sku_ym = resolved.sku_ym;
    }

    const updated = await this.update(productId, updates);
    return { product: updated, link: resolved };
  }

  /**
   * Ozon SKU (поле sku в API) для отображения покупателю; product_id хранится отдельно.
   */
  async ensureOzonMarketSku(productId, product, { profileId = null, organizationId = null } = {}) {
    const cached = pickProductMarketplaceNumber(product, 'ozon');
    if (cached) return cached;

    const offerId =
      product?.sku_ozon ??
      product?.marketplace_skus?.ozon ??
      product?.sku ??
      null;
    if (!offerId || String(offerId).trim() === '') return null;

    const info = await integrationsService.getOzonProductInfo({
      offer_id: String(offerId).trim(),
      profileId,
      organizationId
    });
    const ozonSku = pickOzonMarketSkuFromInfo(info);
    if (!ozonSku) return null;

    const updates = {};
    if (info?.id != null && !product?.ozon_product_id && !product?.marketplace_ozon_product_id) {
      updates.marketplace_ozon_product_id = Number(info.id);
      updates.marketplace_skus = { ozon: String(offerId).trim() };
    }
    if (Object.keys(updates).length > 0) {
      await this.update(productId, updates, { profileId });
    }
    await this.repository.patchProductSkuMpExtra(productId, 'ozon', { ozonSku });
    return ozonSku;
  }

  /**
   * Номер карточки по offer_id (артикул продавца) — для «Из вопроса» на Ozon.
   */
  async resolveMarketplaceNumberByOffer(marketplace, offerId, options = {}) {
    const mp = normalizeQuestionMarketplaceCode(marketplace);
    const offer = offerId != null ? String(offerId).trim() : '';
    if (!mp) {
      const err = new Error('Укажите маркетплейс: ozon, wb или ym.');
      err.statusCode = 400;
      throw err;
    }
    if (!offer) {
      const err = new Error('Укажите offer_id (артикул продавца).');
      err.statusCode = 400;
      throw err;
    }
    const orgId = options.organizationId ?? options.organization_id ?? null;
    if (orgId == null || orgId === '') {
      const err = new Error('Укажите organizationId.');
      err.statusCode = 400;
      throw err;
    }
    const profileId = options.profileId ?? null;

    if (mp === 'ozon') {
      const info = await integrationsService.getOzonProductInfo({
        offer_id: offer,
        profileId,
        organizationId: orgId
      });
      const number = pickOzonMarketSkuFromInfo(info);
      return { marketplace: mp, number, source: 'api' };
    }

    const resolved = await resolveMarketplaceListingByErpSku({
      marketplace: mp,
      erpSku: offer,
      profileId,
      organizationId: orgId,
      hints: { sku_ozon: offer, sku_ym: offer, mp_wb_vendor_code: offer }
    });
    if (mp === 'wb') {
      return { marketplace: mp, number: pickNumericMarketplaceId(resolved.sku_wb), source: 'api' };
    }
    if (mp === 'ym') {
      const ymInfo = await integrationsService.getYandexProductInfo({
        offer_id: resolved.sku_ym ?? offer,
        profileId,
        organizationId: orgId
      });
      return {
        marketplace: mp,
        number: pickNumericMarketplaceId(ymInfo?.marketSku),
        source: 'api'
      };
    }
    return { marketplace: mp, number: null, source: 'api' };
  }

  /**
   * Номер карточки на маркетплейсе для вставки в ответ на вопрос.
   * Сначала из БД; если пусто — запрос в API кабинета организации и сохранение.
   * @param {number|string} productId
   * @param {'ozon'|'wb'|'ym'|string} marketplace
   * @param {{ profileId?: number|string|null, persist?: boolean }} [options]
   */
  async resolveMarketplaceNumberForQuestion(productId, marketplace, options = {}) {
    const product = await this.getByIdWithDetails(productId);
    if (!product) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }

    const mp = normalizeQuestionMarketplaceCode(marketplace);
    if (!mp) {
      const err = new Error('Укажите маркетплейс: ozon, wb или ym.');
      err.statusCode = 400;
      throw err;
    }

    const existing = pickProductMarketplaceNumber(product, mp);
    if (existing) {
      return { marketplace: mp, number: existing, source: 'db', persisted: false };
    }

    const orgId = product.organization_id ?? product.organizationId;
    if (orgId == null || orgId === '') {
      const err = new Error('У товара не указана организация — выберите организацию в карточке.');
      err.statusCode = 400;
      throw err;
    }

    const profileId = options.profileId ?? product.profile_id ?? product.profileId ?? null;

    if (mp === 'ozon') {
      const ozonSku = await this.ensureOzonMarketSku(productId, product, {
        profileId,
        organizationId: orgId
      });
      if (ozonSku) {
        return { marketplace: mp, number: ozonSku, source: 'api', persisted: true };
      }
      return { marketplace: mp, number: null, source: 'api', persisted: false };
    }

    const erpSku = product.sku;
    const hints = {
      sku_ozon: product.sku_ozon ?? product.marketplace_skus?.ozon ?? null,
      ozon_product_id: product.marketplace_ozon_product_id ?? product.ozon_product_id ?? null,
      mp_wb_vendor_code: product.mp_wb_vendor_code ?? null,
      sku_wb: product.sku_wb ?? product.marketplace_skus?.wb ?? null,
      sku_ym: product.sku_ym ?? product.marketplace_skus?.ym ?? null,
      _product: product
    };

    let resolved;
    try {
      resolved = await resolveMarketplaceListingByErpSku({
        marketplace: mp,
        erpSku,
        profileId,
        organizationId: orgId,
        hints
      });
    } catch (e) {
      if (e?.statusCode === 404) {
        return { marketplace: mp, number: null, source: 'api', persisted: false };
      }
      throw e;
    }

    let number = null;
    const updates = {};
    if (mp === 'wb') {
      number = pickNumericMarketplaceId(resolved.sku_wb);
      if (number) {
        const vendor = resolved.mp_wb_vendor_code
          ? sanitizeWbVendorCode(resolved.mp_wb_vendor_code)
          : null;
        updates.mp_wb_vendor_code = vendor;
        updates.sku_wb = number;
        updates.marketplace_skus = { wb: vendor };
        updates.wb_draft = patchWbNmIdDraft(parseWbDraftColumn(product.wb_draft), number);
      }
    } else if (mp === 'ym') {
      const ymInfo = await integrationsService.getYandexProductInfo({
        offer_id: resolved.sku_ym,
        profileId,
        organizationId: orgId
      });
      number = pickNumericMarketplaceId(ymInfo?.marketSku);
      updates.sku_ym = resolved.sku_ym;
      updates.marketplace_skus = { ym: resolved.sku_ym };
      if (number) {
        updates.marketplace_ym_product_id = Number(number);
      }
    }

    if (!number) {
      return { marketplace: mp, number: null, source: 'api', persisted: false };
    }

    if (options.persist !== false && Object.keys(updates).length > 0) {
      await this.update(productId, updates, { profileId });
    }

    return { marketplace: mp, number, source: 'api', persisted: options.persist !== false };
  }

  /**
   * Отправить данные карточки на маркетплейс(ы).
   * @param {number|string} productId
   * @param {'ozon'|'wb'|'ym'|'all'|string} marketplace
   */
  async pushProductCardToMarketplace(productId, marketplace, options = {}) {
    return marketplaceProductCardPush.pushProductCard(productId, marketplace, {
      profileId: options.profileId ?? null
    });
  }

  /**
   * Массовая отправка карточек на маркетплейсы.
   * @param {{ productIds: Array<number|string>, marketplaces: string|string[] }} payload
   */
  async pushProductCardsBulk(payload, options = {}) {
    return marketplaceProductCardPush.pushProductCardsBulk(payload, {
      profileId: options.profileId ?? null
    });
  }

  /**
   * Обновить карточку в ERP данными с маркетплейса.
   * @param {number|string} productId
   * @param {'ozon'|'wb'|'ym'|'all'|string} marketplace
   */
  async pullProductCardFromMarketplace(productId, marketplace, options = {}) {
    const marketplaceProductCardPull = (await import('./marketplaceProductCardPull.service.js')).default;
    return marketplaceProductCardPull.pullProductCard(productId, marketplace, {
      profileId: options.profileId ?? null,
      skipImages: options.skipImages,
      notifyChanges: options.notifyChanges,
    });
  }

  /** Только изображения с маркетплейса → галерея ERP. */
  async pullProductImagesFromMarketplace(productId, marketplace, options = {}) {
    const marketplaceProductCardPull = (await import('./marketplaceProductCardPull.service.js')).default;
    return marketplaceProductCardPull.pullProductImagesOnly(productId, marketplace, {
      profileId: options.profileId ?? null,
    });
  }

  /**
   * Массовое обновление карточек ERP данными с маркетплейсов.
   * @param {{ productIds: Array<number|string>, marketplaces: string|string[] }} payload
   */
  async pullProductCardsBulk(payload, options = {}) {
    const marketplaceProductCardPull = (await import('./marketplaceProductCardPull.service.js')).default;
    return marketplaceProductCardPull.pullProductCardsBulk(payload, {
      profileId: options.profileId ?? null,
      skipImages: options.skipImages,
      concurrency: options.concurrency,
      notifyChanges: options.notifyChanges,
    });
  }
}

export default new ProductsService();


