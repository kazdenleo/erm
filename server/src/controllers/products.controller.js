/**
 * Products Controller
 * HTTP контроллер для товаров
 */

import productsService from '../services/products.service.js';
import supplierStocksService from '../services/supplierStocks.service.js';
import { normalizeProductExportOptions } from '../services/productsExport.service.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import repositoryFactory from '../config/repository-factory.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { isProfileSupplierSyncEnabled } from '../utils/profileSupplierSync.js';

const STOCK_LIST_DEFAULT_LIMIT = 50;
/** Без limit в запросе — не отдаём весь каталог (риск 504 на VPS). Исключение: forExport=1 */
const PRODUCT_LIST_DEFAULT_LIMIT = 200;
const PRODUCT_LIST_MAX_LIMIT = 1000;
const STOCK_LIST_MAX_LIMIT = 200;

/** Запрос со страницы «Остатки» (старый фронт без listView=stock). */
function requestFromStockLevelsPage(req) {
  const clientRoute = String(req.get('x-erm-client-route') || '').trim().toLowerCase();
  if (clientRoute === 'stock-levels') return true;
  const ref = String(req.get('referer') || '');
  if (!ref) return false;
  try {
    return new URL(ref).pathname.includes('/stock-levels');
  } catch {
    return /\/stock-levels(\/|$|\?)/i.test(ref);
  }
}

function wantsFullProductsCatalog(req) {
  const lv = firstQueryParam(req.query?.listView);
  return lv === 'full' || req.query?.forExport === 'true' || req.query?.forExport === '1';
}

function resolveStockListMode(req, options) {
  if (wantsFullProductsCatalog(req)) {
    return false;
  }
  const stockListParam = firstQueryParam(req.query?.stockList);
  if (
    firstQueryParam(req.query?.listView) === 'stock' ||
    stockListParam === '1' ||
    stockListParam === 'true'
  ) {
    return true;
  }
  const wh = firstQueryParam(req.query?.warehouseId);
  if (wh != null && String(wh).trim() !== '') {
    return true;
  }
  return requestFromStockLevelsPage(req);
}

/** Латинский fallback для Content-Disposition filename= (кириллица в заголовке ломает Node) */
function asciiContentDispositionFilename(name, fallback = 'file.xlsx') {
  const s = String(name || '');
  const ascii = s.replace(/[^\x20-\x7E]/g, '_').replace(/_+/g, '_').trim() || fallback;
  return ascii.slice(0, 180);
}

function setAttachmentXlsx(res, filename) {
  const asciiName = asciiContentDispositionFilename(filename, 'products.xlsx');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
}

