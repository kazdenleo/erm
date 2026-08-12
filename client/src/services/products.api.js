/**
 * Products API Service
 * API сервис для работы с товарами
 */

import api from './api.js';
import { coerceBarcodeString, isCorruptBarcodeString, normalizeBarcodeRows } from '../utils/productBarcodes.js';

/** Массовый push/pull карточек МП: axios default 90s мало для каталога. */
const MARKETPLACE_CARD_BULK_TIMEOUT_MS = 600000; // 10 мин на чанк
/** Чанк меньше лимита сервера (pull ≤500) и укладывается в nginx proxy_read_timeout. */
const MARKETPLACE_CARD_BULK_CHUNK = 25;

/**
 * POST /products/push-card|pull-card с разбиением productIds на чанки.
 * @param {string} url
 * @param {{ productIds?: Array<number|string>, marketplaces?: string|string[], marketplace?: string }} payload
 * @param {{ onChunkProgress?: (info: { chunkIndex: number, chunkTotal: number, doneIds: number, totalIds: number }) => void }} [opts]
 */
async function postMarketplaceCardBulk(url, payload = {}, opts = {}) {
  const ids = Array.isArray(payload?.productIds) ? payload.productIds : [];
  if (ids.length === 0) {
    const response = await api.post(url, payload, { timeout: MARKETPLACE_CARD_BULK_TIMEOUT_MS });
    return response.data;
  }
  const chunks = [];
  for (let i = 0; i < ids.length; i += MARKETPLACE_CARD_BULK_CHUNK) {
    chunks.push(ids.slice(i, i + MARKETPLACE_CARD_BULK_CHUNK));
  }
  const onChunkProgress =
    typeof opts.onChunkProgress === 'function' ? opts.onChunkProgress : null;
  if (chunks.length === 1) {
    onChunkProgress?.({
      chunkIndex: 1,
      chunkTotal: 1,
      doneIds: 0,
      totalIds: ids.length,
    });
    const response = await api.post(url, payload, { timeout: MARKETPLACE_CARD_BULK_TIMEOUT_MS });
    onChunkProgress?.({
      chunkIndex: 1,
      chunkTotal: 1,
      doneIds: ids.length,
      totalIds: ids.length,
    });
    return response.data;
  }
  const allItems = [];
  let success = 0;
  let failed = 0;
  let skipped = 0;
  let doneIds = 0;
  for (let ci = 0; ci < chunks.length; ci += 1) {
    const chunk = chunks[ci];
    onChunkProgress?.({
      chunkIndex: ci + 1,
      chunkTotal: chunks.length,
      doneIds,
      totalIds: ids.length,
    });
    const response = await api.post(
      url,
      { ...payload, productIds: chunk },
      { timeout: MARKETPLACE_CARD_BULK_TIMEOUT_MS }
    );
    const body = response.data;
    const data = body?.data ?? body;
    if (Array.isArray(data?.items)) allItems.push(...data.items);
    success += Number(data?.success) || 0;
    failed += Number(data?.failed) || 0;
    skipped += Number(data?.skipped) || 0;
    doneIds += chunk.length;
  }
  onChunkProgress?.({
    chunkIndex: chunks.length,
    chunkTotal: chunks.length,
    doneIds: ids.length,
    totalIds: ids.length,
  });
  return {
    ok: true,
    data: {
      total: allItems.length,
      success,
      failed,
      skipped,
      items: allItems,
    },
  };
}

