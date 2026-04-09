/**
 * Products API Service
 * API сервис для работы с товарами
 */

import api from './api.js';

export const productsApi = {
  /**
   * Получить все товары
   * @param {object} [options] - options.cacheBust = true добавляет _t=timestamp чтобы не брать кэш (актуальные сохранённые цены)
   */
  getAll: async (options = {}) => {
    const params = { ...(options.cacheBust ? { _t: Date.now() } : {}) };
    if (options.organizationId != null && options.organizationId !== '') params.organizationId = options.organizationId;
    if (options.categoryId != null && options.categoryId !== '') params.categoryId = options.categoryId;
    if (options.search != null && String(options.search).trim() !== '') params.search = String(options.search).trim();
    if (options.productType != null && String(options.productType).trim() !== '') {
      params.productType = String(options.productType).trim();
    }
    if (options.warehouseId != null && options.warehouseId !== '') {
      params.warehouseId = String(options.warehouseId);
    }
    const response = await api.get('/products', { params: Object.keys(params).length ? params : undefined });
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
    return response.data;
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
    console.log('[Products API] Calling refreshSupplierStocks:', url);
    try {
      const response = await api.post(url);
      console.log('[Products API] Response status:', response.status);
      return response.data;
    } catch (error) {
      console.error('[Products API] Error calling refreshSupplierStocks:', error.response?.status, error.response?.statusText, error.message);
      console.error('[Products API] Request URL:', error.config?.url);
      throw error;
    }
  }
};

