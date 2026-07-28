/**
 * Scheduler Service
 * Сервис для планирования периодических задач (cron jobs)
 *
 * Минимальные цены по маркетплейсам:
 * Комиссии и справочники MP обновляются примерно раз в сутки (ночные задачи 1:00–2:00 МСК).
 * После этого один раз за сутки выполняется полный прогон: синхронизация кэша калькулятора из API
 * и пересчёт мин. цен по всему каталогу из БД (см. MIN_PRICES_NIGHTLY_CRON),
 * затем пуш цен на МП (MARKETPLACE_MIN_PRICE_PUSH_ENABLED; только org с auto_push_marketplace_prices).
 * Днём — сверка каждые 2 ч (MARKETPLACE_MIN_PRICE_RECONCILE_CRON): WB батчем + Ozon/YM для затронутых.
 * В течение дня при изменении карточки (себестоимость, габариты, категория и т.д.) достаточно
 * точечного пересчёта — POST .../recalculate-one (по умолчанию live API для затронутого товара)
 * с отложенным пушем мин. цены на МП.
 */

import logger from '../utils/logger.js';
import { readData } from '../utils/storage.js';
import repositoryFactory from '../config/repository-factory.js';
import wbMarketplaceService from './wbMarketplace.service.js';
import integrationsService from './integrations.service.js';
import pricesService from './prices.service.js';
import { pushForAllProfiles as pushMinPricesForAllProfiles, reconcileBelowFloor as reconcileMinPricesBelowFloor } from './marketplaceMinPricePush.service.js';
import categoryMarketplaceCommissionsService from './categoryMarketplaceCommissions.service.js';
import ordersSyncService from './orders.sync.service.js';
import { getReserveDbLimiterStats } from '../utils/reserveDbLimiter.js';
import { syncMarketplaceReviews } from './marketplaceReviews.service.js';
import productCompetitorsService from './productCompetitors.service.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';
import { runMarketplaceInventoryDailySnapshot } from './marketplaceInventorySnapshots.service.js';
import marketplaceFboReportsService from './marketplaceFboReports.service.js';
import marketplaceFbsReportsService from './marketplaceFbsReports.service.js';
import {
  getSchedulerDbJobName,
  isSchedulerDbJobRunning,
  runSchedulerDbJob,
} from '../utils/schedulerDbMutex.js';