export const productsApi = {
  /** Сводка остатков по складам для главной (лёгкий SQL на сервере). */
  getHomeStockSummary: async () => {
    const response = await api.get('/products/home-stock-summary');
    return response.data?.data ?? response.data;
  },

  /**
   * Получить все товары
   * @param {object} [options] - options.cacheBust = true добавляет _t=timestamp чтобы не брать кэш (актуальные сохранённые цены)
   */
  getAll: async (options = {}, axiosConfig = {}) => {
    const params = { ...(options.cacheBust ? { _t: Date.now() } : {}) };
    if (options.organizationId != null && options.organizationId !== '') params.organizationId = options.organizationId;
    if (options.brandId != null && options.brandId !== '') params.brandId = String(options.brandId);
    if (options.supplierId != null && options.supplierId !== '') params.supplierId = String(options.supplierId);
    if (options.categoryId != null && options.categoryId !== '') params.categoryId = options.categoryId;
    if (options.search != null && String(options.search).trim() !== '') params.search = String(options.search).trim();
    if (options.listView != null && String(options.listView).trim() !== '') {
      params.listView = String(options.listView).trim();
    }
    if (options.productType != null && String(options.productType).trim() !== '') {
      params.productType = String(options.productType).trim();
    }
    if (options.warehouseId != null && options.warehouseId !== '') {
      params.warehouseId = String(options.warehouseId);
    }
    if (options.limit != null && options.limit !== '') {
      params.limit = String(options.limit);
    }
    if (options.page != null && options.page !== '') {
      params.page = String(options.page);
    }
    if (options.offset != null && options.offset !== '') {
      params.offset = String(options.offset);
    }
    if (options.includeArchived === true) params.includeArchived = '1';
    if (options.archivedOnly === true) params.archivedOnly = '1';
    if (options.unlinkedMp != null && options.unlinkedMp !== '') {
      const list = Array.isArray(options.unlinkedMp)
        ? options.unlinkedMp
        : String(options.unlinkedMp).split(',');
      const cleaned = [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
      if (cleaned.length) params.unlinkedMp = cleaned.join(',');
    }
    if (options.linkedMp != null && options.linkedMp !== '') {
      const list = Array.isArray(options.linkedMp)
        ? options.linkedMp
        : String(options.linkedMp).split(',');
      const cleaned = [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
      if (cleaned.length) params.linkedMp = cleaned.join(',');
    }
    if (
      options.requireAnyMarketplaceLink === true ||
      options.requireAnyMarketplaceLink === '1' ||
      options.requireAnyMarketplaceLink === 1
    ) {
      params.requireAnyMarketplaceLink = '1';
    }
    if (options.stockList === true || options.stockList === '1' || options.stockList === 1) {
      params.listView = 'stock';
      params.stockList = '1';
    }
    if (
      options.inStockOnly === true ||
      options.inStockOnly === '1' ||
      options.inStockOnly === 1
    ) {
      params.inStockOnly = '1';
    }
    if (
      options.reservedOnly === true ||
      options.reservedOnly === '1' ||
      options.reservedOnly === 1
    ) {
      params.reservedOnly = '1';
    }
    if (
      options.availableOnly === true ||
      options.availableOnly === '1' ||
      options.availableOnly === 1
    ) {
      params.availableOnly = '1';
    }
    if (
      options.mpStockBlockedOnly === true ||
      options.mpStockBlockedOnly === '1' ||
      options.mpStockBlockedOnly === 1
    ) {
      params.mpStockBlockedOnly = '1';
    }
    const response = await api.get('/products', {
      params: Object.keys(params).length ? params : undefined,
      ...axiosConfig
    });
    return response.data;
  },

  /** { [userCategoryId: string]: number[] } — без полной выгрузки товаров (страница «Категории»). */
  getProductIdsGroupedByUserCategory: async () => {
    const response = await api.get('/products/grouped-by-user-category');
    return response.data;
  },

  /**
   * Скачать Excel с товарами (маркетплейсы, JSON-атрибуты). Фильтры опциональны.
   * @returns {Promise<ArrayBuffer>}
   */
  /**
   * @returns {Promise<{ buffer: ArrayBuffer, exportedCount: number }>}
   */
  exportExcel: async (options = {}) => {
    const params = {};
    if (options.organizationId != null && options.organizationId !== '') params.organizationId = options.organizationId;
    if (options.categoryId != null && options.categoryId !== '') params.categoryId = options.categoryId;
    if (options.search != null && options.search !== '') params.search = options.search;
    /** false — только ERP; иначе — полный набор колонок МП */
    params.includeMp = options.includeMp === false ? '0' : '1';
    const response = await api.get('/products/export/excel', {
      params: Object.keys(params).length ? params : undefined,
      responseType: 'arraybuffer'
    });
    const raw = response.headers?.['x-products-exported'] ?? response.headers?.['X-Products-Exported'];
    const exportedCount = raw != null ? parseInt(String(raw), 10) : NaN;
    return {
      buffer: response.data,
      exportedCount: Number.isFinite(exportedCount) ? exportedCount : -1
    };
  },

  /**
   * Импорт товаров из Excel (.xlsx). Строка с ID → обновление, без ID → создание (нужны артикул и название).
   * @param {File|Blob} file
   */
  importExcel: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const response = await api.post('/products/import/excel', fd);
    return response.data;
  },

  /**
   * Скачать пустой шаблон для импорта (как экспорт, но без строк товаров).
   * @param {{ categoryId?: string, includeMp?: boolean }} [options] — includeMp=false исключает атрибуты МП
   * @returns {Promise<{ buffer: ArrayBuffer, filenameHint: string }>}
   */
  downloadImportTemplateExcel: async (options = {}) => {
    const params = {};
    if (options.categoryId != null && options.categoryId !== '') params.categoryId = options.categoryId;
    params.includeMp = options.includeMp === false ? '0' : '1';
    const response = await api.get('/products/import/template/excel', {
      params,
      responseType: 'arraybuffer'
    });
    const cd = String(
      response.headers?.['content-disposition'] ?? response.headers?.['Content-Disposition'] ?? ''
    );
    let filenameHint = 'products_import_template.xlsx';
    const utf8m = cd.match(/filename\*\s*=\s*UTF-8''([^;\s]+)/i);
    if (utf8m) {
      try {
        filenameHint = decodeURIComponent(utf8m[1].trim());
      } catch {
        filenameHint = utf8m[1].trim();
      }
    } else {
      const quoted = cd.match(/filename\s*=\s*"((?:\\.|[^"\\])*)"/i);
      if (quoted) filenameHint = quoted[1].replace(/\\"/g, '"');
      else {
        const plain = cd.match(/filename\s*=\s*([^;\s]+)/i);
        if (plain) filenameHint = plain[1].replace(/^["']|["']$/g, '');
      }
    }
    return { buffer: response.data, filenameHint };
  },

  /**
   * Получить товар по ID
   */
  getById: async (id) => {
    const response = await api.get(`/products/${id}`);
    return response.data;
  },

  listCompetitors: async (productId) => {
    const response = await api.get(`/products/${productId}/competitors`);
    return response.data;
  },

  addCompetitor: async (productId, url) => {
    const response = await api.post(`/products/${productId}/competitors`, { url }, { timeout: 90000 });
    return response.data;
  },

  removeCompetitor: async (productId, competitorId) => {
    const response = await api.delete(`/products/${productId}/competitors/${competitorId}`);
    return response.data;
  },

  refreshCompetitors: async (productId) => {
    const response = await api.post(`/products/${productId}/competitors/refresh`, null, {
      timeout: 120000,
    });
    return response.data;
  },

  refreshCompetitor: async (productId, competitorId) => {
    const response = await api.post(
      `/products/${productId}/competitors/${competitorId}/refresh`,
      null,
      { timeout: 60000 }
    );
    return response.data;
  },

  /**
   * Номер карточки на МП (из БД или через API кабинета организации).
   * @param {number|string} productId
   * @param {'ozon'|'wb'|'ym'|string} marketplace
   */
  resolveMarketplaceNumber: async (productId, marketplace, options = {}) => {
    const id = encodeURIComponent(String(productId));
    const params = { marketplace: String(marketplace).trim() };
    if (options.persist === false) params.persist = '0';
    const response = await api.get(`/products/${id}/marketplace-number`, {
      params,
      timeout: options.timeout ?? 45000
    });
    return response.data?.data ?? response.data;
  },

  resolveMarketplaceNumberByOffer: async (offerId, marketplace, options = {}) => {
    const params = {
      marketplace: String(marketplace).trim(),
      offer_id: String(offerId).trim()
    };
    if (options.organizationId != null && options.organizationId !== '') {
      params.organizationId = String(options.organizationId);
    }
    const response = await api.get('/products/marketplace-number-by-offer', {
      params,
      timeout: options.timeout ?? 45000
    });
    return response.data?.data ?? response.data;
  },

  /**
   * Получить товар по штрихкоду
   */
  getByBarcode: async (barcode) => {
    const encoded = encodeURIComponent(String(barcode).trim());
    const response = await api.get(`/products/by-barcode/${encoded}`);
    const body = response.data;
    return body?.data ?? body;
  },

  /**
   * Создать товар
   */
  create: async (productData) => {
    const response = await api.post('/products', productData);
    return response.data;
  },

  /**
   * Обновить товар
   */
  update: async (id, updates) => {
    const response = await api.put(`/products/${id}`, updates);
    return response.data;
  },

  /**
   * Связать товар с карточкой маркетплейса по артикулу (кабинет организации).
   * @param {number|string} productId
   * @param {'ozon'|'wb'|'ym'} marketplace
   */
  linkMarketplace: async (productId, marketplace, hints = null) => {
    const id = encodeURIComponent(String(productId));
    const mp = encodeURIComponent(String(marketplace).trim());
    const q = new URLSearchParams();
    if (hints && typeof hints === 'object') {
      for (const [key, val] of Object.entries(hints)) {
        if (val != null && String(val).trim() !== '') q.set(key, String(val).trim());
      }
    }
    const qs = q.toString();
    const url = `/products/${id}/link-marketplace/${mp}${qs ? `?${qs}` : ''}`;
    const body =
      hints && typeof hints === 'object' && Object.keys(hints).length > 0 ? hints : undefined;
    const response = await api.post(url, body);
    return response.data;
  },

  /**
   * Отправить данные карточки на маркетплейс (ozon | wb | ym | all).
   */
  /**
   * Отправить карточку на МП. При productPatch сначала сохраняет поля в ERP (тот же запрос).
   * @param {object|null} [productPatch]
   */
  pushCard: async (productId, marketplace, productPatch = null) => {
    const id = encodeURIComponent(String(productId));
    const mp = encodeURIComponent(String(marketplace).trim());
    // Ozon: после import ждём import/info (до ~30с) — нужен запас к дефолтным 90с
    const response = await api.post(
      `/products/${id}/push-card/${mp}`,
      productPatch && typeof productPatch === 'object' ? productPatch : undefined,
      { timeout: 120000 }
    );
    return response.data;
  },

  /**
   * Массовая отправка карточек на маркетплейсы.
   * Длинный timeout + чанки — иначе axios 90s / nginx рвут большой каталог.
   * @param {{ productIds: number[], marketplaces: string|string[] }} payload
   */
  pushCardBulk: async (payload, opts) => postMarketplaceCardBulk('/products/push-card', payload, opts),

  /**
   * Обновить карточку ERP данными с маркетплейса (ozon | wb | ym | all).
   */
  pullCard: async (productId, marketplace) => {
    const id = encodeURIComponent(String(productId));
    const mp = encodeURIComponent(String(marketplace).trim());
    const response = await api.post(`/products/${id}/pull-card/${mp}`);
    return response.data;
  },

  /**
   * Только изображения с МП → галерея ERP (без обновления полей карточки).
   */
  pullImages: async (productId, marketplace) => {
    const id = encodeURIComponent(String(productId));
    const mp = encodeURIComponent(String(marketplace).trim());
    const response = await api.post(`/products/${id}/pull-images/${mp}`, null, { timeout: 120000 });
    return response.data;
  },

  /**
   * Массовое обновление карточек ERP данными с маркетплейсов.
   * @param {{ productIds: number[], marketplaces: string|string[] }} payload
   */
  pullCardBulk: async (payload, opts) => postMarketplaceCardBulk('/products/pull-card', payload, opts),

  /** Статус модуля обогащения для текущего аккаунта */
  enrichmentStatus: async () => {
    const response = await api.get('/products/enrichment/status');
    return response.data;
  },

  /** Обогатить карточку из PartsIndex */
  enrich: async (productId, body = {}) => {
    const id = encodeURIComponent(String(productId));
    const response = await api.post(`/products/${id}/enrich`, body, { timeout: 120000 });
    return response.data;
  },

  /** Массовое обогащение по списку { brand, sku } */
  enrichBulk: async (items, body = {}) => {
    const response = await api.post(
      '/products/enrichment/bulk',
      { items, ...body },
      { timeout: 600000 }
    );
    return response.data;
  },

  /**
   * Добавить штрихкод к товару, не удаляя существующие. Возвращает актуальную карточку (getById).
   */
  appendBarcode: async (productId, barcode) => {
    const add = coerceBarcodeString(barcode);
    if (!add || isCorruptBarcodeString(add)) {
      const err = new Error('Пустой штрихкод');
      err.statusCode = 400;
      throw err;
    }
    const id = Number(productId);
    if (!Number.isFinite(id) || id < 1) {
      const err = new Error('Некорректный товар');
      err.statusCode = 400;
      throw err;
    }
    const wrap = await api.get(`/products/${id}`);
    const body = wrap.data;
    const p = body?.data ?? body;
    if (!p?.id) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }
    const existing = normalizeBarcodeRows(p.barcodes);
    if (existing.some((r) => r.barcode === add)) {
      return p;
    }
    const merged = [...existing, { barcode: add, marketplaces: [] }];
    await api.put(`/products/${id}`, { barcodes: merged });
    const wrap2 = await api.get(`/products/${id}`);
    const body2 = wrap2.data;
    return body2?.data ?? body2;
  },

  /**
   * Изображения товара
   */
  getImages: async (id) => {
    const response = await api.get(`/products/${id}/images`);
    return response.data;
  },
  uploadImages: async (id, files = []) => {
    const form = new FormData();
    (files || []).forEach((f) => form.append('images', f));
    // Не задавать Content-Type вручную — иначе нет boundary; interceptor снимает json default для FormData
    const response = await api.post(`/products/${id}/images`, form);
    return response.data;
  },
  updateImages: async (id, images) => {
    const response = await api.put(`/products/${id}/images`, { images });
    return response.data;
  },
  /** Скачать изображения с МП в основные images (бейджи Oz/WB/ЯМ). Body: { urls } */
  importImagesFromMarketplace: async (id, marketplace, urls = []) => {
    const mp = encodeURIComponent(String(marketplace || '').toLowerCase());
    const response = await api.post(`/products/${id}/images/from-marketplace/${mp}`, {
      urls: Array.isArray(urls) ? urls : [],
    });
    return response.data;
  },
  /** Схлопнуть визуальные дубликаты галереи (одна картинка — бейджи нескольких МП). */
  collapseImageDuplicates: async (id) => {
    const response = await api.post(`/products/${id}/images/collapse-duplicates`);
    return response.data;
  },
  deleteImage: async (id, imageId) => {
    const response = await api.delete(`/products/${id}/images/${encodeURIComponent(String(imageId))}`);
    return response.data;
  },

  /**
   * Удалить товар
   */
  delete: async (id) => {
    const response = await api.delete(`/products/${id}`);
    return response.data;
  },

  /** Участие в заказах и движениях (можно ли удалить) */
  getParticipation: async (id) => {
    const response = await api.get(`/products/${id}/participation`);
    return response.data;
  },

  /** Отправить товар в архив */
  archive: async (id) => {
    const response = await api.post(`/products/${id}/archive`);
    return response.data;
  },

  /** Вернуть товар из архива */
  unarchive: async (id) => {
    const response = await api.post(`/products/${id}/unarchive`);
    return response.data;
  },

  /**
   * Обновить все товары (массовое обновление)
   */
  updateAll: async (products) => {
    const response = await api.put('/products/all', products);
    return response.data;
  },

  /**
   * Принудительно обновить остатки и цены у поставщиков
   * @param {number|null} productId - ID товара (опционально, если null - обновляет все товары)
   */
  refreshSupplierStocks: async (productId = null) => {
    let url = '/products/refresh-supplier-stocks';
    if (productId) {
      url += `?productId=${productId}`;
    }
    const response = await api.post(url, {}, {
      timeout: productId ? 120000 : 20000
    });
    return response.data;
  },

  refreshSupplierStocksStatus: async () => {
    const response = await api.get('/products/refresh-supplier-stocks/status', { timeout: 15000 });
    return response.data;
  }
};

