/**
 * Global Error Handler Middleware
 * Централизованная обработка всех ошибок приложения
 */

import logger from '../utils/logger.js';
import {
  isOzonSellerApiErrorMessage,
  parseOzonSellerApiHttpStatus
} from '../utils/ozon-api-error.js';

/**
 * Обработка ошибок Express
 */
export function errorHandler(err, req, res, next) {
  // Определяем статус код (нужен до логирования)
  let statusCode = err.statusCode || err.status || 500;

  // 404 — обычно не ошибка приложения; без полного stack в error-логах
  if (statusCode === 404) {
    logger.debug(`HTTP 404 ${req.method} ${req.url}`);
  } else {
    logger.error('Error occurred', {
      message: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      body: req.body,
      query: req.query,
      params: req.params
    });
  }

  // statusCode уже задан выше
  let message = err.message || 'Internal Server Error';
  let details = null;

  // Обработка ошибок базы данных - возвращаем 400 вместо 500
  if (err.code === '42P01' || message.includes('does not exist') || message.includes('relation')) {
    statusCode = 400;
    if (message.includes('wb_commissions')) {
      message = 'Таблица wb_commissions не существует в базе данных. Необходимо выполнить миграции базы данных. Запустите команду: npm run migrate в папке server';
    } else if (message.includes('calculation_details')) {
      message = 'Колонка calculation_details отсутствует в таблице product_marketplace_prices. Выполните миграции: в папке server запустите команду npm run migrate';
    } else {
      message = `Таблица не существует: ${message}. Выполните миграции базы данных.`;
    }
  }

  // Обработка ошибок Ozon Seller API (не любое вхождение слова «ozon» в тексте)
  if (isOzonSellerApiErrorMessage(message)) {
    statusCode = 400;
    const apiStatusCode = parseOzonSellerApiHttpStatus(message);
    const detail =
      message.length > 280 ? `${message.slice(0, 280)}…` : message;

    if (apiStatusCode === '404') {
      message =
        'API Ozon вернул ошибку 404. Возможно, неправильный URL endpoint или неверные учетные данные. Проверьте Client ID и API Key в настройках интеграции. Убедитесь, что используете актуальные учетные данные из личного кабинета Ozon Seller.';
    } else if (apiStatusCode === '401' || apiStatusCode === '403') {
      message =
        'Ошибка авторизации в API Ozon. Проверьте правильность Client ID и API Key в настройках интеграции.';
    } else if (apiStatusCode === '429') {
      message = 'Превышен лимит запросов к API Ozon. Попробуйте позже.';
    } else if (apiStatusCode) {
      message = `Ошибка API Ozon (HTTP ${apiStatusCode}). Проверьте настройки интеграции и текст ответа ниже.\n${detail}`;
    } else {
      message = `Ошибка при обращении к Ozon. Детали:\n${detail}`;
    }
  }

  // Обработка специфичных типов ошибок
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation Error';
    details = err.details || err.errors;
  } else if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid ID format';
  } else if (err.code === '23505') {
    // PostgreSQL unique violation
    statusCode = 409;
    message = 'Duplicate entry';
    details = err.detail;
  } else if (err.code === '23503') {
    // PostgreSQL foreign key violation
    statusCode = 400;
    message = 'Foreign key constraint violation';
    details = err.detail;
  } else if (err.code === '23502') {
    // PostgreSQL not null violation
    statusCode = 400;
    message = 'Required field is missing';
    details = err.column;
  } else if (err.code === 'ECONNREFUSED') {
    statusCode = 503;
    message = 'Database connection failed';
  } else if (err.code === 'ENOTFOUND') {
    statusCode = 503;
    message = 'Service unavailable';
  }

  // Формируем ответ
  const response = {
    success: false,
    message,
    ...(details && { details }),
    ...(process.env.NODE_ENV === 'development' && {
      stack: err.stack,
      error: err.name
    })
  };

  res.status(statusCode).json(response);
}

/**
 * Обработка 404 ошибок
 */
export function notFoundHandler(req, res, next) {
  const error = new Error(`Route not found: ${req.method} ${req.url}`);
  error.statusCode = 404;
  next(error);
}

/**
 * Async error wrapper для контроллеров
 * Использование: wrapAsync(async (req, res, next) => { ... })
 */
export function wrapAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
