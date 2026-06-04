/**
 * Products API Service
 * API сервис для работы с товарами
 */

import api from './api.js';
import { coerceBarcodeString, isCorruptBarcodeString, normalizeBarcodeRows } from '../utils/productBarcodes.js';

export const productsApi = {
  /** Сводка остатков по категориям для главной (лёгкий SQL на сервере). */
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
   * Связать товар с карточкой маркетплейса по артикулу ERP (кабинет организации).
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
    const response = await api.post(
      `/products/${id}/push-card/${mp}`,
      productPatch && typeof productPatch === 'object' ? productPatch : undefined
    );
    return response.data;
  },

  /**
   * Массовая отправка карточек на маркетплейсы.
   * @param {{ productIds: number[], marketplaces: string|string[] }} payload
   */
  pushCardBulk: async (payload) => {
    const response = await api.post('/products/push-card', payload);
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

