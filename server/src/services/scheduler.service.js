/**
 * Scheduler Service
 * Сервис для планирования периодических задач (cron jobs)
 *
 * Минимальные цены по маркетплейсам:
 * Комиссии и справочники MP обновляются примерно раз в сутки (ночные задачи 1:00–2:00 МСК).
 * После этого один раз за сутки выполняется полный прогон: синхронизация кэша калькулятора из API
 * и пересчёт мин. цен по всему каталогу из БД (см. MIN_PRICES_NIGHTLY_CRON).
 * В течение дня при изменении карточки (себестоимость, габариты, категория и т.д.) достаточно
 * точечного пересчёта — POST .../recalculate-one (по умолчанию live API для затронутого товара).
 */

import logger from '../utils/logger.js';
import { readData } from '../utils/storage.js';
import wbMarketplaceService from './wbMarketplace.service.js';
import integrationsService from './integrations.service.js';
import pricesService from './prices.service.js';
import ordersSyncService from './orders.sync.service.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';

/** Фоновая синхронизация FBS-заказов (Ozon/WB/Яндекс). Выкл: ORDERS_FBS_SYNC_ENABLED=0 */
function isOrdersFbsSyncEnabled() {
  const v = process.env.ORDERS_FBS_SYNC_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Cron (node-cron, Europe/Moscow). По умолчанию каждые 2 мин; переопределение: ORDERS_FBS_SYNC_CRON */
function getOrdersFbsSyncCronExpression() {
  const c = process.env.ORDERS_FBS_SYNC_CRON;
  return c && String(c).trim() ? String(c).trim() : '*/2 * * * *';
}

/**
 * Ночной полный пересчёт мин. цен: после обновления комиссий/категорий (последняя пачка — YM в 2:00 МСК).
 * По умолчанию 3:15 МСК — запас после ночных справочников; переопределение: MIN_PRICES_NIGHTLY_CRON.
 */
function getMinPricesNightlyCron() {
  const c = process.env.MIN_PRICES_NIGHTLY_CRON;
  return c && String(c).trim() ? String(c).trim() : '15 3 * * *';
}

/** Для fallback-планировщика: минут от 01:00 МСК до запуска полного пересчёта (должно совпадать с дефолтным cron). */
const FALLBACK_MIN_PRICES_MINUTES_AFTER_1AM = 135; // 01:00 + 2ч15м = 03:15

/** Если 1|true — прежний сценарий: только recalculateAndSaveAll() (live API на каждый товар). */
function isMinPricesLegacyLiveRecalc() {
  const v = process.env.MIN_PRICES_NIGHTLY_LEGACY_LIVE;
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

function getCalculatorCacheSyncDelayMs() {
  const n = Number(process.env.MP_CALC_CACHE_SYNC_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 150;
}

class SchedulerService {
  constructor() {
    this.jobs = [];
    this.isRunning = false;
    /** Только FBS-заказы без полного init() (нет PostgreSQL или корневой server.js) */
    this.ordersFbsStandaloneStarted = false;
    this.ordersFbsStandaloneIntervalId = null;
  }

  /**
   * Инициализация планировщика
   */
  async init() {
    if (this.isRunning) {
      logger.warn('[Scheduler] Already initialized');
      return;
    }

    // Проверяем наличие комиссий WB и загружаем при необходимости
    await this.checkAndLoadInitialData();

    // Однократная проверка API интеграций при старте (для уведомлений)
    try {
      const marketplaces = ['ozon', 'wildberries', 'yandex'];
      for (const code of marketplaces) {
        try {
          const config = await integrationsService.getMarketplaceConfig(code);
          const hasKey = config?.api_key != null && String(config.api_key).trim() !== '';
          if (!hasKey) continue;
          await integrationsService.getMarketplaceTokenStatus(code);
        } catch (err) {
          logger.warn(`[Scheduler] Startup API check ${code}:`, err?.message);
        }
      }
    } catch (e) {
      logger.warn('[Scheduler] Startup API check failed:', e?.message);
    }

    try {
      // Используем node-cron для планирования задач
      const cron = await import('node-cron');
      
      // Обновление категорий и комиссий WB каждый день в 1:00 ночи
      const wbUpdateJob = cron.schedule('0 1 * * *', async () => {
        logger.info('[Scheduler] Starting scheduled WB categories and commissions update...');
        try {
          await wbMarketplaceService.updateCategoriesAndCommissions();
          logger.info('[Scheduler] WB update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] WB update failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'error',
            source: 'scheduler',
            title: 'Сбой ночного обновления WB',
            message: `WB categories/commissions update failed: ${error?.message || String(error)}`,
            marketplace: 'wildberries'
          });
        }
      }, {
        scheduled: false, // Не запускаем автоматически, запустим вручную
        timezone: 'Europe/Moscow'
      });

      // Обновление тарифов WB каждый день в 1:00 ночи
      const wbTariffsJob = cron.schedule('0 1 * * *', async () => {
        logger.info('[Scheduler] Starting scheduled WB tariffs update...');
        try {
          await integrationsService.updateWildberriesTariffs();
          logger.info('[Scheduler] WB tariffs update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] WB tariffs update failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'error',
            source: 'scheduler',
            title: 'Сбой ночного обновления тарифов WB',
            message: `WB tariffs update failed: ${error?.message || String(error)}`,
            marketplace: 'wildberries'
          });
        }
      }, {
        scheduled: false, // Не запускаем автоматически, запустим вручную
        timezone: 'Europe/Moscow'
      });

      // Обновление комиссий WB каждый день в 1:00 ночи
      const wbCommissionsJob = cron.schedule('0 1 * * *', async () => {
        logger.info('[Scheduler] Starting scheduled WB commissions update...');
        try {
          await integrationsService.updateWildberriesCommissions();
          logger.info('[Scheduler] WB commissions update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] WB commissions update failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'error',
            source: 'scheduler',
            title: 'Сбой ночного обновления комиссий WB',
            message: `WB commissions update failed: ${error?.message || String(error)}`,
            marketplace: 'wildberries'
          });
        }
      }, {
        scheduled: false, // Не запускаем автоматически, запустим вручную
        timezone: 'Europe/Moscow'
      });

      // Обновление списка акций Ozon каждый день в 1:00 ночи
      const ozonActionsJob = cron.schedule('0 1 * * *', async () => {
        logger.info('[Scheduler] Starting scheduled Ozon actions update...');
        try {
          await pricesService.updateAndCacheOzonActions();
          logger.info('[Scheduler] Ozon actions update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] Ozon actions update failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'error',
            source: 'scheduler',
            title: 'Сбой ночного обновления акций Ozon',
            message: `Ozon actions update failed: ${error?.message || String(error)}`,
            marketplace: 'ozon'
          });
        }
      }, {
        scheduled: false,
        timezone: 'Europe/Moscow'
      });

      // Обновление категорий Ozon каждый день в 1:30 ночи (после WB, чтобы не перегружать API)
      const ozonCategoriesJob = cron.schedule('30 1 * * *', async () => {
        logger.info('[Scheduler] Starting scheduled Ozon categories update...');
        try {
          await integrationsService.updateOzonCategories();
          logger.info('[Scheduler] Ozon categories update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] Ozon categories update failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'error',
            source: 'scheduler',
            title: 'Сбой ночного обновления категорий Ozon',
            message: `Ozon categories update failed: ${error?.message || String(error)}`,
            marketplace: 'ozon'
          });
        }
      }, {
        scheduled: false, // Не запускаем автоматически, запустим вручную
        timezone: 'Europe/Moscow'
      });

      // Обновление категорий Яндекс.Маркета каждый день в 2:00 ночи
      const ymCategoriesJob = cron.schedule('0 2 * * *', async () => {
        logger.info('[Scheduler] Starting scheduled Yandex categories update...');
        try {
          await integrationsService.updateYandexCategories();
          logger.info('[Scheduler] Yandex categories update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] Yandex categories update failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'error',
            source: 'scheduler',
            title: 'Сбой ночного обновления категорий Я.Маркет',
            message: `Yandex categories update failed: ${error?.message || String(error)}`,
            marketplace: 'yandex'
          });
        }
      }, {
        scheduled: false,
        timezone: 'Europe/Moscow'
      });

      // Один раз в сутки после свежих комиссий: кэш калькулятора из MP API → массовый пересчёт из БД.
      // Днём — только recalculate-one / смена данных по товару (live для этого SKU).
      const minPricesNightlyCron = getMinPricesNightlyCron();
      const minPricesRecalcJob = cron.schedule(minPricesNightlyCron, async () => {
        if (isMinPricesLegacyLiveRecalc()) {
          logger.info('[Scheduler] Min prices: LEGACY recalculateAndSaveAll (live API per product)...');
          try {
            await pricesService.recalculateAndSaveAll();
            logger.info('[Scheduler] Legacy min prices recalculate completed');
          } catch (error) {
            logger.error('[Scheduler] Legacy min prices recalculate failed:', error);
            await addRuntimeNotification({
              type: 'job_failed',
              severity: 'error',
              source: 'scheduler',
              title: 'Сбой ночного пересчёта мин. цен (legacy live)',
              message: `Legacy recalculateAndSaveAll failed: ${error?.message || String(error)}`
            });
          }
          return;
        }
        logger.info('[Scheduler] Nightly: sync MP calculator cache from APIs...');
        try {
          const syncRes = await pricesService.syncCalculatorCacheFromApi({
            delayMs: getCalculatorCacheSyncDelayMs()
          });
          logger.info('[Scheduler] MP calculator cache sync finished', {
            ozon: syncRes?.ozon && { updated: syncRes.ozon.updated, requests: syncRes.ozon.requests },
            wb: syncRes?.wb && { updated: syncRes.wb.updated },
            ym: syncRes?.ym && { updated: syncRes.ym.updated }
          });
        } catch (error) {
          logger.error('[Scheduler] MP calculator cache sync failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'error',
            source: 'scheduler',
            title: 'Сбой ночной синхронизации кэша калькулятора',
            message: `syncCalculatorCacheFromApi failed: ${error?.message || String(error)}`
          });
        }
        logger.info('[Scheduler] Nightly: recalculate min prices from DB cache...');
        try {
          const { totalProcessed } = await pricesService.recalculateAndSaveAllFromCache();
          logger.info(`[Scheduler] Min prices from cache completed (${totalProcessed} products)`);
        } catch (error) {
          logger.error('[Scheduler] Min prices from cache failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'error',
            source: 'scheduler',
            title: 'Сбой ночного пересчёта мин. цен из кэша',
            message: `recalculateAndSaveAllFromCache failed: ${error?.message || String(error)}`
          });
        }
      }, {
        scheduled: false,
        timezone: 'Europe/Moscow'
      });

      // Ежедневная проверка API всех интеграций (Ozon, WB, Yandex) — результат попадает в уведомления
      const apiCheckJob = cron.schedule('0 6 * * *', async () => {
        logger.info('[Scheduler] Starting daily marketplace API check...');
        const marketplaces = ['ozon', 'wildberries', 'yandex'];
        for (const code of marketplaces) {
          try {
            const config = await integrationsService.getMarketplaceConfig(code);
            const hasKey = config?.api_key != null && String(config.api_key).trim() !== '';
            if (!hasKey) continue;
            await integrationsService.getMarketplaceTokenStatus(code);
            logger.info(`[Scheduler] API check done: ${code}`);
          } catch (error) {
            logger.warn(`[Scheduler] API check failed for ${code}:`, error?.message || error);
          }
        }
        logger.info('[Scheduler] Daily marketplace API check finished');
      }, {
        scheduled: false,
        timezone: 'Europe/Moscow'
      });

      let ordersFbsSyncJob = null;
      const ordersFbsCron = getOrdersFbsSyncCronExpression();
      if (isOrdersFbsSyncEnabled()) {
        ordersFbsSyncJob = cron.schedule(ordersFbsCron, async () => {
          logger.info('[Scheduler] FBS orders sync (cron)...');
          try {
            // force: иначе при синке <1 мин назад (UI/другой поток) вернётся кэш без запросов к МП — новые заказы не подтянутся
            const out = await ordersSyncService.syncFbs({ force: true, scheduler: true });
            if (out?.rateLimited) {
              logger.info(
                `[Scheduler] FBS orders sync: пропуск (${out.message || `подождите ${out.retryAfterSeconds ?? '?'} с`})`
              );
            }
          } catch (error) {
            logger.error('[Scheduler] FBS orders sync failed:', error?.message || error);
          }
        }, {
          scheduled: false,
          timezone: 'Europe/Moscow'
        });
      } else {
        logger.info('[Scheduler] FBS orders background sync disabled (ORDERS_FBS_SYNC_ENABLED)');
      }

      this.jobs.push({
        name: 'wb-marketplace-update',
        job: wbUpdateJob,
        schedule: '0 1 * * *',
        description: 'Обновление категорий и комиссий WB каждый день в 1:00'
      });

      this.jobs.push({
        name: 'wb-tariffs-update',
        job: wbTariffsJob,
        schedule: '0 1 * * *',
        description: 'Обновление тарифов WB каждый день в 1:00'
      });

      this.jobs.push({
        name: 'wb-commissions-update',
        job: wbCommissionsJob,
        schedule: '0 1 * * *',
        description: 'Обновление комиссий WB каждый день в 1:00'
      });

      this.jobs.push({
        name: 'ozon-actions-update',
        job: ozonActionsJob,
        schedule: '0 1 * * *',
        description: 'Обновление списка акций Ozon каждый день в 1:00'
      });

      this.jobs.push({
        name: 'ozon-categories-update',
        job: ozonCategoriesJob,
        schedule: '30 1 * * *',
        description: 'Обновление категорий Ozon каждый день в 1:30'
      });

      this.jobs.push({
        name: 'ym-categories-update',
        job: ymCategoriesJob,
        schedule: '0 2 * * *',
        description: 'Обновление категорий Яндекс.Маркета каждый день в 2:00'
      });

      this.jobs.push({
        name: 'min-prices-recalculate',
        job: minPricesRecalcJob,
        schedule: minPricesNightlyCron,
        description: isMinPricesLegacyLiveRecalc()
          ? 'LEGACY: пересчёт мин. цен через live API (MIN_PRICES_NIGHTLY_LEGACY_LIVE). Расписание: MIN_PRICES_NIGHTLY_CRON'
          : 'Ночной полный прогон: sync кэша калькулятора + пересчёт всех мин. цен из БД (MIN_PRICES_NIGHTLY_CRON, по умолчанию 3:15 МСК)'
      });

      this.jobs.push({
        name: 'marketplace-api-check',
        job: apiCheckJob,
        schedule: '0 6 * * *',
        description: 'Ежедневная проверка API интеграций (Ozon, WB, Yandex) для уведомлений'
      });

      if (ordersFbsSyncJob) {
        this.jobs.push({
          name: 'orders-fbs-sync',
          job: ordersFbsSyncJob,
          schedule: ordersFbsCron,
          description:
            'Синхронизация FBS-заказов (Ozon, WB, Яндекс). Интервал: ORDERS_FBS_SYNC_CRON, по умолчанию */2 * * * *'
        });
      }

      // Запускаем задачи
      wbUpdateJob.start();
      wbTariffsJob.start();
      wbCommissionsJob.start();
      ozonActionsJob.start();
      ozonCategoriesJob.start();
      ymCategoriesJob.start();
      minPricesRecalcJob.start();
      apiCheckJob.start();
      if (ordersFbsSyncJob) {
        ordersFbsSyncJob.start();
      }
      this.isRunning = true;

      if (isOrdersFbsSyncEnabled()) {
        setTimeout(() => {
          (async () => {
            try {
              logger.info('[Scheduler] Deferred FBS orders sync (~90s after startup)...');
              await ordersSyncService.syncFbs({ force: true, scheduler: true });
            } catch (e) {
              logger.warn('[Scheduler] Deferred FBS orders sync:', e?.message || e);
            }
          })();
        }, 90 * 1000);
      }

      logger.info('[Scheduler] Initialized successfully', {
        jobs: this.jobs.map(j => j.name)
      });
      
    } catch (error) {
      logger.error('[Scheduler] Failed to initialize:', error);
      // Если node-cron не установлен, используем альтернативный подход
      this.initFallback();
    }
  }

  /**
   * Альтернативная инициализация без node-cron (используя setTimeout).
   * Следующий запуск — 01:00 по Москве (UTC+3). 01:00 MSK = 22:00 UTC предыдущего дня.
   */
  initFallback() {
    logger.warn('[Scheduler] Using fallback scheduler (setTimeout)');
    
    const scheduleNextRun = () => {
      const now = new Date();
      // 01:00 Москва = 22:00 UTC в тот же календарный день (МСК = UTC+3)
      const next = new Date(now);
      next.setUTCHours(22, 0, 0, 0);
      if (next <= now) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      const msUntilNextRun = next.getTime() - now.getTime();
      
      logger.info(`[Scheduler] Next WB update scheduled for 01:00 MSK (${next.toISOString()} UTC, in ${Math.round(msUntilNextRun / 1000 / 60)} min)`);
      
      setTimeout(async () => {
        logger.info('[Scheduler] Starting scheduled WB categories and commissions update...');
        try {
          await wbMarketplaceService.updateCategoriesAndCommissions();
          logger.info('[Scheduler] WB update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] WB update failed:', error);
        }
        
        // Обновляем тарифы WB
        logger.info('[Scheduler] Starting scheduled WB tariffs update...');
        try {
          await integrationsService.updateWildberriesTariffs();
          logger.info('[Scheduler] WB tariffs update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] WB tariffs update failed:', error);
        }
        
        // Обновляем комиссии WB
        logger.info('[Scheduler] Starting scheduled WB commissions update...');
        try {
          await integrationsService.updateWildberriesCommissions();
          logger.info('[Scheduler] WB commissions update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] WB commissions update failed:', error);
        }

        // Обновляем список акций Ozon
        logger.info('[Scheduler] Starting scheduled Ozon actions update...');
        try {
          await pricesService.updateAndCacheOzonActions();
          logger.info('[Scheduler] Ozon actions update completed successfully');
        } catch (error) {
          logger.error('[Scheduler] Ozon actions update failed:', error);
        }

        // После 01:00: кэш калькулятора + пересчёт из БД в то же локальное время, что дефолтный MIN_PRICES_NIGHTLY_CRON (см. FALLBACK_MIN_PRICES_MINUTES_AFTER_1AM)
        setTimeout(async () => {
          if (isMinPricesLegacyLiveRecalc()) {
            logger.info('[Scheduler] Min prices: LEGACY recalculateAndSaveAll (fallback)...');
            try {
              await pricesService.recalculateAndSaveAll();
              logger.info('[Scheduler] Legacy min prices recalculate completed');
            } catch (error) {
              logger.error('[Scheduler] Legacy min prices recalculate failed:', error);
            }
            return;
          }
          logger.info('[Scheduler] MP calculator cache sync (fallback scheduler)...');
          try {
            await pricesService.syncCalculatorCacheFromApi({ delayMs: getCalculatorCacheSyncDelayMs() });
          } catch (error) {
            logger.error('[Scheduler] MP calculator cache sync failed:', error);
          }
          logger.info('[Scheduler] Min prices from cache (fallback scheduler)...');
          try {
            const { totalProcessed } = await pricesService.recalculateAndSaveAllFromCache();
            logger.info(`[Scheduler] Min prices from cache completed (${totalProcessed} products)`);
          } catch (error) {
            logger.error('[Scheduler] Min prices from cache failed:', error);
          }
        }, FALLBACK_MIN_PRICES_MINUTES_AFTER_1AM * 60 * 1000);
        
        // Обновляем категории Ozon (через 30 минут после WB)
        setTimeout(async () => {
          logger.info('[Scheduler] Starting scheduled Ozon categories update...');
          try {
            await integrationsService.updateOzonCategories();
            logger.info('[Scheduler] Ozon categories update completed successfully');
          } catch (error) {
            logger.error('[Scheduler] Ozon categories update failed:', error);
          }

          // Обновляем категории Яндекс.Маркета (через 30 минут после Ozon)
          setTimeout(async () => {
            logger.info('[Scheduler] Starting scheduled Yandex categories update...');
            try {
              await integrationsService.updateYandexCategories();
              logger.info('[Scheduler] Yandex categories update completed successfully');
            } catch (error) {
              logger.error('[Scheduler] Yandex categories update failed:', error);
            }
          }, 30 * 60 * 1000);
        }, 30 * 60 * 1000); // 30 минут

        // Планируем следующий запуск
        scheduleNextRun();
      }, msUntilNextRun);
    };
    
    scheduleNextRun();
    this.isRunning = true;

    if (isOrdersFbsSyncEnabled()) {
      const ivMin = Math.max(2, Number(process.env.ORDERS_FBS_SYNC_INTERVAL_MINUTES || 2));
      const runFbs = async () => {
        try {
          logger.info('[Scheduler] FBS orders sync (fallback interval)...');
          await ordersSyncService.syncFbs({ force: true, scheduler: true });
        } catch (e) {
          logger.error('[Scheduler] FBS orders sync failed:', e?.message || e);
        }
      };
      setInterval(runFbs, ivMin * 60 * 1000);
      setTimeout(runFbs, 90 * 1000);
      logger.info(`[Scheduler] FBS orders sync: каждые ${ivMin} мин (fallback, ORDERS_FBS_SYNC_INTERVAL_MINUTES)`);
    }
  }

  /**
   * Фоновая синхронизация FBS-заказов без полного планировщика (ночные задачи, WB-комиссии и т.д.).
   * Нужна при отключённом PostgreSQL и при запуске корневого server.js (монолит).
   */
  async startOrdersFbsBackgroundSyncOnly() {
    if (this.ordersFbsStandaloneStarted) {
      logger.warn('[Scheduler] FBS standalone sync already started, skip');
      return;
    }
    if (!isOrdersFbsSyncEnabled()) {
      logger.info('[Scheduler] FBS orders background sync off (ORDERS_FBS_SYNC_ENABLED)');
      return;
    }
    this.ordersFbsStandaloneStarted = true;

    const run = async () => {
      try {
        logger.info('[Scheduler] FBS orders sync (server background)...');
        const out = await ordersSyncService.syncFbs({ force: true, scheduler: true });
        if (out?.rateLimited) {
          logger.info(
            `[Scheduler] FBS orders sync: пропуск (${out.message || `подождите ${out.retryAfterSeconds ?? '?'} с`})`
          );
        }
      } catch (e) {
        logger.error('[Scheduler] FBS orders sync failed:', e?.message || e);
      }
    };

    try {
      const cron = await import('node-cron');
      const expr = getOrdersFbsSyncCronExpression();
      const job = cron.schedule(expr, run, {
        scheduled: true,
        timezone: 'Europe/Moscow'
      });
      this.jobs.push({
        name: 'orders-fbs-sync-standalone',
        job,
        schedule: expr,
        description: 'Фоновая синхронизация FBS-заказов (только этот job)'
      });
      logger.info(`[Scheduler] FBS orders background: cron "${expr}" (Europe/Moscow), ORDERS_FBS_SYNC_CRON`);
    } catch (e) {
      const ivMin = Math.max(2, Number(process.env.ORDERS_FBS_SYNC_INTERVAL_MINUTES || 2));
      this.ordersFbsStandaloneIntervalId = setInterval(run, ivMin * 60 * 1000);
      logger.warn(
        `[Scheduler] node-cron недоступен (${e?.message}), FBS каждые ${ivMin} мин (ORDERS_FBS_SYNC_INTERVAL_MINUTES)`
      );
    }
    setTimeout(run, 90 * 1000);
  }

  /**
   * Остановить все задачи
   */
  stop() {
    this.jobs.forEach(({ name, job }) => {
      if (job && typeof job.stop === 'function') {
        job.stop();
        logger.info(`[Scheduler] Stopped job: ${name}`);
      }
    });
    if (this.ordersFbsStandaloneIntervalId) {
      clearInterval(this.ordersFbsStandaloneIntervalId);
      this.ordersFbsStandaloneIntervalId = null;
    }
    this.isRunning = false;
  }

  /**
   * Получить статус планировщика
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      jobs: this.jobs.map(({ name, schedule, description }) => ({
        name,
        schedule,
        description
      }))
    };
  }

  /**
   * Проверить наличие данных и загрузить при необходимости
   */
  async checkAndLoadInitialData() {
    try {
      // Проверяем, есть ли API ключ WB
      const wbConfig = await integrationsService.getMarketplaceConfig('wildberries');
      if (!wbConfig || !wbConfig.api_key) {
        logger.info('[Scheduler] WB API key not configured, skipping initial data load');
        return;
      }

      // Проверяем, есть ли комиссии в БД
      const commissions = await wbMarketplaceService.getAllCommissions();
      
      if (!commissions || commissions.length === 0) {
        logger.info('[Scheduler] WB commissions table is empty, loading initial data...');
        
        try {
          // Загружаем комиссии
          await integrationsService.updateWildberriesCommissions();
          logger.info('[Scheduler] Initial WB commissions loaded successfully');
        } catch (error) {
          logger.error('[Scheduler] Error loading initial WB commissions:', error);
        }
      } else {
        logger.info(`[Scheduler] WB commissions already loaded (${commissions.length} records)`);
      }

      // Проверяем кэш тарифов WB: если пустой или старше 24 ч — загружаем при старте
      try {
        const cachedTariffs = await readData('wbTariffsCache');
        const hasValidCache = cachedTariffs?.data?.response?.data?.warehouseList?.length > 0;
        const lastUpdate = cachedTariffs?.lastUpdate ? new Date(cachedTariffs.lastUpdate) : null;
        const hoursSinceUpdate = lastUpdate ? (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60) : 24;
        if (!hasValidCache || hoursSinceUpdate >= 24) {
          logger.info('[Scheduler] WB tariffs cache empty or stale, loading at startup...');
          await integrationsService.updateWildberriesTariffs();
          logger.info('[Scheduler] Initial WB tariffs loaded successfully');
        } else {
          logger.info(`[Scheduler] WB tariffs cache valid (updated ${hoursSinceUpdate.toFixed(1)}h ago)`);
        }
      } catch (err) {
        // Не критично для работы приложения — просто пропускаем на старте
        logger.warn('[Scheduler] Initial WB tariffs skipped:', err?.message || err);
      }
    } catch (error) {
      logger.error('[Scheduler] Error checking initial data:', error);
    }
  }
}

export default new SchedulerService();

