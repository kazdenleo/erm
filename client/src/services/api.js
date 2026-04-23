/**
 * API Client
 * Базовый клиент для работы с API
 */

import axios from 'axios';
import { getApiSessionContext } from './apiSession.js';

function resolveApiBaseUrl() {
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
  return env || '/api';
}

const API_BASE_URL = resolveApiBaseUrl();

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  // 30s часто не хватает для синхронизации маркетплейсов и операций с поставками WB
  timeout: 90000
});

// Request interceptor
api.interceptors.request.use(
  (config) => {
    // Добавляем токен авторизации, если есть
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    const { accountId, organizationId } = getApiSessionContext();
    if (accountId) {
      config.headers['X-Account-Id'] = accountId;
    }
    if (organizationId) {
      config.headers['X-Organization-Id'] = organizationId;
    }

    // FormData + дефолтный Content-Type: application/json ломает multipart (нет boundary) — файл не доходит до multer
    if (config.data instanceof FormData) {
      if (typeof config.headers?.delete === 'function') {
        config.headers.delete('Content-Type');
      } else {
        delete config.headers['Content-Type'];
      }
    }
    
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
  (error) => {
    // Обработка ошибок
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    // Не логировать в консоль ожидаемые 404 от поиска по штрихкоду (товар/заказ не найден)
    const isAssemblyFind = error.config?.url?.includes('/assembly/find-by-barcode');
    if (error.response?.status === 404 && isAssemblyFind) {
      // Ошибка уже обрабатывается на странице сборки
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

