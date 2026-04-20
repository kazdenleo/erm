/**
 * Products Service
 * Бизнес-логика для работы с товарами
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
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
  resolveOzonAttributesDictionaryLabels
} from './productsImport.service.js';

const MAX_EXPORT_PRODUCTS = 25000;

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
  const unique = [...new Set((categoryIds || []).map((x) => String(x).trim()).filter(Boolean))];
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

class ProductsService {
  constructor() {
    this.repository = repositoryFactory.getProductsRepository();
    this.brandsRepository = repositoryFactory.getBrandsRepository();
  }

  async getAll(options = {}) {
    return await this.repository.findAll(options);
  }

  async getPage(options = {}) {
    const items = await this.repository.findAll(options);
    const total = await this.repository.countAll(options);
    return { items, total };
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
          payload.ozon_attributes = resolveOzonAttributesDictionaryLabels(payload.ozon_attributes, ozonLabelToValueId);
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
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.findByIdWithDetails(id);
    } else {
      return await this.getById(id);
    }
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
    return products.find(p => Array.isArray(p.barcodes) && p.barcodes.includes(b)) || null;
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
    
    // Обрабатываем brand: если передан brand (строка), находим или создаем бренд
    if (productData.brand && !productData.brand_id) {
      const brandName = productData.brand.trim();
      if (brandName) {
        const brands = await this.brandsRepository.findAll();
        let brand = brands.find(b => b.name && b.name.trim().toLowerCase() === brandName.toLowerCase());
        if (!brand) {
          brand = await this.brandsRepository.create(brandName);
        }
        productData.brand_id = brand.id;
      }
    }

    // Маппинг артикулов маркетплейсов: фронт отправляет sku_ozon, sku_wb, sku_ym
    if (!productData.marketplace_skus && (productData.sku_ozon != null || productData.sku_wb != null || productData.sku_ym != null)) {
      productData.marketplace_skus = {};
      if (productData.sku_ozon && String(productData.sku_ozon).trim()) productData.marketplace_skus.ozon = String(productData.sku_ozon).trim();
      if (productData.sku_wb && String(productData.sku_wb).trim()) productData.marketplace_skus.wb = String(productData.sku_wb).trim();
      if (productData.sku_ym && String(productData.sku_ym).trim()) productData.marketplace_skus.ym = String(productData.sku_ym).trim();
    }
    if (productData.marketplace_skus?.ozon) {
      try {
        const ozonProductId = await pricesService.getOzonProductIdByOfferId(productData.marketplace_skus.ozon);
        if (ozonProductId != null) productData.marketplace_ozon_product_id = ozonProductId;
      } catch (e) {
        console.warn('[Products Service] Could not resolve Ozon product_id for offer:', productData.marketplace_skus.ozon, e?.message);
      }
    }
    if (productData.organizationId !== undefined) {
      productData.organization_id = productData.organizationId !== '' && productData.organizationId != null ? productData.organizationId : null;
    }
    // barcodes фронт передаёт как массив — репозиторий уже сохраняет productData.barcodes

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
        productData.ozon_attributes = resolveOzonAttributesDictionaryLabels(productData.ozon_attributes, labelMap);
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
    return productWithCost || createdProduct;
  }
  
  /**
   * Загрузить остатки и цены у поставщиков для товара
   */
  async loadSupplierStocksForProduct(product) {
    if (!product || !product.sku) {
      return;
    }
    
    try {
      // Получаем список активных поставщиков
      const suppliersService = await import('./suppliers.service.js');
      const suppliers = await suppliersService.default.getAll();
      const activeSuppliers = suppliers.filter(s => s.is_active !== false && s.code);
      
      if (activeSuppliers.length === 0) {
        console.log('[Products Service] No active suppliers found');
        return;
      }
      
      console.log(`[Products Service] Loading stocks from ${activeSuppliers.length} suppliers for SKU: ${product.sku}`);
      
      // Импортируем сервис для загрузки остатков
      const supplierStocksService = await import('./supplierStocks.service.js');
      
      // Загружаем данные от каждого поставщика асинхронно
      const loadPromises = activeSuppliers.map(async (supplier) => {
        try {
          console.log(`[Products Service] Loading stock from ${supplier.code} for SKU: ${product.sku} (forceRefresh: true)`);
          const stockData = await supplierStocksService.default.getSupplierStock({
            supplier: supplier.code,
            sku: product.sku,
            brand: product.brand || product.brand_name,
            forceRefresh: true // Принудительно обновляем из API при ручном обновлении остатков
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
      
    } catch (error) {
      console.error('[Products Service] Error in loadSupplierStocksForProduct:', error.message);
      throw error;
    }
  }

  async update(id, updates) {
    normalizeMarketplaceCardTextFields(updates);
    // Остаток на складе меняется только складскими операциями (движения, резерв), не через PUT карточки или импорт.
    delete updates.quantity;
    if (updates.organizationId !== undefined) {
      updates.organization_id = updates.organizationId !== '' && updates.organizationId != null ? updates.organizationId : null;
    }
    // Обрабатываем brand: если передан brand (строка), находим или создаем бренд
    if (updates.brand && !updates.brand_id) {
      const brandName = updates.brand.trim();
      if (brandName) {
        // Ищем существующий бренд
        const brands = await this.brandsRepository.findAll();
        let brand = brands.find(b => b.name && b.name.trim().toLowerCase() === brandName.toLowerCase());
        
        // Если не найден, создаем новый
        if (!brand) {
          brand = await this.brandsRepository.create(brandName);
        }
        
        updates.brand_id = brand.id;
      }
    }
    
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
      updates.marketplace_skus = {
        ozon: toStr(updates.sku_ozon),
        wb: toStr(updates.sku_wb),
        ym: toStr(updates.sku_ym)
      };
      if (updates.marketplace_skus.ozon) {
        try {
          const ozonProductId = await pricesService.getOzonProductIdByOfferId(updates.marketplace_skus.ozon);
          if (ozonProductId != null) updates.marketplace_ozon_product_id = ozonProductId;
        } catch (e) {
          console.warn('[Products Service] Could not resolve Ozon product_id for offer:', updates.marketplace_skus.ozon, e?.message);
        }
      }
    }
    // Баркоды: явно пробрасываем массив в репозиторий (нормализуем для надёжности)
    if (Object.prototype.hasOwnProperty.call(updates, 'barcodes')) {
      updates.barcodes = Array.isArray(updates.barcodes)
        ? updates.barcodes.map(b => (b != null ? String(b).trim() : '')).filter(Boolean)
        : [];
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
        updates.ozon_attributes = resolveOzonAttributesDictionaryLabels(updates.ozon_attributes, labelMap);
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

    const priceAffectingKeys = ['cost', 'weight', 'length', 'width', 'height'];
    const shouldRecalcPrices = priceAffectingKeys.some(key => Object.prototype.hasOwnProperty.call(updates, key));
    if (shouldRecalcPrices) {
      pricesService.recalculateAndSaveForProduct(updated.id).catch(err => {
        console.error('[Products Service] Recalc min prices after update failed:', err?.message || err);
      });
    }

    return updated;
  }

  async delete(id) {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    return deleted;
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
  async refreshSupplierStocks(productId = null) {
    try {
      let productsToUpdate = [];
      
      if (productId) {
        // Обновляем остатки для конкретного товара
        const product = await this.getById(productId);
        if (!product) {
          const error = new Error('Товар не найден');
          error.statusCode = 404;
          throw error;
        }
        productsToUpdate = [product];
        console.log(`[Products Service] Refreshing supplier stocks for product ID: ${productId}, SKU: ${product.sku}`);
      } else {
        // Обновляем остатки для всех товаров
        productsToUpdate = await this.getAll();
        console.log(`[Products Service] Refreshing supplier stocks for all ${productsToUpdate.length} products`);
      }
      
      const results = {
        total: productsToUpdate.length,
        success: 0,
        failed: 0,
        details: []
      };
      
      // Загружаем остатки для каждого товара
      for (const product of productsToUpdate) {
        if (!product.sku) {
          results.failed++;
          results.details.push({
            productId: product.id,
            sku: product.sku || 'N/A',
            status: 'skipped',
            reason: 'No SKU'
          });
          continue;
        }
        
        try {
          console.log(`[Products Service] Starting stock refresh for product ID: ${product.id}, SKU: ${product.sku}`);
          await this.loadSupplierStocksForProduct(product);
          
          // Обновляем себестоимость в БД на основе данных поставщиков
          if (product.id) {
            await this.repository.updateCostFromSupplierStocks(product.id);
          }
          
          console.log(`[Products Service] ✓ Successfully refreshed stocks for product ID: ${product.id}, SKU: ${product.sku}`);
          results.success++;
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
      }
      
      console.log(`[Products Service] Supplier stocks refresh completed: ${results.success} success, ${results.failed} failed`);
      return results;
      
    } catch (error) {
      console.error('[Products Service] Error in refreshSupplierStocks:', error.message);
      throw error;
    }
  }
}

export default new ProductsService();


