/**
 * Security Middleware
 * Настройка безопасности API (Helmet, CORS, Rate Limiting)
 */

import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import config from '../config/index.js';

/**
 * Helmet configuration
 * Защита от различных уязвимостей
 */
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false, // Для API обычно не нужен
});

/**
 * CORS configuration
 * Разрешаем только указанный фронтенд URL
 */
export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // В development разрешаем все (для удобства разработки)
    if (config.isDevelopment && !origin) {
      return callback(null, true);
    }
    
    // В production проверяем origin
    const allowedOrigins = [
      config.clientUrl,
      ...(process.env.ALLOWED_ORIGINS?.split(',') || [])
    ];
    
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Account-Id',
    'X-Organization-Id',
  ],
  exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Per-Page', 'X-Products-Exported'],
});

/**
 * Rate Limiting
 * Ограничение количества запросов
 */
export const rateLimiter = rateLimit({
  windowMs: config.api.rateLimit.windowMs,
  // Для ERP типичны пакетные операции (пересчёт цен сотен товаров = сотни запросов за минуты).
  // Настройка: API_RATE_LIMIT_MAX, API_RATE_LIMIT_WINDOW_MINUTES в .env
  max: config.api.rateLimit.max,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true, // Возвращает rate limit info в заголовках
  legacyHeaders: false,
  // Пропускаем health check
  skip: (req) => req.url === '/health',
});

/**
 * Strict rate limiter для критичных endpoints
 * (например, авторизация, синхронизация)
 */
export const strictRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 10, // Максимум 10 запросов
  message: {
    success: false,
    message: 'Too many requests to this endpoint, please try again later.',
  },
});

/**
 * JSON body size limit middleware
 * Ограничение размера JSON тела запроса
 */
export const jsonSizeLimit = (limit = '1mb') => {
  return (req, res, next) => {
    const contentLength = req.get('content-length');
    if (contentLength) {
      const sizeInBytes = parseInt(contentLength, 10);
      const limitInBytes = parseSize(limit);
      
      if (sizeInBytes > limitInBytes) {
        return res.status(413).json({
          success: false,
          message: `Request entity too large. Maximum size is ${limit}`,
        });
      }
    }
    next();
  };
};

/**
 * Парсинг размера (например, '1mb' -> 1048576)
 */
function parseSize(size) {
  const units = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };
  
  const match = size.toLowerCase().match(/^(\d+)([a-z]+)$/);
  if (!match) return 1024 * 1024; // По умолчанию 1MB
  
  const [, value, unit] = match;
  return parseInt(value, 10) * (units[unit] || 1);
}

