/**
 * Request Logger Middleware
 * Логирование HTTP запросов с использованием Morgan + Winston
 */

import morgan from 'morgan';
import logger from '../utils/logger.js';

// Создаем stream для Morgan, который пишет в Winston
const stream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

// Формат для development
const devFormat = ':method :url :status :response-time ms - :res[content-length]';

// Формат для production (более компактный)
const prodFormat = ':remote-addr :method :url :status :response-time ms :res[content-length]';

const format = process.env.NODE_ENV === 'development' ? devFormat : prodFormat;

// Создаем middleware
const requestLogger = morgan(format, {
  stream,
  skip: (req, res) => {
    // Пропускаем health check запросы в production
    return process.env.NODE_ENV === 'production' && req.url === '/health';
  }
});

export default requestLogger;

