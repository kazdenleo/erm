/**
 * Логирование медленных HTTP-запросов (диагностика 504 от nginx).
 */

import logger from '../utils/logger.js';

export function slowRequestLogger(thresholdMs = 15000) {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      if (ms < thresholdMs) return;
      logger.warn('[Slow request]', {
        method: req.method,
        url: req.originalUrl || req.url,
        status: res.statusCode,
        durationMs: ms,
      });
    });
    next();
  };
}
