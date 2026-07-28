/**
 * API Client
 * Базовый клиент для работы с API
 */

import axios from 'axios';
import { getApiSessionContext, setApiSessionContext } from './apiSession.js';
import { clearStoredOrganizationId } from '../utils/organizationSessionSync.js';

/** База API для axios, window.open печати и т.п. Экспортируем, чтобы другие клиентские модули не дублировали логику. */
export function resolveApiBaseUrl() {
  const env = process.env.REACT_APP_API_URL;
  // На HTTPS-странице браузер блокирует любые XHR на http:// (Mixed Content).
  // Поэтому для прод-HTTPS всегда используем относительный '/api' (через тот же origin).
  try {
    if (typeof window !== 'undefined' && window.location?.protocol === 'https:') {
      if (env && /^http:\/\//i.test(String(env))) return '/api';
    }
  } catch {
    // ignore
  }
  const base = env && String(env).trim() !== '' ? String(env).trim() : '/api';
  if (typeof base === 'string' && /^https?:\/\//i.test(base)) {
    const trimmed = base.replace(/\/+$/, '');
    // Один билд часто задаёт только origin; бэкенд смонтирован на /api (см. app.use('/api', routes)).
    if (!/\/api$/i.test(trimmed)) {
      return `${trimmed}/api`;
    }
    return trimmed;
  }
  return base;
}

const API_BASE_URL = resolveApiBaseUrl();

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  // Обычные запросы. Долгие bulk МП (push/pull-card) задают timeout локально (см. products.api).
  timeout: 90000
});

function isAuthBootstrapRequest(config) {
  const path = String(config?.url || '').split('?')[0].replace(/^\/+/, '');
  return (
    (config?.method === 'post' && path === 'auth/login') ||
    (config?.method === 'post' && path === 'auth/register-account') ||
    (config?.method === 'get' && path === 'auth/me')
  );
}

/** Раздел «Склад» — всегда узкий список товаров (защита от старого бандла без stockList). */
function applyStockLevelsProductsListParams(config) {
  if (String(config?.method || '').toLowerCase() !== 'get') return;
  const path = String(config?.url || '').split('?')[0].replace(/^\/+/, '');
  if (path !== 'products') return;
  let onStockPage = false;
  try {
    onStockPage =
      typeof window !== 'undefined' &&
      String(window.location?.pathname || '').includes('/stock-levels');
  } catch {
    onStockPage = false;
  }
  if (!onStockPage) return;

  const params = { ...(config.params || {}) };
  if (params.listView === 'full' || params.forExport === 'true' || params.forExport === '1') {
    return;
  }
  // Поиск по артикулу/названию — по всей номенклатуре, не только по строкам остатков «в наличии».
  if (params.search != null && String(params.search).trim() !== '') {
    params.listView = 'full';
    delete params.inStockOnly;
    delete params.stockList;
    return;
  }
  if (params.listView !== 'stock') params.listView = 'stock';
  if (params.stockList == null || params.stockList === '') params.stockList = '1';
  if (params.limit == null || params.limit === '') params.limit = '50';
  if (params.inStockOnly == null || params.inStockOnly === '') {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('stockListInStockOnly') === '1') {
        params.inStockOnly = '1';
      }
    } catch {
      /* ignore */
    }
  }
  config.params = params;
  config.headers = config.headers || {};
  config.headers['X-ERM-Client-Route'] = 'stock-levels';
}

// Request interceptor
api.interceptors.request.use(
  (config) => {
    // Добавляем токен авторизации, если есть
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    if (!isAuthBootstrapRequest(config)) {
      const { accountId, organizationId } = getApiSessionContext();
      if (accountId) {
        config.headers['X-Account-Id'] = accountId;
      }
      if (organizationId) {
        config.headers['X-Organization-Id'] = organizationId;
      }
    }

    // FormData + дефолтный Content-Type: application/json ломает multipart (нет boundary) — файл не доходит до multer
    if (config.data instanceof FormData) {
      if (typeof config.headers?.delete === 'function') {
        config.headers.delete('Content-Type');
      } else {
        delete config.headers['Content-Type'];
      }
    }

    applyStockLevelsProductsListParams(config);

    // Логируем запросы на обновление складов
    if (config.method === 'put' && config.url && config.url.includes('/warehouses/')) {
      console.log('[API] PUT request to warehouses:', config.url);
      console.log('[API] Request data:', config.data);
      console.log('[API] Request data keys:', config.data ? Object.keys(config.data) : 'no data');
      console.log('[API] Request data.wbWarehouseName:', config.data?.wbWarehouseName);
      console.log('[API] Request data JSON:', JSON.stringify(config.data, null, 2));
    }
    
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    const code = error.response?.data?.code;

    if (status === 403 && (code === 'ORGANIZATION_CONTEXT_MISMATCH' || code === 'ACCOUNT_CONTEXT_MISMATCH')) {
      clearStoredOrganizationId();
      if (code === 'ACCOUNT_CONTEXT_MISMATCH') {
        setApiSessionContext({ accountId: null, organizationId: null });
      }
      try {
        window.dispatchEvent(new CustomEvent('erp:organization-context-invalid', { detail: { code } }));
      } catch {
        /* ignore */
      }
      const cfg = error.config;
      if (cfg && !cfg._contextMismatchRetry) {
        cfg._contextMismatchRetry = true;
        if (cfg.headers) {
          if (code === 'ORGANIZATION_CONTEXT_MISMATCH' || code === 'ACCOUNT_CONTEXT_MISMATCH') {
            delete cfg.headers['X-Organization-Id'];
          }
          if (code === 'ACCOUNT_CONTEXT_MISMATCH') {
            delete cfg.headers['X-Account-Id'];
          }
        }
        return api.request(cfg);
      }
    }

    // Обработка ошибок
    if (status === 401) {
      localStorage.removeItem('token');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    // Не логировать в консоль ожидаемые 404 от поиска по штрихкоду (товар/заказ не найден)
    const isAssemblyFind = error.config?.url?.includes('/assembly/find-by-barcode');
    if (error.response?.status === 404 && isAssemblyFind) {
      // Ошибка уже обрабатывается на странице сборки
    } else if (error.config?.silentConsole === true) {
      /* вызывающий код обрабатывает ошибку без шума в консоли */
    } else if (error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
      /* отмена запроса при размонтировании / смене фильтра — не ошибка API */
    } else if (error.code === 'ECONNABORTED') {
      /* таймаут — сообщение показываем в UI страницы */
    } else if (
      error.response?.status === 400 &&
      String(error.config?.url || '').includes('/marketplace-attributes')
    ) {
      /* ожидаемые ответы без ключа МП / сопоставления категории */
    } else {
      const status = error.response?.status;
      const data = error.response?.data;
      const msg = data?.message || data?.error || error.message;
      console.error('[API Error]', status ? `HTTP ${status}` : error.code || error.message, msg || '', data || '');
    }
    return Promise.reject(error);
  }
);

export default api;