/** Express query: одна строка или массив (дубли параметра в URL). */
function firstQueryParam(val) {
  if (val == null) return undefined;
  const v = Array.isArray(val) ? val[0] : val;
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

/** Как на фронте: фильтр «без ERP-категории»; нельзя подставлять в bigint user_category_id. */
const FILTER_CATEGORY_NONE_TOKEN = '__no_category__';

/**
 * Безопасное значение categoryId для списка/экспорта: только sentinel или числовой id.
 * Любой мусор в query — undefined (не 500).
 */
function parseProductListCategoryId(queryVal) {
  const s = firstQueryParam(queryVal);
  if (s == null) return undefined;
  if (s === FILTER_CATEGORY_NONE_TOKEN) return FILTER_CATEGORY_NONE_TOKEN;
  if (/^\d+$/.test(s)) return s;
  return undefined;
}

/** Только числовой brand_id для SQL bigint. */
function parseProductListBrandId(queryVal) {
  const s = firstQueryParam(queryVal);
  if (s == null || !/^\d+$/.test(s)) return undefined;
  return s;
}

/** Только числовой supplier_id для SQL bigint. */
function parseProductListSupplierId(queryVal) {
  const s = firstQueryParam(queryVal);
  if (s == null || !/^\d+$/.test(s)) return undefined;
  return s;
}

class ProductsController {
  constructor() {
    const __filename = fileURLToPath(import.meta.url);
    this._rootDir = path.resolve(path.dirname(__filename), '../../');
  }
  async exportExcel(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(403).json({ ok: false, message: 'Экспорт доступен только с привязкой к аккаунту' });
      }
      const filters = {};
      if (req.query.organizationId != null && String(req.query.organizationId).trim() !== '') {
        filters.organizationId = String(req.query.organizationId).trim();
      }
      const cat = parseProductListCategoryId(req.query.categoryId);
      if (cat != null) filters.categoryId = cat;
      const brandParsed = parseProductListBrandId(req.query.brandId);
      if (brandParsed != null) filters.brandId = brandParsed;
      const supplierParsed = parseProductListSupplierId(req.query.supplierId);
      if (supplierParsed != null) filters.supplierId = supplierParsed;
      if (req.query.search != null && String(req.query.search).trim() !== '') {
        filters.search = String(req.query.search).trim();
      }
      if (tid != null) {
        filters.profileId = tid;
      }
      filters.exportOptions = normalizeProductExportOptions({
        includeMp: req.query.includeMp,
        mpFields: req.query.mpFields,
        mpOzon: req.query.mpOzon,
        mpWb: req.query.mpWb,
        mpYm: req.query.mpYm
      });
      const { buffer, productCount } = await productsService.exportToExcel(filters);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `products_export_${date}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      setAttachmentXlsx(res, filename);
      res.setHeader('X-Products-Exported', String(productCount ?? 0));
      // Порядок колонок: системные → WB → Ozon → Яндекс (см. buildProductSheetColumns)
      res.setHeader('X-Products-Export-Column-Order', 'system,wb,ozon,ym');
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  }

  async downloadImportTemplateExcel(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(403).json({ ok: false, message: 'Шаблон доступен только с привязкой к аккаунту' });
      }
      const filters = {};
      const catTpl = parseProductListCategoryId(req.query.categoryId);
      if (catTpl != null && catTpl !== FILTER_CATEGORY_NONE_TOKEN) {
        filters.categoryId = catTpl;
      }
      if (tid != null) {
        filters.profileId = tid;
      }
      filters.exportOptions = normalizeProductExportOptions({
        includeMp: req.query.includeMp,
        mpFields: req.query.mpFields,
        mpOzon: req.query.mpOzon,
        mpWb: req.query.mpWb,
        mpYm: req.query.mpYm
      });
      const { buffer, categoryId, categoryName } = await productsService.exportImportTemplateExcel(filters);
      res.setHeader('X-Products-Export-Column-Order', 'system,wb,ozon,ym');
      const date = new Date().toISOString().slice(0, 10);
      const safeSlug = (categoryName || 'all')
        .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 40) || 'all';
      const filename = categoryId
        ? `products_import_template_${safeSlug}_${date}.xlsx`
        : `products_import_template_${date}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      setAttachmentXlsx(res, filename);
      res.setHeader('X-Template-Category-Id', categoryId || '');
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  }

  async importExcel(req, res, next) {
    try {
      const file = req.file;
      if (!file?.buffer) {
        return res.status(400).json({ ok: false, message: 'Файл не получен. Отправьте multipart с полем file (.xlsx).' });
      }
      const profileId = req.user?.profileId;
      const summary = await productsService.importFromExcel(file.buffer, { profileId });
      return res.status(200).json({ ok: true, data: summary });
    } catch (error) {
      next(error);
    }
  }

  async getAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const options = {};
      if (tid != null) {
        options.profileId = tid;
      }
      if (req.query.organizationId != null && req.query.organizationId !== '') {
        options.organizationId = req.query.organizationId;
      }
      const brandParsed = parseProductListBrandId(req.query.brandId);
      if (brandParsed != null) options.brandId = brandParsed;
      const supplierParsed = parseProductListSupplierId(req.query.supplierId);
      if (supplierParsed != null) options.supplierId = supplierParsed;
      const catParsed = parseProductListCategoryId(req.query.categoryId);
      if (catParsed != null) options.categoryId = catParsed;
      if (req.query.search != null && req.query.search !== '') options.search = req.query.search;
      if (req.query.productType != null && String(req.query.productType).trim() !== '') {
        options.productType = String(req.query.productType).trim();
      }
      if (req.query.warehouseId != null && String(req.query.warehouseId).trim() !== '') {
        options.warehouseId = String(req.query.warehouseId).trim();
      }
      const inStockQuery = firstQueryParam(req.query?.inStockOnly);
      if (inStockQuery === 'true' || inStockQuery === '1' || inStockQuery === 1) {
        options.inStockOnly = true;
      }
      const reservedOnlyQuery = firstQueryParam(req.query?.reservedOnly);
      if (reservedOnlyQuery === 'true' || reservedOnlyQuery === '1' || reservedOnlyQuery === 1) {
        options.reservedOnly = true;
      }
      const availableOnlyQuery = firstQueryParam(req.query?.availableOnly);
      if (availableOnlyQuery === 'true' || availableOnlyQuery === '1' || availableOnlyQuery === 1) {
        options.availableOnly = true;
      }
      if (req.query.includeArchived === 'true' || req.query.includeArchived === '1') {
        options.includeArchived = true;
      }
      if (req.query.archivedOnly === 'true' || req.query.archivedOnly === '1') {
        options.archivedOnly = true;
      }
      if (req.query.unlinkedMp != null && String(req.query.unlinkedMp).trim() !== '') {
        const raw = req.query.unlinkedMp;
        const parts = Array.isArray(raw)
          ? raw.flatMap((x) => String(x).split(','))
          : String(raw).split(',');
        const allowed = new Set(['ozon', 'wb', 'ym']);
        const list = [...new Set(parts.map((s) => String(s).trim().toLowerCase()).filter((m) => allowed.has(m)))];
        if (list.length) options.unlinkedMp = list;
      }
      if (req.query.linkedMp != null && String(req.query.linkedMp).trim() !== '') {
        const raw = req.query.linkedMp;
        const parts = Array.isArray(raw)
          ? raw.flatMap((x) => String(x).split(','))
          : String(raw).split(',');
        const allowed = new Set(['ozon', 'wb', 'ym']);
        const list = [...new Set(parts.map((s) => String(s).trim().toLowerCase()).filter((m) => allowed.has(m)))];
        if (list.length) options.linkedMp = list;
      }
      const isStockList = resolveStockListMode(req, options);
      if (isStockList) {
        options.listView = 'stock';
      }
      const forExport =
        req.query.forExport === 'true' ||
        req.query.forExport === '1' ||
        req.query.forExport === 1;
      let hasPaging = req.query.limit != null || req.query.offset != null;
      if (!hasPaging && !forExport) {
        options.limit = PRODUCT_LIST_DEFAULT_LIMIT;
        options.offset = 0;
        hasPaging = true;
      }
      if (req.query.limit != null) options.limit = parseInt(req.query.limit, 10);
      if (req.query.page != null) options.page = parseInt(req.query.page, 10);
      if (req.query.offset != null) options.offset = parseInt(req.query.offset, 10);
      if (hasPaging && Number.isFinite(options.limit) && options.limit > PRODUCT_LIST_MAX_LIMIT) {
        options.limit = PRODUCT_LIST_MAX_LIMIT;
      }
      if (isStockList) {
        if (!Number.isFinite(options.limit) || options.limit <= 0) {
          options.limit = STOCK_LIST_DEFAULT_LIMIT;
        } else if (options.limit > STOCK_LIST_MAX_LIMIT) {
          options.limit = STOCK_LIST_MAX_LIMIT;
        }
        if (!Number.isFinite(options.offset) || options.offset < 0) {
          options.offset = 0;
        }
        hasPaging = true;
      }
      const result = hasPaging
        ? await productsService.getPage(options)
        : { items: await productsService.getAll(options), total: null };
      const products = result.items;
      const data = products.map((p) => {
        const row = { ...p };
        if (!isStockList) {
          row.storedMinPriceOzon = p.storedMinPriceOzon != null ? Number(p.storedMinPriceOzon) : null;
          row.storedMinPriceWb = p.storedMinPriceWb != null ? Number(p.storedMinPriceWb) : null;
          row.storedMinPriceYm = p.storedMinPriceYm != null ? Number(p.storedMinPriceYm) : null;
          row.storedMinPriceUpdatedAt = p.storedMinPriceUpdatedAt ?? null;
          row.storedCalculationDetailsOzon = p.storedCalculationDetailsOzon ?? null;
          row.storedCalculationDetailsWb = p.storedCalculationDetailsWb ?? null;
          row.storedCalculationDetailsYm = p.storedCalculationDetailsYm ?? null;
          row.storedCalculationDetailsOzonFbs = p.storedCalculationDetailsOzonFbs ?? null;
          row.storedCalculationDetailsOzonFbo = p.storedCalculationDetailsOzonFbo ?? null;
          row.storedCalculationDetailsWbFbs = p.storedCalculationDetailsWbFbs ?? null;
          row.storedCalculationDetailsWbFbo = p.storedCalculationDetailsWbFbo ?? null;
          row.storedCalculationDetailsYmFbs = p.storedCalculationDetailsYmFbs ?? null;
          row.storedCalculationDetailsYmFbo = p.storedCalculationDetailsYmFbo ?? null;
          row.storedMinPriceOzonFbs = p.storedMinPriceOzonFbs != null ? Number(p.storedMinPriceOzonFbs) : null;
          row.storedMinPriceOzonFbo = p.storedMinPriceOzonFbo != null ? Number(p.storedMinPriceOzonFbo) : null;
          row.storedMinPriceWbFbs = p.storedMinPriceWbFbs != null ? Number(p.storedMinPriceWbFbs) : null;
          row.storedMinPriceWbFbo = p.storedMinPriceWbFbo != null ? Number(p.storedMinPriceWbFbo) : null;
          row.storedMinPriceYmFbs = p.storedMinPriceYmFbs != null ? Number(p.storedMinPriceYmFbs) : null;
          row.storedMinPriceYmFbo = p.storedMinPriceYmFbo != null ? Number(p.storedMinPriceYmFbo) : null;
        }
        row.kit_display = p.kit_display ?? null;
        row.kit_components = Array.isArray(p.kit_components) ? p.kit_components : [];
        return row;
      });
      if (!isStockList) {
        const withPrices = data.filter(
          (p) => p.storedMinPriceOzon != null || p.storedMinPriceWb != null || p.storedMinPriceYm != null
        ).length;
        if (data.length > 0 && (withPrices > 0 || data.length <= 10)) {
          console.log(`[Products Controller] GET /products: ${data.length} products, ${withPrices} with stored min prices`);
        }
      }
      let supplierBreakdown;
      if (isStockList && data.length > 0) {
        const tid = tenantListProfileId(req);
        let supplierSyncOn = true;
        if (tid != null && tid !== TENANT_LIST_EMPTY) {
          const prof = await repositoryFactory.getProfilesRepository().findById(tid);
          supplierSyncOn = isProfileSupplierSyncEnabled(prof);
        }
        if (supplierSyncOn) {
          const productIds = data.map((p) => p.id).filter((id) => id != null);
          supplierBreakdown = await supplierStocksService.getBreakdownByProductIds(productIds, {
            mainWarehouseId: options.warehouseId ?? null,
            profileId: tid != null && tid !== TENANT_LIST_EMPTY ? tid : null,
          });
        }
      }
      res.setHeader('X-Products-List-View', isStockList ? 'stock' : 'full');
      if (options.brandId != null && String(options.brandId).trim() !== '') {
        res.setHeader('X-Products-Brand-Filter', String(options.brandId).trim());
      }
      if (hasPaging) {
        res.setHeader('X-Products-Total', String(result.total ?? ''));
        res.setHeader('X-Products-Limit', String(options.limit ?? ''));
        res.setHeader('X-Products-Offset', String(options.offset ?? 0));
      }
      return res.status(200).json({
        ok: true,
        data,
        ...(supplierBreakdown != null ? { supplierBreakdown } : {}),
        ...(hasPaging
          ? {
              meta: {
                total: result.total,
                limit: options.limit ?? null,
                offset: options.offset ?? 0,
              },
            }
          : {}),
      });
    } catch (error) {
      next(error);
    }
  }

  /** Сводка остатков для главной (SQL-агрегат, без выгрузки всего каталога). */
  async getHomeStockSummary(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({
          ok: true,
          data: {
            warehouses: [],
            rows: [],
            totalQty: 0,
            totalCostSum: 0,
            skusWithStock: 0,
            totalProducts: 0,
          },
        });
      }
      const data = await productsService.getHomeStockSummary(tid != null ? { profileId: tid } : {});
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /** Лёгкий ответ для UI категорий: { [user_category_id]: productId[] } без полных карточек товаров */
  async getProductIdsGroupedByUserCategory(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: {} });
      }
      const grouped = await productsService.getProductIdsGroupedByUserCategory(
        tid != null ? { profileId: tid } : {}
      );
      return res.status(200).json({ ok: true, data: grouped });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.getByIdWithDetails(id);
      if (!product) {
        return res.status(404).json({ ok: false, message: 'Товар не найден' });
      }
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async getMarketplaceNumber(req, res, next) {
    try {
      const { id } = req.params;
      const marketplace = req.query?.marketplace;
      if (!marketplace || String(marketplace).trim() === '') {
        return res.status(400).json({ ok: false, message: 'Укажите query-параметр marketplace (ozon, wb, ym).' });
      }
      const profileId = req.user?.profileId ?? null;
      const persist = req.query?.persist !== '0' && req.query?.persist !== 'false';
      const data = await productsService.resolveMarketplaceNumberForQuestion(id, marketplace, {
        profileId,
        persist
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getMarketplaceNumberByOffer(req, res, next) {
    try {
      const marketplace = req.query?.marketplace;
      const offerId = req.query?.offer_id ?? req.query?.offerId;
      const organizationId = req.query?.organizationId ?? req.query?.organization_id;
      if (!marketplace || String(marketplace).trim() === '') {
        return res.status(400).json({ ok: false, message: 'Укажите query-параметр marketplace (ozon, wb, ym).' });
      }
      if (!offerId || String(offerId).trim() === '') {
        return res.status(400).json({ ok: false, message: 'Укажите query-параметр offer_id.' });
      }
      if (organizationId == null || String(organizationId).trim() === '') {
        return res.status(400).json({ ok: false, message: 'Укажите query-параметр organizationId.' });
      }
      const profileId = req.user?.profileId ?? null;
      const data = await productsService.resolveMarketplaceNumberByOffer(marketplace, offerId, {
        profileId,
        organizationId
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getByBarcode(req, res, next) {
    try {
      const { barcode } = req.params;
      const product = await productsService.getByBarcode(barcode);
      if (!product) {
        return res.status(404).json({ ok: false, message: 'Товар с таким штрихкодом не найден' });
      }
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const product = await productsService.create({ ...req.body, profileId });
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      console.error('[Products Controller] Create error:', error?.message, error?.code, error?.stack);
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.update(id, req.body);
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async linkMarketplace(req, res, next) {
    try {
      const { id, marketplace } = req.params;
      const profileId = req.user?.profileId ?? null;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const fromBody =
        body.hints && typeof body.hints === 'object'
          ? body.hints
          : Object.keys(body).length > 0
            ? body
            : {};
      const q = req.query || {};
      const hints = {
        ...fromBody,
        mp_wb_vendor_code: q.mp_wb_vendor_code ?? fromBody.mp_wb_vendor_code,
        sku_wb: q.sku_wb ?? fromBody.sku_wb,
        sku_ozon: q.sku_ozon ?? fromBody.sku_ozon,
        ozon_product_id: q.ozon_product_id ?? fromBody.ozon_product_id,
        sku_ym: q.sku_ym ?? fromBody.sku_ym
      };
      const result = await productsService.linkProductToMarketplace(id, marketplace, {
        profileId,
        hints
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async pushCard(req, res, next) {
    try {
      const { id, marketplace } = req.params;
      const profileId = req.user?.profileId ?? null;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const patch =
        body.product && typeof body.product === 'object'
          ? body.product
          : Object.keys(body).length > 0
            ? body
            : null;
      if (patch && Object.keys(patch).length > 0) {
        await productsService.update(id, patch, { profileId });
      }
      const result = await productsService.pushProductCardToMarketplace(id, marketplace, { profileId });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async pushCardBulk(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const { productIds, marketplaces, marketplace } = req.body || {};
      const result = await productsService.pushProductCardsBulk(
        { productIds, marketplaces: marketplaces ?? marketplace },
        { profileId }
      );
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async pullCard(req, res, next) {
    try {
      const { id, marketplace } = req.params;
      const profileId = req.user?.profileId ?? null;
      const result = await productsService.pullProductCardFromMarketplace(id, marketplace, {
        profileId
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async pullCardBulk(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const { productIds, marketplaces, marketplace } = req.body || {};
      const result = await productsService.pullProductCardsBulk(
        { productIds, marketplaces: marketplaces ?? marketplace },
        { profileId }
      );
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getParticipation(req, res, next) {
    try {
      const { id } = req.params;
      const data = await productsService.getParticipation(id);
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async archive(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.archive(id);
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async unarchive(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.unarchive(id);
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.delete(id);
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async replaceAll(req, res, next) {
    try {
      const result = await productsService.replaceAll(req.body);
      return res.status(200).json({ ok: true, data: { message: 'Товары обновлены', ...result } });
    } catch (error) {
      next(error);
    }
  }

  async refreshSupplierStocks(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid != null && tid !== TENANT_LIST_EMPTY) {
        const prof = await repositoryFactory.getProfilesRepository().findById(tid);
        if (!isProfileSupplierSyncEnabled(prof)) {
          return res.status(403).json({
            ok: false,
            message: 'Синхронизация поставщиков отключена для этого аккаунта',
          });
        }
      }

      const { productId } = req.query;
      const productIdNum = productId ? parseInt(productId, 10) : null;

      if (!productIdNum) {
        const { startSupplierStocksSyncInBackground, getSupplierStocksSyncStatus } = await import(
          '../services/supplierStocksRefresh.job.js'
        );
        const status = getSupplierStocksSyncStatus();
        if (status.inProgress) {
          return res.status(200).json({
            ok: true,
            data: {
              inProgress: true,
              started: false,
              message:
                'Синхронизация остатков поставщиков уже выполняется. Обновите страницу через несколько минут.'
            }
          });
        }
        const started = startSupplierStocksSyncInBackground(
          tid != null && tid !== TENANT_LIST_EMPTY ? tid : null
        );
        return res.status(202).json({
          ok: true,
          data: {
            inProgress: true,
            started: started.started,
            message:
              'Синхронизация остатков поставщиков запущена в фоне. Это может занять 10–30 минут — затем обновите страницу остатков.'
          }
        });
      }

      console.log(`[Products Controller] Refreshing supplier stocks for product ID: ${productIdNum}`);
      const result = await productsService.refreshSupplierStocks(productIdNum);
      return res.status(200).json({
        ok: true,
        data: {
          message: 'Остатки обновлены для товара',
          inProgress: false,
          ...result
        }
      });
    } catch (error) {
      console.error('[Products Controller] Refresh supplier stocks error:', error?.message);
      next(error);
    }
  }

  async refreshSupplierStocksStatus(req, res, next) {
    try {
      const { getSupplierStocksSyncStatus } = await import('../services/supplierStocksRefresh.job.js');
      return res.status(200).json({ ok: true, data: getSupplierStocksSyncStatus() });
    } catch (error) {
      next(error);
    }
  }

  async getImages(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.getById(id);
      const images = Array.isArray(product?.images) ? product.images : (product?.images ? product.images : []);
      return res.status(200).json({ ok: true, data: Array.isArray(images) ? images : [] });
    } catch (error) {
      next(error);
    }
  }

  async uploadImages(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.getById(id);
      const current = Array.isArray(product?.images) ? [...product.images] : [];
      const files = Array.isArray(req.files) ? req.files : [];
      const hadAny = current.length > 0;
      const added = files.map((f, i) => {
        const filename = f?.filename || path.basename(f?.path || '');
        const rel = `/uploads/products/${String(id)}/${filename}`;
        return {
          id: filename,
          url: rel,
          filename,
          originalname: f?.originalname || '',
          primary: !hadAny && i === 0,
          marketplaces: { ozon: true, wb: true, ym: true },
          created_at: new Date().toISOString()
        };
      });
      const nextImages = [...current, ...added];
      const updated = await productsService.update(id, { images: nextImages });
      return res.status(200).json({ ok: true, data: updated?.images ?? nextImages });
    } catch (error) {
      next(error);
    }
  }

  async updateImages(req, res, next) {
    try {
      const { id } = req.params;
      const body = req.body || {};
      const images = Array.isArray(body.images) ? body.images : null;
      if (!images) return res.status(400).json({ ok: false, error: 'Ожидается images: массив' });
      const updated = await productsService.update(id, { images });
      return res.status(200).json({ ok: true, data: updated?.images ?? images });
    } catch (error) {
      next(error);
    }
  }

  async deleteImage(req, res, next) {
    try {
      const { id, imageId } = req.params;
      const product = await productsService.getById(id);
      const current = Array.isArray(product?.images) ? [...product.images] : [];
      const nextImages = current.filter((img) => String(img?.id || img?.filename || '') !== String(imageId));
      if (nextImages.length > 0 && !nextImages.some((img) => img.primary === true)) {
        nextImages[0] = { ...nextImages[0], primary: true };
      }

      // try delete file from disk
      const filePath = path.resolve(this._rootDir, 'uploads', 'products', String(id), String(imageId));
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}

      const updated = await productsService.update(id, { images: nextImages });
      return res.status(200).json({ ok: true, data: updated?.images ?? nextImages });
    } catch (error) {
      next(error);
    }
  }
}

export default new ProductsController();


