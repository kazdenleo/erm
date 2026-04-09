/**
 * Health Check Controller
 * Проверка состояния сервера и подключений
 */

import { Pool } from 'pg';
import config from '../config/index.js';
import logger from '../utils/logger.js';

let serverStartTime = Date.now();
let dbPool = null;

// Инициализация пула подключений для проверки
// Создаем пул только если PostgreSQL включен и конфигурация корректна
if (config.database.usePostgreSQL) {
  try {
    const poolConfig = {
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      max: 1, // Для health check достаточно 1 соединения
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    };
    
    // Добавляем password только если он указан (не пустая строка)
    if (config.database.password && config.database.password.trim() !== '') {
      poolConfig.password = config.database.password;
    }
    
    dbPool = new Pool(poolConfig);
    
    // Логируем настройки подключения (без пароля) для отладки
    logger.debug('Health check DB pool initialized', {
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      hasPassword: !!config.database.password && config.database.password.trim() !== '',
    });
  } catch (error) {
    logger.warn('Failed to initialize DB pool for health check:', error);
    dbPool = null;
  }
}

/**
 * Проверка подключения к базе данных
 */
async function checkDatabase() {
  if (!config.database.usePostgreSQL || !dbPool) {
    return { status: 'skipped', message: 'PostgreSQL not configured' };
  }

  try {
    const client = await dbPool.connect();
    await client.query('SELECT 1');
    client.release();
    return { status: 'ok', message: 'Database connection successful' };
  } catch (error) {
    logger.error('Database health check failed:', error);
    return {
      status: 'error',
      message: 'Database connection failed',
      error: error.message,
    };
  }
}

/**
 * GET /health
 * Health check endpoint
 */
export async function getHealth(req, res) {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  const dbHealth = await checkDatabase();

  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: `${uptime}s`,
    environment: config.nodeEnv,
    version: '1.0.0',
    services: {
      server: { status: 'ok' },
      database: dbHealth,
    },
  };

  // Если база данных недоступна, возвращаем 503
  const httpStatus = dbHealth.status === 'ok' || dbHealth.status === 'skipped' ? 200 : 503;

  res.status(httpStatus).json(health);
}

