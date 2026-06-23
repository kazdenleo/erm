/**
 * Database Configuration
 * Конфигурация подключения к PostgreSQL с пулом соединений и graceful shutdown
 */

import '../load-env.js';
import pg from 'pg';
import config from './index.js';
import { envFlag } from '../load-env.js';
import logger from '../utils/logger.js';

const { Pool } = pg;

function shouldUsePostgreSQL() {
  if (envFlag('USE_POSTGRESQL', true)) return true;
  return config.database?.usePostgreSQL === true;
}

// Создаем пул соединений только если PostgreSQL включен
let pool = null;
/** После graceful shutdown новые запросы к БД не открывают пул заново. */
let poolClosed = false;

function buildPoolConfig() {
  const poolConfig = {
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    max: config.database.pool.max,
    min: config.database.pool.min,
    idleTimeoutMillis: config.database.pool.idleTimeoutMillis,
    connectionTimeoutMillis: config.database.pool.connectionTimeoutMillis,
    allowExitOnIdle: false,
  };

  if (config.database.password && config.database.password.trim() !== '') {
    poolConfig.password = config.database.password;
  }

  return poolConfig;
}

function attachPoolListeners(activePool) {
  activePool.on('error', (err) => {
    logger.error('Unexpected error on idle database client', {
      error: err.message,
      stack: err.stack,
    });
  });

  if (config.isDevelopment) {
    activePool.on('connect', () => {
      logger.debug('New database client connected');
    });

    activePool.on('acquire', () => {
      logger.debug('Database client acquired from pool');
    });

    activePool.on('remove', () => {
      logger.debug('Database client removed from pool');
    });
  }
}

function createPoolInstance() {
  const activePool = new Pool(buildPoolConfig());
  attachPoolListeners(activePool);
  return activePool;
}

function ensurePool() {
  if (poolClosed) return null;
  if (pool) return pool;
  if (!shouldUsePostgreSQL()) return null;
  pool = createPoolInstance();
  return pool;
}

if (shouldUsePostgreSQL()) {
  pool = createPoolInstance();
}

/**
 * Функция для выполнения запросов
 */
export async function query(text, params) {
  const activePool = ensurePool();
  if (!activePool) {
    throw new Error('PostgreSQL pool is not initialized. Check USE_POSTGRESQL setting.');
  }

  const start = Date.now();
  try {
    const res = await activePool.query(text, params);
    const duration = Date.now() - start;
    
    if (config.isDevelopment) {
      logger.debug('Database query executed', {
        query: text.substring(0, 100),
        duration: `${duration}ms`,
        rows: res.rowCount,
      });
    }
    
    return res;
  } catch (error) {
    const msg = String(error?.message || '');
    if (/timeout exceeded when trying to connect|too many clients/i.test(msg)) {
      logger.warn('Database pool exhausted on query', { ...getPoolStats(), query: text.substring(0, 80) });
      const err = new Error(
        'База данных перегружена (нет свободных соединений). Подождите несколько секунд и повторите.'
      );
      err.statusCode = 503;
      err.code = error.code;
      throw err;
    }
    logger.error('Database query error', {
      query: text.substring(0, 100),
      error: error.message,
      code: error.code,
    });
    throw error;
  }
}

/**
 * Функция для получения клиента из пула (для транзакций)
 */
export async function getClient() {
  const activePool = ensurePool();
  if (!activePool) {
    throw new Error('PostgreSQL pool is not initialized. Check USE_POSTGRESQL setting.');
  }

  let client;
  try {
    client = await activePool.connect();
  } catch (error) {
    const stats = getPoolStats();
    const msg = String(error?.message || '');
    if (/timeout exceeded when trying to connect|too many clients/i.test(msg)) {
      logger.warn('Database pool exhausted on connect', stats);
      const err = new Error(
        'База данных перегружена (нет свободных соединений). Подождите несколько секунд и повторите.'
      );
      err.statusCode = 503;
      err.code = error.code;
      throw err;
    }
    throw error;
  }
  const query = client.query.bind(client);
  const release = client.release.bind(client);
  
  // Устанавливаем таймаут для клиента (предупреждение)
  const timeout = setTimeout(() => {
    logger.warn('Database client has been checked out for more than 5 seconds', {
      query: client.lastQuery,
    });
  }, 5000);
  
  // Переопределяем release для очистки таймаута
  client.release = () => {
    clearTimeout(timeout);
    return release();
  };
  
  return client;
}

/**
 * Функция для выполнения транзакции
 */
export async function transaction(callback, { lockTimeoutMs = 20000, statementTimeoutMs = 120000 } = {}) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (lockTimeoutMs > 0) {
      await client.query(`SET LOCAL lock_timeout = '${Math.floor(lockTimeoutMs)}ms'`);
    }
    if (statementTimeoutMs > 0) {
      await client.query(`SET LOCAL statement_timeout = '${Math.floor(statementTimeoutMs)}ms'`);
    }
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (String(error?.code) === '55P03' || /lock timeout/i.test(String(error?.message || ''))) {
      const err = new Error(
        'Не удалось завершить операцию: база данных занята другим процессом. Подождите 30 секунд и повторите.'
      );
      err.statusCode = 503;
      throw err;
    }
    logger.error('Transaction rolled back', {
      error: error.message,
    });
    throw error;
  } finally {
    client.release();
  }
}

/** Статистика пула (для /health и диагностики перегрузки). */
export function getPoolStats() {
  const activePool = ensurePool();
  if (!activePool) return null;
  return {
    total: activePool.totalCount,
    idle: activePool.idleCount,
    waiting: activePool.waitingCount,
    max: activePool.options?.max ?? null,
  };
}

/**
 * Функция для проверки подключения
 */
export async function testConnection() {
  const activePool = ensurePool();
  if (!activePool) {
    logger.warn('PostgreSQL pool is not initialized');
    return false;
  }

  try {
    const result = await query('SELECT NOW() as now, version() as version');
    logger.info('Database connection successful', {
      timestamp: result.rows[0].now,
      version: result.rows[0].version.substring(0, 50),
    });
    return true;
  } catch (error) {
    logger.error('Database connection failed', {
      error: error.message,
      code: error.code,
    });
    return false;
  }
}

/**
 * Graceful shutdown - закрытие пула соединений
 */
export async function closePool() {
  if (!pool) {
    poolClosed = true;
    return;
  }

  const p = pool;
  pool = null;
  poolClosed = true;
  try {
    logger.info('Closing database pool...');
    await p.end();
    logger.info('Database pool closed successfully');
  } catch (error) {
    logger.error('Error closing database pool', {
      error: error.message,
    });
  }
}

export function isPoolAvailable() {
  return !poolClosed && Boolean(ensurePool());
}

export default pool;