/** Фоновая синхронизация FBS-заказов (Ozon/WB/Яндекс). Выкл: ORDERS_FBS_SYNC_ENABLED=0 */
function isOrdersFbsSyncEnabled() {
  const v = process.env.ORDERS_FBS_SYNC_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Cron (node-cron, Europe/Moscow). По умолчанию каждые 5 мин; переопределение: ORDERS_FBS_SYNC_CRON */
function getOrdersFbsSyncCronExpression() {
  const c = process.env.ORDERS_FBS_SYNC_CRON;
  return c && String(c).trim() ? String(c).trim() : '*/5 * * * *';
}

/**
 * Быстрый опрос только WB /orders/new (не ждёт auto-procurement / полный sync mutex).
 * Выкл: ORDERS_WB_NEW_POLL_ENABLED=0
 */
function isOrdersWbNewPollEnabled() {
  // По умолчанию включён вместе с FBS sync; явный OFF отключает.
  if (!isOrdersFbsSyncEnabled()) return false;
  const v = process.env.ORDERS_WB_NEW_POLL_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Cron (Europe/Moscow). По умолчанию каждую минуту; ORDERS_WB_NEW_POLL_CRON */
function getOrdersWbNewPollCronExpression() {
  const c = process.env.ORDERS_WB_NEW_POLL_CRON;
  return c && String(c).trim() ? String(c).trim() : '*/1 * * * *';
}

/** Фоновая синхронизация отзывов (Ozon/WB/Яндекс). Выкл: REVIEWS_SYNC_ENABLED=0 */
function isReviewsSyncEnabled() {
  const v = process.env.REVIEWS_SYNC_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Cron (node-cron, Europe/Moscow). По умолчанию раз в час; переопределение: REVIEWS_SYNC_CRON */
function getReviewsSyncCronExpression() {
  const c = process.env.REVIEWS_SYNC_CRON;
  return c && String(c).trim() ? String(c).trim() : '0 * * * *';
}

/** Мониторинг цен конкурентов. Выкл: COMPETITORS_SYNC_ENABLED=0 */
function isCompetitorsSyncEnabled() {
  const v = process.env.COMPETITORS_SYNC_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Cron конкурентов. По умолчанию каждый час; COMPETITORS_SYNC_CRON */
function getCompetitorsSyncCronExpression() {
  const c = process.env.COMPETITORS_SYNC_CRON;
  return c && String(c).trim() ? String(c).trim() : '15 * * * *';
}

/** Фоновая синхронизация остатков поставщиков (Mikado, Москворечье). Выкл: SUPPLIER_STOCKS_SYNC_ENABLED=0 */
function isSupplierStocksSyncEnabled() {
  const v = process.env.SUPPLIER_STOCKS_SYNC_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Cron (node-cron, Europe/Moscow). По умолчанию каждые 10 минут; переопределение: SUPPLIER_STOCKS_SYNC_CRON */
function getSupplierStocksSyncCronExpression() {
  const c = process.env.SUPPLIER_STOCKS_SYNC_CRON;
  return c && String(c).trim() ? String(c).trim() : '*/10 * * * *';
}

/** Фоновая синхронизация статусов FBO с МП (кроме «Закрыт»/«Возврат»). Выкл: FBO_SUPPLY_STATUS_SYNC_ENABLED=0 */
function isFboSupplyStatusSyncEnabled() {
  const v = process.env.FBO_SUPPLY_STATUS_SYNC_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Cron (Europe/Moscow). По умолчанию каждые 10 мин; переопределение: FBO_SUPPLY_STATUS_SYNC_CRON */
function getFboSupplyStatusSyncCronExpression() {
  const c = process.env.FBO_SUPPLY_STATUS_SYNC_CRON;
  return c && String(c).trim() ? String(c).trim() : '*/30 * * * *';
}

/** Архивация старых завершённых заказов. Выкл: ORDERS_ARCHIVE_ENABLED=0 */
function isOrdersArchiveEnabled() {
  const v = process.env.ORDERS_ARCHIVE_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Cron (Europe/Moscow). По умолчанию 3:45 МСК; переопределение: ORDERS_ARCHIVE_CRON */
function getOrdersArchiveCronExpression() {
  const c = process.env.ORDERS_ARCHIVE_CRON;
  return c && String(c).trim() ? String(c).trim() : '45 3 * * *';
}

/** Фоновая автозакупка и отправка в API поставщиков. Выкл: AUTO_PROCUREMENT_ENABLED=0 */
function isAutoProcurementEnabled() {
  const v = process.env.AUTO_PROCUREMENT_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Cron (Europe/Moscow). По умолчанию каждые 2 мин; переопределение: AUTO_PROCUREMENT_CRON */
function getAutoProcurementCronExpression() {
  const c = process.env.AUTO_PROCUREMENT_CRON;
  return c && String(c).trim() ? String(c).trim() : '*/2 * * * *';
}

async function runOrdersArchive() {
  const { runOrdersArchiveBlocking, getOrdersArchiveStatus } = await import('./ordersArchive.job.js');
  if (getOrdersArchiveStatus().inProgress) {
    logger.info('[Scheduler] Orders archive: skip (previous run still in progress)');
    return;
  }
  try {
    const result = await runOrdersArchiveBlocking();
    if ((result?.archived ?? 0) > 0) {
      logger.info('[Scheduler] Orders archive done', result);
    }
  } catch (e) {
    logger.warn('[Scheduler] Orders archive failed:', e?.message || e);
  }
}

async function runFboSupplyStatusSync() {
  const { runFboShippedStatusSyncBlocking, getFboSupplyStatusSyncStatus } = await import(
    './fboSupplyStatusSync.job.js'
  );
  if (getFboSupplyStatusSyncStatus().inProgress) {
    logger.info('[Scheduler] FBO supply status sync: skip (previous run still in progress)');
    return;
  }
  try {
    const result = await runFboShippedStatusSyncBlocking();
    if ((result?.updated ?? 0) > 0) {
      logger.info('[Scheduler] FBO supply status sync done', result);
    }
  } catch (e) {
    logger.warn('[Scheduler] FBO supply status sync failed:', e?.message || e);
  }
}

async function runSupplierStocksSync() {
  const { runSupplierStocksSyncBlocking, getSupplierStocksSyncStatus } = await import(
    './supplierStocksRefresh.job.js'
  );
  if (getSupplierStocksSyncStatus().inProgress) {
    logger.info('[Scheduler] Supplier stocks sync: skip (previous run still in progress)');
    return;
  }
  try {
    const result = await runSupplierStocksSyncBlocking();
    logger.info('[Scheduler] Supplier stocks sync done', {
      total: result?.total ?? 0,
      success: result?.success ?? 0,
      failed: result?.failed ?? 0
    });
  } catch (error) {
    logger.warn('[Scheduler] Supplier stocks sync failed:', error?.message || String(error));
    await addRuntimeNotification({
      type: 'job_failed',
      severity: 'warning',
      source: 'scheduler',
      title: 'Сбой синхронизации остатков поставщиков',
      message: error?.message || String(error)
    });
  }
}

/**
 * Ночной полный пересчёт мин. цен: после обновления комиссий/категорий (последняя пачка — YM в 2:00 МСК).
 * По умолчанию 3:15 МСК — запас после ночных справочников; переопределение: MIN_PRICES_NIGHTLY_CRON.
 */
function getMinPricesNightlyCron() {
  const c = process.env.MIN_PRICES_NIGHTLY_CRON;
  return c && String(c).trim() ? String(c).trim() : '15 4 * * *';
}

/**
 * Дневная сверка цен с МП (батч WB + точечный Ozon/YM для затронутых).
 * По умолчанию каждые 2 часа в :20 МСК. MARKETPLACE_MIN_PRICE_RECONCILE_CRON.
 */
function getMinPriceReconcileCron() {
  const c = process.env.MARKETPLACE_MIN_PRICE_RECONCILE_CRON;
  return c && String(c).trim() ? String(c).trim() : '20 */2 * * *';
}

function isMinPriceReconcileEnabled() {
  const v = process.env.MARKETPLACE_MIN_PRICE_RECONCILE_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Ежедневный импорт остатков МП + "в пути"/возвраты. По умолчанию 04:30 МСК; переопределение: MP_INVENTORY_DAILY_CRON */
function getMarketplaceInventoryDailyCron() {
  const c = process.env.MP_INVENTORY_DAILY_CRON;
  return c && String(c).trim() ? String(c).trim() : '30 4 * * *';
}

function isMarketplaceInventoryDailyEnabled() {
  const v = process.env.MP_INVENTORY_DAILY_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Ежедневная загрузка финансовых отчётов FBO с маркетплейсов. По умолчанию 05:00 МСК; MP_FBO_REPORTS_DAILY_CRON */
function getMarketplaceFboReportsDailyCron() {
  const c = process.env.MP_FBO_REPORTS_DAILY_CRON;
  return c && String(c).trim() ? String(c).trim() : '0 5 * * *';
}

function isMarketplaceFboReportsDailyEnabled() {
  const v = process.env.MP_FBO_REPORTS_DAILY_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Ежедневная загрузка финансовых отчётов FBS. По умолчанию 05:20 МСК; MP_FBS_REPORTS_DAILY_CRON */
function getMarketplaceFbsReportsDailyCron() {
  const c = process.env.MP_FBS_REPORTS_DAILY_CRON;
  return c && String(c).trim() ? String(c).trim() : '20 5 * * *';
}

function isMarketplaceFbsReportsDailyEnabled() {
  const v = process.env.MP_FBS_REPORTS_DAILY_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function reportsDailyDateRangeYmd(daysBack = 7) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - daysBack);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

async function loadSchedulerProfileIds() {
  if (!repositoryFactory.isUsingPostgreSQL()) return [];
  const rows = await repositoryFactory.getProfilesRepository().findAll();
  return (rows || []).map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
}

async function syncMarketplaceReportsForAllProfiles(service, label) {
  const { dateFrom, dateTo } = reportsDailyDateRangeYmd(7);
  let profiles = [];
  try {
    profiles = await loadSchedulerProfileIds();
  } catch (e) {
    logger.warn(`[Scheduler] ${label}: could not load profiles:`, e?.message || e);
    return;
  }
  if (!profiles.length) {
    logger.warn(`[Scheduler] ${label}: skip — no profiles`);
    return;
  }
  for (const profileId of profiles) {
    try {
      const out = await service.sync({ profileId, dateFrom, dateTo, marketplace: 'all' });
      const imported = (out?.results || []).reduce((s, r) => s + (Number(r.rowsImported) || 0), 0);
      logger.info(`[Scheduler] ${label} done`, {
        profileId,
        dateFrom,
        dateTo,
        imported,
        errors: out?.errors?.length || 0,
      });
      if (out?.errors?.length) {
        await addRuntimeNotification({
          type: 'error',
          message: `${label} profile=${profileId}: ${out.errors.map((e) => `${e.marketplace}: ${e.message}`).join('; ')}`,
        });
      }
    } catch (e) {
      logger.error(`[Scheduler] ${label} failed profile=${profileId}:`, e?.message || e);
      await addRuntimeNotification({
        type: 'error',
        message: `Ошибка ${label} (profile=${profileId}): ${e?.message || e}`,
      });
    }
  }
}

/** Для fallback-планировщика: минут от 01:00 МСК до запуска полного пересчёта (должно совпадать с дефолтным cron). */
const FALLBACK_MIN_PRICES_MINUTES_AFTER_1AM = 195; // 01:00 + 3ч15м = 04:15 (после категорий МП)

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
        await runSchedulerDbJob('wb-categories-commissions', async () => {
        logger.info('[Scheduler] Starting scheduled WB categories and commissions update...');
        try {
          const res = await wbMarketplaceService.updateCategoriesAndCommissions();
          if (res?.skipped) {
            logger.warn(`[Scheduler] WB update skipped: ${res.message || 'skipped'}`);
            return;
          }
          logger.info('[Scheduler] WB update completed successfully');
        } catch (error) {
          const status = error?.statusCode ?? error?.status ?? null;
          const msg = error?.message || String(error);
          const isRateLimit = status === 429 || String(msg).includes('429');
          const isNoKey =
            String(msg).toLowerCase().includes('api key not configured') ||
            String(msg).toLowerCase().includes('not configured');

          // Для отсутствия ключа — не шумим ошибкой: это штатная ситуация (аккаунт без WB).
          if (isNoKey) {
            logger.warn('[Scheduler] WB update skipped (no API key)');
            return;
          }

          logger.error('[Scheduler] WB update failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: isRateLimit ? 'warning' : 'error',
            source: 'scheduler',
            title: isRateLimit ? 'WB: лимит API (429)' : 'Сбой ночного обновления WB',
            message: `WB categories/commissions update failed: ${msg}`,
            marketplace: 'wildberries',
          });
        }
        });
      }, {
        scheduled: false, // Не запускаем автоматически, запустим вручную
        timezone: 'Europe/Moscow'
      });

      // Тарифы WB — в 1:10 (не в 1:00 вместе с категориями/комиссиями, чтобы не ловить 429 от лимитов API)
      const wbTariffsJob = cron.schedule('10 1 * * *', async () => {
        await runSchedulerDbJob('wb-tariffs', async () => {
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
        });
      }, {
        scheduled: false, // Не запускаем автоматически, запустим вручную
        timezone: 'Europe/Moscow'
      });

      // Комиссии WB обновляются в wbUpdateJob (wbMarketplaceService.updateCategoriesAndCommissions → loadCommissionsFromAPI).
      // Отдельная ночная задача integrationsService.updateWildberriesCommissions убрана: тот же endpoint в 1:00 давал дубль и 429.

      // Обновление списка акций Ozon каждый день в 1:00 ночи
      const ozonActionsJob = cron.schedule('0 1 * * *', async () => {
        await runSchedulerDbJob('ozon-actions', async () => {
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
        });
      }, {
        scheduled: false,
        timezone: 'Europe/Moscow'
      });

      // Обновление категорий Ozon каждый день в 1:30 ночи (после WB, чтобы не перегружать API)
      const ozonCategoriesJob = cron.schedule('30 1 * * *', async () => {
        await runSchedulerDbJob('ozon-categories', async () => {
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
        });
      }, {
        scheduled: false, // Не запускаем автоматически, запустим вручную
        timezone: 'Europe/Moscow'
      });

      // Обновление категорий Яндекс.Маркета — 2:30 МСК (очередь DB job, не параллельно с Ozon)
      const ymCategoriesJob = cron.schedule('30 2 * * *', async () => {
        await runSchedulerDbJob('yandex-categories', async () => {
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
        });
      }, {
        scheduled: false,
        timezone: 'Europe/Moscow'
      });

      // Кэш комиссий Ozon/YM по сопоставленным категориям — после обновления справочников YM
      const mpCategoryCommissionsJob = cron.schedule('45 2 * * *', async () => {
        await runSchedulerDbJob('mp-category-commissions', async () => {
          logger.info('[Scheduler] Starting MP category commissions cache refresh...');
          try {
            const result = await categoryMarketplaceCommissionsService.refreshAllCommissions({}, 'nightly');
            logger.info('[Scheduler] MP category commissions cache refresh completed', {
              filled: result?.filled,
              empty: result?.empty,
              skippedEmptyOverwrite: result?.skippedEmptyOverwrite,
              before: result?.before,
              health: result?.health,
            });
            if (result?.health?.unhealthy) {
              await addRuntimeNotification({
                type: 'commission_refresh_degraded',
                severity: 'error',
                source: 'scheduler',
                title: 'Ночное обновление комиссий ухудшило кэш',
                message:
                  `Заполнено ${result.filled} (было ${result.before?.filled}), ` +
                  `пустых ${result.empty} (было ${result.before?.empty}), ` +
                  `пропусков пустой перезаписи: ${result.skippedEmptyOverwrite || 0}.`,
                meta: result.health,
              });
            }
            try {
              await categoryMarketplaceCommissionsService.checkAndNotifyStaleCache();
            } catch (staleErr) {
              logger.warn('[Scheduler] commission stale check failed:', staleErr?.message || staleErr);
            }
          } catch (error) {
            logger.error('[Scheduler] MP category commissions cache refresh failed:', error);
            await addRuntimeNotification({
              type: 'commission_refresh_failed',
              severity: 'error',
              source: 'scheduler',
              title: 'Сбой ночного обновления комиссий Ozon/YM',
              message: `MP category commissions refresh failed: ${error?.message || String(error)}`,
            });
          }
        });
      }, {
        scheduled: false,
        timezone: 'Europe/Moscow',
      });

      // Один раз в сутки после свежих комиссий: кэш калькулятора из MP API → массовый пересчёт из БД.
      // Днём — только recalculate-one / смена данных по товару (live для этого SKU).
      const minPricesNightlyCron = getMinPricesNightlyCron();
      const minPricesRecalcJob = cron.schedule(minPricesNightlyCron, async () => {
        await runSchedulerDbJob('min-prices-nightly', async () => {
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
          try {
            const pushRes = await pushMinPricesForAllProfiles();
            logger.info('[Scheduler] Legacy min price push completed', pushRes);
          } catch (error) {
            logger.error('[Scheduler] Legacy min price push failed:', error);
          }
          return;
        }
        logger.info('[Scheduler] Nightly: sync Ozon Performance ads (ДРР)...');
        try {
          const ozonPerformanceAdsService = (await import('./ozonPerformanceAds.service.js')).default;
          const adsRes = await ozonPerformanceAdsService.syncAllConfiguredScopes({ days: 14 });
          logger.info('[Scheduler] Ozon ads sync finished', adsRes);
        } catch (error) {
          logger.warn('[Scheduler] Ozon ads sync failed (продолжаем пересчёт):', error?.message || error);
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
        logger.info('[Scheduler] Nightly: push min prices to marketplaces...');
        try {
          const pushRes = await pushMinPricesForAllProfiles();
          logger.info('[Scheduler] Min price push completed', pushRes);
        } catch (error) {
          logger.error('[Scheduler] Min price push failed:', error);
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'error',
            source: 'scheduler',
            title: 'Сбой ночного пуша мин. цен на МП',
            message: `pushForAllProfiles failed: ${error?.message || String(error)}`
          });
        }
        });
      }, {
        scheduled: false,
        timezone: 'Europe/Moscow'
      });

      // Дневная сверка мин. цен с МП (лёгкий батч WB, только ниже пола).
      let minPriceReconcileJob = null;
      const minPriceReconcileCron = getMinPriceReconcileCron();
      if (isMinPriceReconcileEnabled()) {
        minPriceReconcileJob = cron.schedule(minPriceReconcileCron, async () => {
          const hour = Number(
            new Intl.DateTimeFormat('en-GB', {
              timeZone: 'Europe/Moscow',
              hour: 'numeric',
              hour12: false,
            }).format(new Date())
          );
          // Окно ночного пересчёта мин. цен (по умолчанию 4:15) — не дублируем.
          if (hour >= 3 && hour <= 5) {
            logger.info('[Scheduler] Min price reconcile: пропуск — ночное окно 3–5 МСК');
            return;
          }
          // Без runSchedulerDbJob: иначе каждые 2 ч блокируется автозакупка заказов.
          logger.info('[Scheduler] Min price reconcile (below floor)...');
          try {
            const res = await reconcileMinPricesBelowFloor();
            logger.info('[Scheduler] Min price reconcile done', res);
          } catch (error) {
            logger.error('[Scheduler] Min price reconcile failed:', error);
            await addRuntimeNotification({
              type: 'job_failed',
              severity: 'error',
              source: 'scheduler',
              title: 'Сбой сверки мин. цен с МП',
              message: `reconcileBelowFloor failed: ${error?.message || String(error)}`,
            });
          }
        }, {
          scheduled: false,
          timezone: 'Europe/Moscow',
        });
      } else {
        logger.info('[Scheduler] Min price reconcile disabled (MARKETPLACE_MIN_PRICE_RECONCILE_ENABLED)');
      }

      // Ежедневная проверка API всех интеграций (Ozon, WB, Yandex) — по каждому профилю (аккаунту)
      const apiCheckJob = cron.schedule('0 6 * * *', async () => {
        logger.info('[Scheduler] Starting daily marketplace API check...');
        const marketplaces = ['ozon', 'wildberries', 'yandex'];
        let profiles = [{ id: null }];
        try {
          if (repositoryFactory.isUsingPostgreSQL()) {
            const rows = await repositoryFactory.getProfilesRepository().findAll();
            profiles = rows?.length ? rows.map((r) => ({ id: r.id })) : [{ id: null }];
          }
        } catch (e) {
          logger.warn('[Scheduler] API check: could not load profiles:', e?.message || e);
        }
        for (const p of profiles) {
          const profileId = p?.id ?? null;
          for (const code of marketplaces) {
            try {
              const config = await integrationsService.getMarketplaceConfig(code, { profileId });
              const ozonApiKey = config?.api_key ?? config?.apiKey;
              const ozonClient = config?.client_id ?? config?.clientId;
              const hasOzonKeys =
                ozonClient &&
                String(ozonClient).trim() !== '' &&
                ozonApiKey != null &&
                String(ozonApiKey).trim() !== '';
              const simpleKey = config?.api_key ?? config?.apiKey;
              const hasSimpleKey = simpleKey != null && String(simpleKey).trim() !== '';
              const hasKey = code === 'ozon' ? hasOzonKeys : hasSimpleKey;
              if (!hasKey) continue;
              await integrationsService.getMarketplaceTokenStatus(code, { profileId });
              logger.info(`[Scheduler] API check done: ${code} profile=${profileId ?? 'default'}`);
            } catch (error) {
              logger.warn(
                `[Scheduler] API check failed for ${code} profile=${profileId ?? 'default'}:`,
                error?.message || error
              );
            }
          }
        }
        logger.info('[Scheduler] Daily marketplace API check finished');
      }, {
        scheduled: false,
        timezone: 'Europe/Moscow'
      });

      // Периодическая синхронизация отзывов — по каждому профилю (аккаунту)
      let reviewsSyncJob = null;
      const reviewsCron = getReviewsSyncCronExpression();
      if (isReviewsSyncEnabled()) {
        reviewsSyncJob = cron.schedule(reviewsCron, async () => {
          logger.info('[Scheduler] Reviews sync (cron)...');
          let profiles = [{ id: null }];
          try {
            if (repositoryFactory.isUsingPostgreSQL()) {
              const rows = await repositoryFactory.getProfilesRepository().findAll();
              profiles = rows?.length ? rows.map((r) => ({ id: r.id })) : [{ id: null }];
            }
          } catch (e) {
            logger.warn('[Scheduler] Reviews sync: could not load profiles:', e?.message || e);
          }
          for (const p of profiles) {
            const profileId = p?.id ?? null;
            if (!profileId) continue;
            try {
              const out = await syncMarketplaceReviews(profileId, { scheduler: true });
              logger.info('[Scheduler] Reviews sync done', { profileId, ...out });
            } catch (error) {
              logger.warn('[Scheduler] Reviews sync failed', { profileId, message: error?.message || String(error) });
              await addRuntimeNotification({
                type: 'job_failed',
                severity: 'warn',
                source: 'scheduler',
                title: 'Сбой синхронизации отзывов',
                message: `Reviews sync failed (profile=${profileId}): ${error?.message || String(error)}`,
              });
            }
          }
        }, {
          scheduled: false,
          timezone: 'Europe/Moscow'
        });
      } else {
        logger.info('[Scheduler] Reviews background sync disabled (REVIEWS_SYNC_ENABLED)');
      }

      let competitorsSyncJob = null;
      const competitorsCron = getCompetitorsSyncCronExpression();
      if (isCompetitorsSyncEnabled()) {
        competitorsSyncJob = cron.schedule(
          competitorsCron,
          async () => {
            logger.info('[Scheduler] Competitors sync (cron)...');
            try {
              const out = await productCompetitorsService.refreshAll({ limit: 800, delayMs: 600 });
              logger.info('[Scheduler] Competitors sync done', out);
            } catch (error) {
              logger.warn('[Scheduler] Competitors sync failed', {
                message: error?.message || String(error),
              });
              await addRuntimeNotification({
                type: 'job_failed',
                severity: 'warn',
                source: 'scheduler',
                title: 'Сбой мониторинга конкурентов',
                message: `Competitors sync failed: ${error?.message || String(error)}`,
              });
            }
          },
          { scheduled: false, timezone: 'Europe/Moscow' }
        );
      } else {
        logger.info('[Scheduler] Competitors sync disabled (COMPETITORS_SYNC_ENABLED)');
      }

      let ordersFbsSyncJob = null;
      const ordersFbsCron = getOrdersFbsSyncCronExpression();
      if (isOrdersFbsSyncEnabled()) {
        ordersFbsSyncJob = cron.schedule(ordersFbsCron, async () => {
          const syncStatus = ordersSyncService.getSyncFbsStatus();
          if (syncStatus.inProgress) {
            logger.info('[Scheduler] FBS orders sync: пропуск — предыдущий прогон ещё выполняется');
            return;
          }
          if (isSchedulerDbJobRunning()) {
            logger.info(
              `[Scheduler] FBS orders sync: пропуск — ночная задача БД (${getSchedulerDbJobName() || '…'})`
            );
            return;
          }
          const reserveStats = getReserveDbLimiterStats();
          if (reserveStats.queued > 0 || reserveStats.active >= reserveStats.max) {
            logger.info(
              `[Scheduler] FBS orders sync: пропуск — очередь резерва (active=${reserveStats.active}, queued=${reserveStats.queued})`
            );
            return;
          }
          logger.info('[Scheduler] FBS orders sync (cron, background)...');
          const out = ordersSyncService.startSyncFbsForAllProfilesInBackground({
            force: true,
            scheduler: true
          });
          if (!out.started && out.inProgress) {
            logger.info('[Scheduler] FBS orders sync: пропуск — предыдущий прогон ещё выполняется');
          }
        }, {
          scheduled: false,
          timezone: 'Europe/Moscow'
        });
      } else {
        logger.info('[Scheduler] FBS orders background sync disabled (ORDERS_FBS_SYNC_ENABLED)');
      }

      let ordersWbNewPollJob = null;
      const ordersWbNewPollCron = getOrdersWbNewPollCronExpression();
      if (isOrdersWbNewPollEnabled()) {
        ordersWbNewPollJob = cron.schedule(
          ordersWbNewPollCron,
          async () => {
            try {
              const out = await ordersSyncService.pollWbNewOrdersForAllProfiles({ scheduler: true });
              if (out?.skipped && out.reason && out.reason !== 'poll_in_progress') {
                // тихий skip при полном sync / pause — без шума каждую минуту
                if (out.reason === 'full_sync_in_progress' || out.reason === 'paused') return;
              }
              if (out?.inserted > 0 || out?.error) {
                logger.info('[Scheduler] WB new-orders poll', {
                  inserted: out.inserted || 0,
                  feedTotal: out.feedTotal || 0,
                  skipped: out.skipped || false,
                  reason: out.reason || null,
                  error: out.error || null,
                  durationMs: out.durationMs || null,
                });
              }
            } catch (e) {
              logger.warn('[Scheduler] WB new-orders poll failed:', e?.message || e);
            }
          },
          { scheduled: false, timezone: 'Europe/Moscow' }
        );
      } else {
        logger.info('[Scheduler] WB new-orders poll disabled (ORDERS_WB_NEW_POLL_ENABLED)');
      }

      let supplierStocksSyncJob = null;
      const supplierStocksCron = getSupplierStocksSyncCronExpression();
      if (isSupplierStocksSyncEnabled()) {
        supplierStocksSyncJob = cron.schedule(supplierStocksCron, async () => {
          if (isSchedulerDbJobRunning()) {
            logger.info('[Scheduler] Supplier stocks sync: пропуск — ночная задача БД');
            return;
          }
          await runSchedulerDbJob('supplier-stocks', () => runSupplierStocksSync());
        }, {
          scheduled: false,
          timezone: 'Europe/Moscow'
        });
      } else {
        logger.info('[Scheduler] Supplier stocks background sync disabled (SUPPLIER_STOCKS_SYNC_ENABLED)');
      }

      let fboSupplyStatusSyncJob = null;
      const fboSupplyStatusCron = getFboSupplyStatusSyncCronExpression();
      if (isFboSupplyStatusSyncEnabled()) {
        fboSupplyStatusSyncJob = cron.schedule(fboSupplyStatusCron, async () => {
          if (isSchedulerDbJobRunning()) {
            logger.info('[Scheduler] FBO supply status sync: пропуск — ночная задача БД');
            return;
          }
          await runSchedulerDbJob('fbo-supply-status', () => runFboSupplyStatusSync());
        }, {
          scheduled: false,
          timezone: 'Europe/Moscow'
        });
      } else {
        logger.info('[Scheduler] FBO supply status sync disabled (FBO_SUPPLY_STATUS_SYNC_ENABLED)');
      }

      let ordersArchiveJob = null;
      const ordersArchiveCron = getOrdersArchiveCronExpression();
      if (isOrdersArchiveEnabled()) {
        ordersArchiveJob = cron.schedule(ordersArchiveCron, async () => {
          if (isSchedulerDbJobRunning()) {
            logger.info('[Scheduler] Orders archive: пропуск — ночная задача БД');
            return;
          }
          await runSchedulerDbJob('orders-archive', () => runOrdersArchive());
        }, {
          scheduled: false,
          timezone: 'Europe/Moscow'
        });
      } else {
        logger.info('[Scheduler] Orders archive disabled (ORDERS_ARCHIVE_ENABLED)');
      }

      let orphanOrderReserveJob = null;
      const orphanOrderReserveCron =
        process.env.ORPHAN_ORDER_RESERVE_CRON && String(process.env.ORPHAN_ORDER_RESERVE_CRON).trim()
          ? String(process.env.ORPHAN_ORDER_RESERVE_CRON).trim()
          : '*/30 * * * *';
      const orphanOrderReserveEnabled = !/^(0|false|no|off)$/i.test(
        String(process.env.ORPHAN_ORDER_RESERVE_ENABLED ?? '1').trim()
      );
      if (orphanOrderReserveEnabled) {
        orphanOrderReserveJob = cron.schedule(
          orphanOrderReserveCron,
          async () => {
            if (isSchedulerDbJobRunning()) {
              logger.info('[Scheduler] Orphan order reserve cleanup: пропуск — ночная задача БД');
              return;
            }
            await runSchedulerDbJob('orphan-order-reserve', async () => {
              const { default: ordersService } = await import('./orders.service.js');
              const out = await ordersService.releaseReservesForOrphanOrderKeysInJournal({ limit: 50 });
              if (out.released > 0) {
                logger.info(
                  `[Scheduler] Orphan order reserve cleanup: released=${out.released} checked=${out.checked}`
                );
              }
            });
          },
          {
            scheduled: false,
            timezone: 'Europe/Moscow'
          }
        );
      } else {
        logger.info('[Scheduler] Orphan order reserve cleanup disabled (ORPHAN_ORDER_RESERVE_ENABLED)');
      }

      let autoOrderReserveJob = null;
      const autoOrderReserveCron =
        process.env.AUTO_ORDER_RESERVE_CRON && String(process.env.AUTO_ORDER_RESERVE_CRON).trim()
          ? String(process.env.AUTO_ORDER_RESERVE_CRON).trim()
          : '*/2 * * * *';
      const autoOrderReserveEnabled = !/^(0|false|no|off)$/i.test(
        String(process.env.AUTO_ORDER_RESERVE_ENABLED ?? '1').trim()
      );
      if (autoOrderReserveEnabled) {
        autoOrderReserveJob = cron.schedule(
          autoOrderReserveCron,
          async () => {
            if (isSchedulerDbJobRunning()) {
              logger.info('[Scheduler] Auto order reserve: пропуск — ночная задача БД');
              return;
            }
            const reserveStats = getReserveDbLimiterStats();
            if (reserveStats.queued > 0 || reserveStats.active >= reserveStats.max) {
              logger.info(
                `[Scheduler] Auto order reserve: пропуск — очередь резерва (active=${reserveStats.active}, queued=${reserveStats.queued})`
              );
              return;
            }
            await runSchedulerDbJob('auto-order-reserve', async () => {
              const { default: ordersService } = await import('./orders.service.js');
              const out = await ordersService.runScheduledAutoReserveAllProfiles({ limitPerProfile: 50 });
              if (out.reapplied > 0) {
                logger.info(
                  `[Scheduler] Auto order reserve: reapplied=${out.reapplied} checked=${out.checked} profiles=${out.profiles}`
                );
              }
            });
          },
          {
            scheduled: false,
            timezone: 'Europe/Moscow'
          }
        );
      } else {
        logger.info('[Scheduler] Auto order reserve disabled (AUTO_ORDER_RESERVE_ENABLED)');
      }

      let autoProcurementJob = null;
      const autoProcurementCron = getAutoProcurementCronExpression();
      if (isAutoProcurementEnabled()) {
        autoProcurementJob = cron.schedule(
          autoProcurementCron,
          async () => {
            // Не пропускаем тик при занятом мьютексе — ставим в очередь (priority+coalesce),
            // иначе заказы часами не уходят поставщику.
            await runSchedulerDbJob(
              'auto-procurement',
              async () => {
                const { default: autoProcurementService } = await import('./autoProcurement.service.js');
                const out = await autoProcurementService.runForAllProfiles();
                if (out?.skipped && out.reason === 'in_progress') {
                  logger.info('[AutoProcurement] пропуск — предыдущий прогон ещё выполняется');
                  return;
                }
                const purchased = (out.results || []).reduce((s, r) => s + (r.purchases || 0), 0);
                const submitted = (out.results || []).reduce((s, r) => s + (r.submitted || 0), 0);
                if (purchased > 0 || submitted > 0) {
                  logger.info(
                    `[AutoProcurement] profiles=${out.profiles || 0} purchases=${purchased} submitted=${submitted}`
                  );
                }
              },
              { coalesce: true, priority: true }
            );
          },
          {
            scheduled: false,
            timezone: 'Europe/Moscow'
          }
        );
      } else {
        logger.info('[Scheduler] Auto procurement disabled (AUTO_PROCUREMENT_ENABLED)');
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
        schedule: '10 1 * * *',
        description: 'Обновление тарифов WB каждый день в 1:10 (после категорий/комиссий)'
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
        schedule: '30 2 * * *',
        description: 'Обновление категорий Яндекс.Маркета каждый день в 2:30'
      });

      this.jobs.push({
        name: 'mp-category-commissions',
        job: mpCategoryCommissionsJob,
        schedule: '45 2 * * *',
        description: 'Кэш комиссий Ozon/YM по сопоставленным категориям — 2:45 МСК'
      });

      this.jobs.push({
        name: 'min-prices-recalculate',
        job: minPricesRecalcJob,
        schedule: minPricesNightlyCron,
        description: isMinPricesLegacyLiveRecalc()
          ? 'LEGACY: пересчёт мин. цен через live API (MIN_PRICES_NIGHTLY_LEGACY_LIVE). Расписание: MIN_PRICES_NIGHTLY_CRON'
          : 'Ночной полный прогон: sync кэша калькулятора + пересчёт всех мин. цен из БД (MIN_PRICES_NIGHTLY_CRON, по умолчанию 4:15 МСК)'
      });

      if (minPriceReconcileJob) {
        this.jobs.push({
          name: 'min-prices-reconcile',
          job: minPriceReconcileJob,
          schedule: minPriceReconcileCron,
          description:
            'Сверка цен с МП каждые 2 ч (WB батчем). MARKETPLACE_MIN_PRICE_RECONCILE_CRON; sync-to-min по умолчанию',
        });
      }

      this.jobs.push({
        name: 'marketplace-api-check',
        job: apiCheckJob,
        schedule: '0 6 * * *',
        description: 'Ежедневная проверка API интеграций (Ozon, WB, Yandex) для уведомлений'
      });

      if (isMarketplaceInventoryDailyEnabled()) {
        const mpInvCron = getMarketplaceInventoryDailyCron();
        this.jobs.push({
          name: 'marketplace-inventory-daily',
          job: async () => {
            try {
              await runMarketplaceInventoryDailySnapshot();
            } catch (e) {
              logger.error('[Scheduler] Marketplace inventory daily snapshot failed:', e?.message || e);
              addRuntimeNotification({
                type: 'error',
                message: `Ошибка ежедневного импорта остатков маркетплейсов: ${e?.message || e}`
              });
            }
          },
          schedule: mpInvCron,
          description: 'Ежедневный импорт остатков МП + товары в пути/возвраты (MP_INVENTORY_DAILY_CRON)'
        });
      } else {
        logger.info('[Scheduler] Marketplace inventory daily snapshot disabled (MP_INVENTORY_DAILY_ENABLED)');
      }

      let marketplaceFboReportsDailyJob = null;
      if (isMarketplaceFboReportsDailyEnabled()) {
        const fboReportsCron = getMarketplaceFboReportsDailyCron();
        marketplaceFboReportsDailyJob = cron.schedule(
          fboReportsCron,
          async () => {
            try {
              await syncMarketplaceReportsForAllProfiles(marketplaceFboReportsService, 'Marketplace FBO reports');
            } catch (e) {
              logger.error('[Scheduler] Marketplace FBO reports sync failed:', e?.message || e);
              addRuntimeNotification({
                type: 'error',
                message: `Ошибка ежедневной загрузки FBO-отчётов: ${e?.message || e}`,
              });
            }
          },
          { scheduled: false, timezone: 'Europe/Moscow' }
        );
        this.jobs.push({
          name: 'marketplace-fbo-reports-daily',
          job: marketplaceFboReportsDailyJob,
          schedule: fboReportsCron,
          description:
            'Ежедневная загрузка финансовых отчётов FBO (WB, Ozon, YM) по всем профилям. MP_FBO_REPORTS_DAILY_CRON',
        });
      } else {
        logger.info('[Scheduler] Marketplace FBO reports daily sync disabled (MP_FBO_REPORTS_DAILY_ENABLED)');
      }

      let marketplaceFbsReportsDailyJob = null;
      if (isMarketplaceFbsReportsDailyEnabled()) {
        const fbsReportsCron = getMarketplaceFbsReportsDailyCron();
        marketplaceFbsReportsDailyJob = cron.schedule(
          fbsReportsCron,
          async () => {
            try {
              await syncMarketplaceReportsForAllProfiles(marketplaceFbsReportsService, 'Marketplace FBS reports');
            } catch (e) {
              logger.error('[Scheduler] Marketplace FBS reports sync failed:', e?.message || e);
              addRuntimeNotification({
                type: 'error',
                message: `Ошибка ежедневной загрузки FBS-отчётов: ${e?.message || e}`,
              });
            }
          },
          { scheduled: false, timezone: 'Europe/Moscow' }
        );
        this.jobs.push({
          name: 'marketplace-fbs-reports-daily',
          job: marketplaceFbsReportsDailyJob,
          schedule: fbsReportsCron,
          description:
            'Ежедневная загрузка финансовых отчётов FBS (WB, Ozon, YM) по всем профилям. MP_FBS_REPORTS_DAILY_CRON',
        });
      } else {
        logger.info('[Scheduler] Marketplace FBS reports daily sync disabled (MP_FBS_REPORTS_DAILY_ENABLED)');
      }

      if (reviewsSyncJob) {
        this.jobs.push({
          name: 'reviews-sync',
          job: reviewsSyncJob,
          schedule: reviewsCron,
          description: 'Синхронизация отзывов (Ozon, WB, Яндекс). Интервал: REVIEWS_SYNC_CRON, по умолчанию 0 * * * * (раз в час)'
        });
      }

      if (competitorsSyncJob) {
        this.jobs.push({
          name: 'competitors-sync',
          job: competitorsSyncJob,
          schedule: competitorsCron,
          description:
            'Мониторинг цен/рейтинга конкурентов. Интервал: COMPETITORS_SYNC_CRON, по умолчанию 15 * * * * (каждый час)'
        });
      }

      if (ordersFbsSyncJob) {
        this.jobs.push({
          name: 'orders-fbs-sync',
          job: ordersFbsSyncJob,
          schedule: ordersFbsCron,
          description:
            'Синхронизация FBS-заказов (Ozon, WB, Яндекс). Интервал: ORDERS_FBS_SYNC_CRON, по умолчанию */5 * * * *'
        });
      }

      if (ordersWbNewPollJob) {
        this.jobs.push({
          name: 'orders-wb-new-poll',
          job: ordersWbNewPollJob,
          schedule: ordersWbNewPollCron,
          description:
            'Быстрый опрос WB /orders/new (только новые). ORDERS_WB_NEW_POLL_CRON, по умолчанию */1 * * * *. Не блокируется auto-procurement.'
        });
      }

      if (supplierStocksSyncJob) {
        this.jobs.push({
          name: 'supplier-stocks-sync',
          job: supplierStocksSyncJob,
          schedule: supplierStocksCron,
          description:
            'Синхронизация остатков поставщиков (Mikado, Москворечье). Интервал: SUPPLIER_STOCKS_SYNC_CRON, по умолчанию */10 * * * *'
        });
      }

      if (fboSupplyStatusSyncJob) {
        this.jobs.push({
          name: 'fbo-supply-status-sync',
          job: fboSupplyStatusSyncJob,
          schedule: fboSupplyStatusCron,
          description:
            'Статусы FBO с маркетплейсов (кроме «Закрыт»/«Возврат»). Интервал: FBO_SUPPLY_STATUS_SYNC_CRON, по умолчанию */10 * * * *'
        });
      }

      if (ordersArchiveJob) {
        this.jobs.push({
          name: 'orders-archive',
          job: ordersArchiveJob,
          schedule: ordersArchiveCron,
          description:
            'Архивация завершённых заказов старше 30 дн. (delivered/cancelled). ORDERS_ARCHIVE_CRON, ORDERS_ARCHIVE_AFTER_DAYS'
        });
      }

      if (orphanOrderReserveJob) {
        this.jobs.push({
          name: 'orphan-order-reserve',
          job: orphanOrderReserveJob,
          schedule: orphanOrderReserveCron,
          description:
            'Автоочистка залипшего резерва по удалённым заказам. ORPHAN_ORDER_RESERVE_CRON, по умолчанию */30 * * * *'
        });
      }

      if (autoOrderReserveJob) {
        this.jobs.push({
          name: 'auto-order-reserve',
          job: autoOrderReserveJob,
          schedule: autoOrderReserveCron,
          description:
            'Фоновый авторезерв заказов без UI. AUTO_ORDER_RESERVE_CRON, по умолчанию */2 * * * *'
        });
      }

      if (autoProcurementJob) {
        this.jobs.push({
          name: 'auto-procurement',
          job: autoProcurementJob,
          schedule: autoProcurementCron,
          description:
            'Автозакупка и отправка в API поставщиков (autoOrdersEnabled). AUTO_PROCUREMENT_CRON, по умолчанию */2 * * * *. Не отбрасывается при занятом мьютексе — ставится в приоритетную очередь.'
        });
      }

      // Запускаем задачи
      wbUpdateJob.start();
      wbTariffsJob.start();
      ozonActionsJob.start();
      ozonCategoriesJob.start();
      ymCategoriesJob.start();
      minPricesRecalcJob.start();
      if (minPriceReconcileJob) minPriceReconcileJob.start();
      apiCheckJob.start();
      if (reviewsSyncJob) {
        reviewsSyncJob.start();
      }
      if (competitorsSyncJob) {
        competitorsSyncJob.start();
      }
      if (ordersFbsSyncJob) {
        ordersFbsSyncJob.start();
      }
      if (ordersWbNewPollJob) {
        ordersWbNewPollJob.start();
      }
      if (supplierStocksSyncJob) {
        supplierStocksSyncJob.start();
      }
      if (fboSupplyStatusSyncJob) {
        fboSupplyStatusSyncJob.start();
      }
      if (ordersArchiveJob) {
        ordersArchiveJob.start();
      }
      if (orphanOrderReserveJob) {
        orphanOrderReserveJob.start();
      }
      if (autoOrderReserveJob) {
        autoOrderReserveJob.start();
      }
      if (autoProcurementJob) {
        autoProcurementJob.start();
      }
      if (marketplaceFboReportsDailyJob) {
        marketplaceFboReportsDailyJob.start();
      }
      if (marketplaceFbsReportsDailyJob) {
        marketplaceFbsReportsDailyJob.start();
      }
      this.isRunning = true;

      if (isOrdersFbsSyncEnabled()) {
        setTimeout(() => {
          (async () => {
            try {
              logger.info('[Scheduler] Deferred FBS orders sync (~90s after startup, background)...');
              ordersSyncService.startSyncFbsForAllProfilesInBackground({ force: true, scheduler: true });
            } catch (e) {
              logger.warn('[Scheduler] Deferred FBS orders sync:', e?.message || e);
            }
          })();
        }, 90 * 1000);
      }

      if (isOrdersWbNewPollEnabled()) {
        setTimeout(() => {
          (async () => {
            try {
              logger.info('[Scheduler] Deferred WB new-orders poll (~25s after startup)...');
              const out = await ordersSyncService.pollWbNewOrdersForAllProfiles({ scheduler: true });
              logger.info('[Scheduler] Deferred WB new-orders poll done', {
                inserted: out?.inserted || 0,
                feedTotal: out?.feedTotal || 0,
                skipped: out?.skipped || false,
                reason: out?.reason || null,
              });
            } catch (e) {
              logger.warn('[Scheduler] Deferred WB new-orders poll:', e?.message || e);
            }
          })();
        }, 25 * 1000);
      }

      if (supplierStocksSyncJob && isSupplierStocksSyncEnabled()) {
        setTimeout(() => {
          (async () => {
            try {
              logger.info('[Scheduler] Deferred supplier stocks sync (~120s after startup)...');
              await runSupplierStocksSync();
            } catch (e) {
              logger.warn('[Scheduler] Deferred supplier stocks sync:', e?.message || e);
            }
          })();
        }, 120 * 1000);
      }

      if (fboSupplyStatusSyncJob && isFboSupplyStatusSyncEnabled()) {
        setTimeout(() => {
          (async () => {
            try {
              logger.info('[Scheduler] Deferred FBO supply status sync (~150s after startup)...');
              await runFboSupplyStatusSync();
            } catch (e) {
              logger.warn('[Scheduler] Deferred FBO supply status sync:', e?.message || e);
            }
          })();
        }, 150 * 1000);
      }

      if (reviewsSyncJob && isReviewsSyncEnabled()) {
        setTimeout(() => {
          (async () => {
            try {
              logger.info('[Scheduler] Deferred reviews sync (~90s after startup)...');
              let profiles = [{ id: null }];
              try {
                if (repositoryFactory.isUsingPostgreSQL()) {
                  const rows = await repositoryFactory.getProfilesRepository().findAll();
                  profiles = rows?.length ? rows.map((r) => ({ id: r.id })) : [{ id: null }];
                }
              } catch (e) {
                logger.warn('[Scheduler] Deferred reviews sync: could not load profiles:', e?.message || e);
              }
              for (const p of profiles) {
                const profileId = p?.id ?? null;
                if (!profileId) continue;
                try {
                  const out = await syncMarketplaceReviews(profileId, { scheduler: true, force: true });
                  logger.info('[Scheduler] Deferred reviews sync done', { profileId, ...out });
                } catch (e) {
                  logger.warn('[Scheduler] Deferred reviews sync failed', { profileId, message: e?.message || String(e) });
                }
              }
            } catch (e) {
              logger.warn('[Scheduler] Deferred reviews sync:', e?.message || e);
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
        await runSchedulerDbJob('wb-categories-commissions', async () => {
          logger.info('[Scheduler] Starting scheduled WB categories and commissions update...');
          await wbMarketplaceService.updateCategoriesAndCommissions();
          logger.info('[Scheduler] WB update completed successfully');
        }).catch((error) => logger.error('[Scheduler] WB update failed:', error));

        await runSchedulerDbJob('wb-tariffs', async () => {
          logger.info('[Scheduler] Starting scheduled WB tariffs update...');
          await integrationsService.updateWildberriesTariffs();
          logger.info('[Scheduler] WB tariffs update completed successfully');
        }).catch((error) => logger.error('[Scheduler] WB tariffs update failed:', error));

        await runSchedulerDbJob('wb-commissions', async () => {
          logger.info('[Scheduler] Starting scheduled WB commissions update...');
          await integrationsService.updateWildberriesCommissions();
          logger.info('[Scheduler] WB commissions update completed successfully');
        }).catch((error) => logger.error('[Scheduler] WB commissions update failed:', error));

        await runSchedulerDbJob('ozon-actions', async () => {
          logger.info('[Scheduler] Starting scheduled Ozon actions update...');
          await pricesService.updateAndCacheOzonActions();
          logger.info('[Scheduler] Ozon actions update completed successfully');
        }).catch((error) => logger.error('[Scheduler] Ozon actions update failed:', error));

        setTimeout(() => {
          void runSchedulerDbJob('ozon-categories', async () => {
            logger.info('[Scheduler] Starting scheduled Ozon categories update...');
            await integrationsService.updateOzonCategories();
            logger.info('[Scheduler] Ozon categories update completed successfully');
          }).catch((error) => logger.error('[Scheduler] Ozon categories update failed:', error));
        }, 30 * 60 * 1000);

        setTimeout(() => {
          void runSchedulerDbJob('yandex-categories', async () => {
            logger.info('[Scheduler] Starting scheduled Yandex categories update...');
            await integrationsService.updateYandexCategories();
            logger.info('[Scheduler] Yandex categories update completed successfully');
          }).catch((error) => logger.error('[Scheduler] Yandex categories update failed:', error));
        }, 90 * 60 * 1000);

        setTimeout(() => {
          void runSchedulerDbJob('mp-category-commissions', async () => {
            logger.info('[Scheduler] Starting MP category commissions cache refresh...');
            try {
              const result = await categoryMarketplaceCommissionsService.refreshAllCommissions({}, 'nightly');
              logger.info('[Scheduler] MP category commissions cache refresh completed', {
                filled: result?.filled,
                empty: result?.empty,
              });
            } catch (error) {
              logger.error('[Scheduler] MP category commissions refresh failed:', error);
              await addRuntimeNotification({
                type: 'commission_refresh_failed',
                severity: 'error',
                source: 'scheduler',
                title: 'Сбой обновления комиссий Ozon/YM',
                message: `MP category commissions refresh failed: ${error?.message || String(error)}`,
              });
              throw error;
            }
          }).catch((error) => logger.error('[Scheduler] MP category commissions refresh failed:', error));
        }, 105 * 60 * 1000);

        setTimeout(() => {
          void runSchedulerDbJob('min-prices-nightly', async () => {
            if (isMinPricesLegacyLiveRecalc()) {
              await pricesService.recalculateAndSaveAll();
              return;
            }
            await pricesService.syncCalculatorCacheFromApi({ delayMs: getCalculatorCacheSyncDelayMs() });
            await pricesService.recalculateAndSaveAllFromCache();
            try {
              await pushMinPricesForAllProfiles();
            } catch (error) {
              logger.error('[Scheduler] Min price push (fallback) failed:', error);
            }
          }).catch((error) => logger.error('[Scheduler] Min prices nightly failed:', error));
        }, FALLBACK_MIN_PRICES_MINUTES_AFTER_1AM * 60 * 1000);

        scheduleNextRun();
      }, msUntilNextRun);
    };
    
    scheduleNextRun();
    this.isRunning = true;

    if (isOrdersFbsSyncEnabled()) {
      const ivMin = Math.max(2, Number(process.env.ORDERS_FBS_SYNC_INTERVAL_MINUTES || 2));
      const runFbs = async () => {
        try {
          logger.info('[Scheduler] FBS orders sync (fallback interval, background)...');
          ordersSyncService.startSyncFbsForAllProfilesInBackground({ force: true, scheduler: true });
        } catch (e) {
          logger.error('[Scheduler] FBS orders sync failed:', e?.message || e);
        }
      };
      setInterval(runFbs, ivMin * 60 * 1000);
      setTimeout(runFbs, 90 * 1000);
      logger.info(`[Scheduler] FBS orders sync: каждые ${ivMin} мин (fallback, ORDERS_FBS_SYNC_INTERVAL_MINUTES)`);
    }

    if (isSupplierStocksSyncEnabled()) {
      const ivMin = Math.max(10, Number(process.env.SUPPLIER_STOCKS_SYNC_INTERVAL_MINUTES || 10));
      const runSupplierStocks = async () => {
        logger.info('[Scheduler] Supplier stocks sync (fallback interval)...');
        await runSupplierStocksSync();
      };
      setInterval(runSupplierStocks, ivMin * 60 * 1000);
      setTimeout(runSupplierStocks, 120 * 1000);
      logger.info(
        `[Scheduler] Supplier stocks sync: каждые ${ivMin} мин (fallback, SUPPLIER_STOCKS_SYNC_INTERVAL_MINUTES)`
      );
    }

    if (isFboSupplyStatusSyncEnabled()) {
      const ivMin = Math.max(30, Number(process.env.FBO_SUPPLY_STATUS_SYNC_INTERVAL_MINUTES || 30));
      const runFboStatus = async () => {
        logger.info('[Scheduler] FBO supply status sync (fallback interval)...');
        await runFboSupplyStatusSync();
      };
      setInterval(runFboStatus, ivMin * 60 * 1000);
      setTimeout(runFboStatus, 150 * 1000);
      logger.info(
        `[Scheduler] FBO supply status sync: каждые ${ivMin} мин (fallback, FBO_SUPPLY_STATUS_SYNC_INTERVAL_MINUTES)`
      );
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
        const syncStatus = ordersSyncService.getSyncFbsStatus();
        if (syncStatus.inProgress) {
          logger.info('[Scheduler] FBS orders sync: пропуск — предыдущий прогон ещё выполняется');
          return;
        }
        logger.info('[Scheduler] FBS orders sync (server background)...');
        const out = ordersSyncService.startSyncFbsForAllProfilesInBackground({
          force: true,
          scheduler: true
        });
        if (!out.started && out.inProgress) {
          logger.info('[Scheduler] FBS orders sync: пропуск — предыдущий прогон ещё выполняется');
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

