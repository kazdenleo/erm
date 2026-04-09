/**
 * Winston Logger Configuration
 * Продвинутое логирование с файлами и форматами
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { join } from 'path';
import fs from 'fs';
import config from '../config/index.js';

// Используем централизованную конфигурацию путей
const logsDir = config.paths.logsDir;

// Создаем папку для логов, если её нет
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Формат для development (красивый вывод)
const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += `\n${JSON.stringify(meta, null, 2)}`;
    }
    return msg;
  })
);

// Формат для production (JSON)
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Определяем формат в зависимости от окружения
const isDevelopment = process.env.NODE_ENV === 'development';
const logFormat = isDevelopment ? devFormat : prodFormat;

// Транспорты для логов
const transports = [
  // Консольный вывод
  new winston.transports.Console({
    level: isDevelopment ? 'debug' : 'info',
    format: logFormat
  }),
  
  // Общий лог файл (ротация по дням)
  new DailyRotateFile({
    filename: join(logsDir, 'app-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    level: 'info',
    format: prodFormat
  }),
  
  // Файл ошибок (ротация по дням)
  new DailyRotateFile({
    filename: join(logsDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '30d',
    level: 'error',
    format: prodFormat
  })
];

// Создаем logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  format: logFormat,
  transports,
  // Обработка исключений и rejections
  exceptionHandlers: [
    new DailyRotateFile({
      filename: join(logsDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d'
    })
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      filename: join(logsDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d'
    })
  ]
});

// Консоль уже в массиве transports выше — второй Console дублировал каждую строку в development

export default logger;

