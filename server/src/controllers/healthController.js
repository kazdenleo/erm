/**
 * Health Check Controller
 * Проверка состояния сервера и подключений
 */

import { query, getPoolStats } from '../config/database.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import ordersSyncService from '../services/orders.sync.service.js';

let serverStartTime = Date.now();

/**
 * Проверка подключения к базе данных (общий пул приложения, без второго Pool).
 */
async function checkDatabase() {
  if (!config.database.usePostgreSQL) {
    return { status: 'skipped', message: 'PostgreSQL not configured' };
  }

  try {
    await query('SELECT 1');
    const pool = getPoolStats();
    return {
      status: 'ok',
      message: 'Database connection successful',
      ...(pool ? { pool } : {}),
    };
  } catch (error) {
    logger.error('Database health check failed:', error);
    return {
      status: 'error',
      message: 'Database connection failed',
      error: error.message,
      pool: getPoolStats(),
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

  const ordersSync = ordersSyncService.getSyncFbsStatus();
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: `${uptime}s`,
    environment: config.nodeEnv,
    version: '1.0.0',
    build: '2026-05-29-db-pool',
    services: {
      server: { status: 'ok' },
      database: dbHealth,
      ordersFbsSync: {
        inProgress: Boolean(ordersSync.inProgress),
        lastSyncError: ordersSync.lastSyncError ?? null,
        syncStartedAt: ordersSync.syncStartedAt ?? null,
      },
    },
  };

  const httpStatus = dbHealth.status === 'ok' || dbHealth.status === 'skipped' ? 200 : 503;

  res.status(httpStatus).json(health);
}
