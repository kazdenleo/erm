/**
 * Server Entry Point
 * Точка входа для запуска сервера с graceful shutdown
 */

import app from './src/app.js';
import config from './src/config/index.js';
import logger from './src/utils/logger.js';
import { closePool, testConnection } from './src/config/database.js';
import schedulerService from './src/services/scheduler.service.js';

const PORT = config.port;
let server = null;

// Обработка необработанных исключений
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

// Обработка необработанных rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack,
  });
});

// Флаг для предотвращения множественных вызовов
let isShuttingDown = false;

// Graceful shutdown
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, forcing exit...');
    process.exit(1);
    return;
  }
  
  isShuttingDown = true;
  logger.info(`${signal} received, starting graceful shutdown...`);
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  // Общий таймаут для всего процесса shutdown (10 секунд)
  const forceExitTimeout = setTimeout(() => {
    logger.warn('Shutdown timeout exceeded, forcing exit...');
    console.log('Shutdown timeout, forcing exit...');
    process.exit(1);
  }, 10000);
  
  try {
    // Останавливаем планировщик
    schedulerService.stop();
    
    // Останавливаем прием новых запросов
    if (server) {
      await new Promise((resolve) => {
        server.close((err) => {
          if (err) {
            logger.error('Error closing server:', err);
          } else {
            logger.info('HTTP server closed');
            console.log('HTTP server closed');
          }
          resolve();
        });
        
        // Таймаут для принудительного закрытия сервера
        setTimeout(() => {
          logger.warn('Server close timeout, continuing shutdown...');
          resolve();
        }, 5000);
      });
    }
    
    // Закрываем подключения к БД
    if (config.database.usePostgreSQL) {
      try {
        await Promise.race([
          closePool(),
          new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
        logger.info('Database connections closed');
      } catch (error) {
        logger.warn('Error closing database pool:', error);
      }
    }
    
    clearTimeout(forceExitTimeout);
    logger.info('Graceful shutdown completed');
    console.log('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimeout);
    logger.error('Error during shutdown:', error);
    console.error('Error during shutdown:', error.message);
    process.exit(1);
  }
}

// Обработка сигналов завершения
// SIGINT (Ctrl+C) - работает на всех платформах
process.on('SIGINT', () => {
  if (!isShuttingDown) {
    console.log('\n[SIGINT] Received, shutting down gracefully...');
    gracefulShutdown('SIGINT').catch((err) => {
      logger.error('Shutdown error:', err);
      process.exit(1);
    });
  }
});

// SIGTERM - работает на Unix-системах
process.on('SIGTERM', () => {
  if (!isShuttingDown) {
    gracefulShutdown('SIGTERM').catch((err) => {
      logger.error('Shutdown error:', err);
      process.exit(1);
    });
  }
});

// Запуск сервера
async function startServer() {
  try {
    // Проверяем подключение к БД перед запуском
    if (config.database.usePostgreSQL) {
      const dbConnected = await testConnection();
      if (!dbConnected && config.isProduction) {
        logger.error('Database connection failed. Exiting...');
        process.exit(1);
      }
    }
    
    // Запускаем HTTP сервер
    server = app.listen(PORT, async () => {
      logger.info('========================================');
      logger.info('  ERP Server Started Successfully!');
      logger.info('========================================');
      logger.info(`Environment: ${config.nodeEnv}`);
      logger.info(`Listening on http://localhost:${PORT}`);
      logger.info(`API available at http://localhost:${PORT}/api`);
      logger.info(`Health check: http://localhost:${PORT}/health`);
      logger.info(`Client URL: ${config.clientUrl}`);
      logger.info('========================================');
      
      // Полный планировщик — при PostgreSQL; фоновая синхронизация заказов — всегда (и без PG)
      if (config.database.usePostgreSQL) {
        try {
          await schedulerService.init();
        } catch (error) {
          logger.warn('Failed to initialize scheduler:', error);
          try {
            await schedulerService.startOrdersFbsBackgroundSyncOnly();
          } catch (e2) {
            logger.warn('FBS-only scheduler failed:', e2?.message || e2);
          }
        }
      } else {
        logger.info('PostgreSQL отключён: ночные задачи планировщика не запускаются; заказы FBS — по расписанию на сервере.');
        try {
          await schedulerService.startOrdersFbsBackgroundSyncOnly();
        } catch (error) {
          logger.warn('Failed to start FBS orders background sync:', error?.message || error);
        }
      }
    });
    
    // Обработка ошибок сервера
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use`);
      } else {
        logger.error('Server error', {
          error: error.message,
          stack: error.stack,
        });
      }
      process.exit(1);
    });
    
  } catch (error) {
    logger.error('Failed to start server', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Запускаем сервер
startServer();
