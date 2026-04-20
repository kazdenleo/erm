/**
 * Orders Sync Service
 * Логика синхронизации FBS‑заказов с маркетплейсов и ручного обновления заказа Ozon.
 *
 * Основано на существующей реализации в старом монолитном server.js,
 * адаптировано под модульную архитектуру.
 * При включённом PostgreSQL сохраняет заказы в БД; иначе — в файл.
 */

import fetch from 'node-fetch';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { getFetchProxyAgent } from '../utils/fetchAgent.js';
import { readData, writeData } from '../utils/storage.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';
import ordersService, { orderEligibleForProcurement } from './orders.service.js';
import logger from '../utils/logger.js';
import { ozonPostingNumberFromOrderId } from '../utils/ozonPosting.js';
import { isOrdersFbsBackgroundSyncPaused } from './orders-fbs-sync-pause.js';

// Небольшой in‑memory кэш для rate‑limit'а и отдачи последнего результата
const ordersSyncCache = {
  lastSyncTime: null,
  lastSyncResult: null,
  syncInProgress: false
};

/** Заказ из GET /orders за период до сопоставления с POST /orders/status */
const WB_STATUS_PENDING = '__wb_status_pending__';
/**
 * WB не вернул статус по id или неоднозначный ответ — не считаем «Новым» (иначе сотни ложных «Новый» за год).
 */
const WB_STATUS_UNKNOWN = 'wb_status_unknown';

/** Нормализация marketplace для ключа слияния (как при сборе ordersMap из БД). */
function normMarketplaceMerge(mp) {
  const m = String(mp || '').toLowerCase();
  if (m === 'wb') return 'wildberries';
  return m;
}

/**
 * Якоря «в закупке»: любая строка группы (Ozon ~n, Yandex :offer, общий orderGroupId) даёт тот же набор ключей,
 * чтобы синк с МП не затирал in_procurement из‑за рассинхрона order_id между строками.
 */
function buildProcurementAnchorsFromMap(ordersMap) {
  const anchors = new Set();
  for (const [, o] of ordersMap.entries()) {
    if (o.status !== 'in_procurement') continue;
    const mp = normMarketplaceMerge(o.marketplace);
    const oid = String(o.orderId ?? o.order_id ?? '');
    const gid = o.orderGroupId ?? o.order_group_id;
    if (gid != null && String(gid).trim() !== '') {
      anchors.add(`${mp}|g:${String(gid)}`);
    }
    if (oid) {
      anchors.add(`${mp}|id:${oid}`);
      const t = oid.indexOf('~');
      if (t > 0) anchors.add(`${mp}|id:${oid.slice(0, t)}`);
      if (mp === 'yandex') {
        const c = oid.indexOf(':');
        if (c > 0) anchors.add(`${mp}|id:${oid.slice(0, c)}`);
      }
    }
  }
  return anchors;
}

function incomingMatchesProcurementAnchors(order, anchors) {
  const mp = normMarketplaceMerge(order.marketplace);
  const oid = String(order.orderId ?? '');
  const gid = order.orderGroupId ?? order.order_group_id;
  if (gid != null && String(gid).trim() !== '' && anchors.has(`${mp}|g:${String(gid)}`)) return true;
  if (oid) {
    if (anchors.has(`${mp}|id:${oid}`)) return true;
    const t = oid.indexOf('~');
    if (t > 0 && anchors.has(`${mp}|id:${oid.slice(0, t)}`)) return true;
    if (mp === 'yandex') {
      const c = oid.indexOf(':');
      if (c > 0 && anchors.has(`${mp}|id:${oid.slice(0, c)}`)) return true;
    }
  }
  return false;
}

/**
 * Ozon/Яндекс: статус «Собран» в ERM — только после отметки в приложении (markCollected).
 * Статусы МП вроде «ждёт отгрузки» не должны откатывать «На сборке» и не подменять локальный прогресс при лаге API.
 */
function preserveOzonYandexLocalStatus(existing, incomingStatus) {
  if (!existing || incomingStatus == null || incomingStatus === '') return incomingStatus;
  const mp = normMarketplaceMerge(existing.marketplace);
  if (mp !== 'ozon' && mp !== 'yandex') return incomingStatus;

  const logistics = ['in_transit', 'shipped', 'delivered', 'cancelled'];
  if (logistics.includes(incomingStatus)) return incomingStatus;

  const looseNewLike = new Set(['new', 'unknown', WB_STATUS_UNKNOWN, WB_STATUS_PENDING]);

  if (existing.status === 'assembled') {
    if (looseNewLike.has(incomingStatus) || incomingStatus === 'in_assembly') return 'assembled';
    return incomingStatus;
  }
  if (existing.status === 'in_assembly') {
    if (looseNewLike.has(incomingStatus)) return 'in_assembly';
    if (incomingStatus === 'assembled') return 'in_assembly';
    return incomingStatus;
  }
  return incomingStatus;
}

/**
 * Wildberries: в БД уже «На сборке» (пользователь вернул со «Собран»), а /orders/status даёт complete → assembled.
 * Для Ozon/Яндекс то же уже в preserveOzonYandexLocalStatus; здесь — единое правило для всех МП после слияния.
 */
function preserveLocalInAssemblyAgainstMpAssembled(existing, incomingStatus) {
  if (!existing || incomingStatus == null || incomingStatus === '') return incomingStatus;
  if (existing.status === 'in_assembly' && incomingStatus === 'assembled') return 'in_assembly';
  return incomingStatus;
}

function isTerminalMarketplaceStatus(status) {
  const s = String(status ?? '').toLowerCase();
  return s === 'cancelled' || s === 'delivered';
}

/**
 * Правило по требованию: «На сборке» задаётся ТОЛЬКО вручную (кнопкой / сменой статуса в ERM).
 * Поэтому статус от маркетплейса "in_assembly" не должен автоматически переводить заказ из "new".
 */
function preventAutoInAssembly(existing, incomingStatus) {
  if (incomingStatus == null || incomingStatus === '') return incomingStatus;
  if (incomingStatus !== 'in_assembly') return incomingStatus;
  // Если пользователь уже отправил в сборку в ERM — оставляем.
  if (existing?.status === 'in_assembly') return 'in_assembly';
  // Иначе держим локальный статус (или new для впервые увиденного заказа).
  if (existing?.status) return existing.status;
  return 'new';
}

/**
 * Пользователь вернул заказ в «Новый», а МП ещё отдаёт сборку — в ERM держим new до перехода в логистику.
 */
function applyReturnedToNewStatusGuard(status) {
  if (status == null || status === '') return status;
  const logistics = ['in_transit', 'shipped', 'delivered', 'cancelled'];
  if (logistics.includes(status)) return status;
  const mpStillAssemblingOrIdle = [
    'in_assembly',
    'assembled',
    'wb_assembly',
    'new',
    'unknown',
    WB_STATUS_UNKNOWN,
    WB_STATUS_PENDING
  ];
  if (mpStillAssemblingOrIdle.includes(status)) return 'new';
  return status;
}

class OrdersSyncService {
  /**
   * Синхронизация FBS заказов со всех маркетплейсов.
   * Реализует:
   *  - rate limiting: не чаще 1 раза в минуту (обходим при options.force)
   *  - кэширование результата последнего успешного запуска
   * @param {{ force?: boolean }} [options] — force: принудительно опросить МП, минутный кэш не отдаём
   */
  async syncFbs(options = {}) {
    const force = options.force === true;
    const fromScheduler = options.scheduler === true;
    const profileId = options.profileId ?? null;
    const oneMinute = 60 * 1000;

    if (fromScheduler && isOrdersFbsBackgroundSyncPaused()) {
      logger.info('[Orders Sync] Фоновая синхронизация пропущена (пауза). Ручной импорт на странице «Заказы» по-прежнему доступен.');
      return {
        rateLimited: false,
        retryAfterSeconds: 0,
        cached: false,
        skipped: true,
        result: ordersSyncCache.lastSyncResult
      };
    }

    if (ordersSyncCache.syncInProgress) {
      let waited = 0;
      const maxWait = force ? 120 * 1000 : oneMinute;
      while (ordersSyncCache.syncInProgress && waited < maxWait) {
        /* eslint-disable no-await-in-loop */
        await new Promise(resolve => setTimeout(resolve, 500));
        /* eslint-enable no-await-in-loop */
        waited += 500;
      }
      if (ordersSyncCache.syncInProgress) {
        logger.warn('[Orders Sync] предыдущий запуск ещё выполняется');
        return {
          rateLimited: true,
          retryAfterSeconds: 15,
          cached: false,
          result: null,
          message: 'Дождитесь завершения текущей синхронизации заказов'
        };
      }
      if (!force && ordersSyncCache.lastSyncResult) {
        return {
          rateLimited: false,
          retryAfterSeconds: 0,
          cached: true,
          result: ordersSyncCache.lastSyncResult
        };
      }
    }

    const now = Date.now();
    // rate‑limit: не чаще раза в минуту (импорт с force игнорирует)
    if (!force && ordersSyncCache.lastSyncTime && now - ordersSyncCache.lastSyncTime < oneMinute) {
      const timeLeft = Math.ceil((oneMinute - (now - ordersSyncCache.lastSyncTime)) / 1000);
      logger.info(`[Orders Sync] rate limited, retry after ${timeLeft} s (cached=${!!ordersSyncCache.lastSyncResult})`);
      if (ordersSyncCache.lastSyncResult) {
        return {
          rateLimited: true,
          retryAfterSeconds: timeLeft,
          cached: true,
          result: ordersSyncCache.lastSyncResult
        };
      }
      return {
        rateLimited: true,
        retryAfterSeconds: timeLeft,
        cached: false,
        result: null
      };
    }

    ordersSyncCache.syncInProgress = true;
    ordersSyncCache.lastSyncTime = now;
    if (force) {
      logger.info('[Orders Sync] принудительный импорт заказов (полный опрос маркетплейсов, минутный лимит снят)');
    }

    const results = {
      ozon: { success: 0, failed: 0, orders: [] },
      wildberries: { success: 0, failed: 0, orders: [] },
      yandex: { success: 0, failed: 0, orders: [] }
    };

    /** Если синк WB прошёл — множество id из /api/v3/orders/new (иначе null, правило не трогаем). */
    let wbNewIdsThisSync = null;

    // Чтобы "все" заказы попадали в систему, запрашиваем широкий период.
    // (WB API /api/v3/orders возвращает без текущего статуса — статус догружаем отдельно.)
    const WB_DAYS_BACK = 365;
    const OZON_DAYS_BACK = 365;

    // Конфиги маркетплейсов из того же источника, что и раздел «Интеграции» (БД или файлы)
    const { marketplaces } = await integrationsService.getAllConfigs({ profileId, onlyActive: true });
    const ozonConfig = marketplaces?.ozon || {};
    const wbConfig = marketplaces?.wildberries || {};
    const ymConfig = marketplaces?.yandex || {};

    const ymApiKey = ymConfig?.api_key ?? ymConfig?.apiKey;
    logger.info(`[Orders Sync] start: Ozon=${!!ozonConfig?.api_key} WB=${!!wbConfig?.api_key} Yandex api_key=${!!ymApiKey} campaign_id=${!!(ymConfig?.campaign_id ?? ymConfig?.campaignId)} keys=${Object.keys(ymConfig || {}).join(', ') || '(none)'}`);

    // OZON
    try {
      if (ozonConfig?.client_id && ozonConfig?.api_key) {
        const ozonOrders = await fetchOzonFBSOrders(ozonConfig, OZON_DAYS_BACK);
        results.ozon.success = ozonOrders.length;
        results.ozon.orders = ozonOrders;
      }
    } catch (error) {
      console.error('[Orders Sync] Ozon error:', error);
      results.ozon.failed = 1;
    }

    // Wildberries
    try {
      if (wbConfig?.api_key) {
        // 1) Точные "новые" заказы (WB отдаёт их только тут)
        const wbNewOrders = await fetchWildberriesFBSOrders(wbConfig);
        const wbNewIds = new Set(wbNewOrders.map(o => String(o.orderId || '')).filter(Boolean));
        // 2) Остальные заказы за период (без статуса) — подтянем и обновим статусами
        const wbPeriodOrders = await fetchWildberriesFBSOrdersByPeriod(wbConfig, WB_DAYS_BACK);

        // объединяем и дедуплицируем по orderId
        const byId = new Map();
        [...wbPeriodOrders, ...wbNewOrders].forEach(o => {
          const id = String(o.orderId || '');
          if (!id) return;
          byId.set(id, o);
        });
        const wbOrders = Array.from(byId.values());

        // догружаем статусы (/orders/status) для всех заказов периода — как по кнопке обновления.
        if (wbOrders.length) {
          const statuses = await fetchWBOrdersStatuses(wbConfig, wbOrders.map(o => o.orderId));
          const statusByWbId = new Map(statuses.map(s => [String(s.orderId), s.status]));
          for (const o of wbOrders) {
            const id = String(o.orderId || '');
            if (!id) continue;
            if (statusByWbId.has(id)) {
              const st = statusByWbId.get(id);
              if (st != null && st !== '') o.status = st;
            }
          }
        }

        // «Новый» строго по списку GET /orders/new — как при синке только новых (вкладка WB).
        for (const o of wbOrders) {
          applyWbNewOrdersFeedRule(o, wbNewIds);
        }
        logger.info(
          `[Orders Sync] WB: /orders/new → ${wbNewIds.size} id во фиде; «Новый» выставляется только согласованно с /orders/status`
        );
        results.wildberries.success = wbOrders.length;
        results.wildberries.orders = wbOrders;
        wbNewIdsThisSync = wbNewIds;
      }
    } catch (error) {
      console.error('[Orders Sync] Wildberries error:', error);
      results.wildberries.failed = 1;
    }

    // Yandex Market
    let ymReason = null;
    try {
      if (ymApiKey) {
        const ymResult = await fetchYandexFBSOrders(ymConfig);
        const ymOrders = ymResult?.orders ?? [];
        ymReason = ymResult?.reason ?? null;
        results.yandex.success = ymOrders.length;
        results.yandex.orders = ymOrders;
      }
    } catch (error) {
      console.error('[Orders Sync] Yandex error:', error);
      results.yandex.failed = 1;
    }

    // существующие заказы (из БД или файла — в зависимости от настроек)
    let existingOrders = [];
    try {
      if (repositoryFactory.isUsingPostgreSQL()) {
        existingOrders = await repositoryFactory.getOrdersRepository().findAll(
          profileId != null ? { profileId } : {}
        );
        if (!Array.isArray(existingOrders)) existingOrders = [];
      } else {
        const existingData = await readData('orders');
        existingOrders = (existingData && existingData.orders) || [];
      }
    } catch (e) {
      console.warn('[Orders Sync] Failed to load existing orders:', e.message);
    }

    let newOrders = [
      ...results.ozon.orders,
      ...results.wildberries.orders,
      ...results.yandex.orders
    ];
    if (ozonConfig?.client_id && ozonConfig?.api_key && existingOrders.length) {
      try {
        const extraOzon = await fetchOzonExtraPostingsFromExisting(
          existingOrders,
          results.ozon.orders,
          ozonConfig
        );
        if (extraOzon.length) {
          newOrders = [...newOrders, ...extraOzon];
        }
      } catch (e) {
        logger.warn('[Orders Sync] Ozon catch-up:', e.message);
      }
    }

    // объединяем по ключу marketplace:orderId
    const ordersMap = new Map();
    existingOrders.forEach(order => {
      const oid = order.orderId ?? order.order_id;
      const mp = (order.marketplace || '').toLowerCase();
      const key = `${mp === 'wb' ? 'wildberries' : mp}:${oid}`;
      ordersMap.set(key, { ...order, marketplace: mp === 'wb' ? 'wildberries' : order.marketplace });
    });

    const procurementAnchors = buildProcurementAnchorsFromMap(ordersMap);

    newOrders.forEach(order => {
      const key = `${order.marketplace}:${order.orderId}`;
      const existing = ordersMap.get(key);
      const mpExisting = (existing?.marketplace || '').toLowerCase();
      const isWbExisting = mpExisting === 'wb' || mpExisting === 'wildberries';
      const incomingMp = (order.marketplace || '').toLowerCase();
      const isWbIncoming = incomingMp === 'wb' || incomingMp === 'wildberries';

      let nextStatus = order.status;
      if (isTerminalMarketplaceStatus(order.status)) {
        // Терминальные статусы маркетплейса всегда должны побеждать локальные якоря "в закупке".
        // Иначе отменённый заказ может "залипнуть" в in_procurement.
        nextStatus = String(order.status).toLowerCase();
      } else if (existing?.status === 'in_procurement') {
        nextStatus = existing.status;
      } else if (incomingMatchesProcurementAnchors(order, procurementAnchors)) {
        nextStatus = 'in_procurement';
      } else if (existing && isWbExisting && isWbIncoming && existing.status === 'assembled') {
        const inc = order.status;
        if (
          inc == null ||
          inc === 'new' ||
          inc === 'in_assembly' ||
          inc === 'wb_assembly' ||
          inc === 'unknown' ||
          inc === WB_STATUS_PENDING ||
          inc === WB_STATUS_UNKNOWN
        ) {
          nextStatus = 'assembled';
        }
      } else if (
        isWbIncoming &&
        (order.status === WB_STATUS_PENDING || order.status === WB_STATUS_UNKNOWN)
      ) {
        const oid = String(order.orderId || '');
        const inFeed = wbNewIdsThisSync != null && wbNewIdsThisSync.has(oid);
        if (inFeed) {
          nextStatus = 'new';
        } else if (
          existing?.status &&
          !['new', WB_STATUS_PENDING, WB_STATUS_UNKNOWN, 'unknown'].includes(existing.status)
        ) {
          nextStatus = existing.status;
        } else {
          nextStatus = WB_STATUS_UNKNOWN;
        }
      }

      if (
        (incomingMp === 'ozon' || incomingMp === 'yandex') &&
        existing &&
        existing.status !== 'in_procurement' &&
        !incomingMatchesProcurementAnchors(order, procurementAnchors)
      ) {
        nextStatus = preserveOzonYandexLocalStatus(existing, nextStatus);
      }

      if (
        existing &&
        existing.status !== 'in_procurement' &&
        !incomingMatchesProcurementAnchors(order, procurementAnchors)
      ) {
        nextStatus = preserveLocalInAssemblyAgainstMpAssembled(existing, nextStatus);
      }

      // Не переводим автоматически в "На сборке" из данных маркетплейса.
      nextStatus = preventAutoInAssembly(existing, nextStatus);

      const mergedReturnedToNewAt = existing?.returnedToNewAt ?? order.returnedToNewAt ?? null;

      ordersMap.set(key, {
        ...(existing || {}),
        ...order,
        status: nextStatus,
        returnedToNewAt: mergedReturnedToNewAt
      });
    });

    const preWbPreserve = new Map();
    for (const [key, order] of ordersMap.entries()) {
      const mp = String(order.marketplace || '').toLowerCase();
      if (mp !== 'wb' && mp !== 'wildberries') continue;
      if (order.status === 'in_procurement' || order.status === 'assembled') {
        preWbPreserve.set(key, order.status);
      }
    }

    // Терминальные для доп. опроса WB: только доставлен/отменён («Отгружен» в ERM не блокирует синк).
    const finalStatuses = ['delivered', 'cancelled'];
    const wbExistingIds = existingOrders
      .filter(o => {
        const mp = (o.marketplace || '').toLowerCase();
        return (mp === 'wb' || mp === 'wildberries') && o.status && !finalStatuses.includes(o.status);
      })
      .map(o => o.orderId ?? o.order_id)
      .filter(Boolean);
    if (wbExistingIds.length > 0 && wbConfig?.api_key) {
      try {
        const statuses = await fetchWBOrdersStatuses(wbConfig, wbExistingIds);
        const statusByWbId = new Map(statuses.map(s => [String(s.orderId), s.status]));
        for (const [key, order] of ordersMap.entries()) {
          if ((order.marketplace === 'wildberries' || order.marketplace === 'wb') && statusByWbId.has(String(order.orderId || order.order_id))) {
            const prev = order.status;
            const apiSt = statusByWbId.get(String(order.orderId || order.order_id));
            const existingBeforeWbPoll = { status: prev };
            // Иначе ответ /orders/status (confirm → in_assembly) перезаписывает «Новый» после preventAutoInAssembly в основном merge.
            let next = preserveLocalInAssemblyAgainstMpAssembled(existingBeforeWbPoll, apiSt);
            next = preventAutoInAssembly(existingBeforeWbPoll, next);
            order.status = next;
          }
        }
        for (const [key, order] of ordersMap.entries()) {
          const want = preWbPreserve.get(key);
          if (!want) continue;
          const api = order.status;
          if (
            want === 'in_procurement' &&
            (api === 'new' || api === WB_STATUS_UNKNOWN || api === WB_STATUS_PENDING || api === 'unknown')
          ) {
            order.status = 'in_procurement';
          } else if (want === 'assembled' && (api === 'new' || api === 'in_assembly')) {
            order.status = 'assembled';
          }
        }
        logger.info(`[Orders Sync] WB: обновлены статусы для ${statuses.length} заказов`);
      } catch (e) {
        logger.warn('[Orders Sync] WB status refresh failed:', e.message);
      }
    }

    // Реальные «Новые» WB перечислены только в GET /orders/new. Старый «new» в БД без id во фиде — не показываем как новый заказ.
    if (wbNewIdsThisSync != null) {
      for (const [, order] of ordersMap.entries()) {
        const mp = String(order.marketplace || '').toLowerCase();
        if (mp !== 'wb' && mp !== 'wildberries') continue;
        if (order.status !== 'new') continue;
        if (order.returnedToNewAt) continue;
        const wid = String(order.orderId ?? order.order_id ?? '');
        if (wid && !wbNewIdsThisSync.has(wid)) {
          order.status = WB_STATUS_UNKNOWN;
        }
      }
    }

    if (wbNewIdsThisSync != null) {
      for (const [, order] of ordersMap.entries()) {
        const mp = String(order.marketplace || '').toLowerCase();
        if (mp !== 'wb' && mp !== 'wildberries') continue;
        applyWbNewOrdersFeedRule(order, wbNewIdsThisSync);
      }
    }

    for (const [, order] of ordersMap.entries()) {
      if (!order.returnedToNewAt || order.status === 'in_procurement') continue;
      order.status = applyReturnedToNewStatusGuard(order.status);
    }

    const allOrders = Array.from(ordersMap.values());
    if (profileId != null) {
      for (const o of allOrders) {
        if (o && (o.profileId == null && o.profile_id == null)) o.profileId = profileId;
      }
    }

    if (repositoryFactory.isUsingPostgreSQL()) {
      const ordersRepo = repositoryFactory.getOrdersRepository();
      try {
        await ordersRepo.upsertFromSyncBatch(allOrders);
      } catch (err) {
        console.error('[Orders Sync] Batch upsert failed:', err.message);
        throw err;
      }

      // Авто-резерв для новых заказов (и «ожидающих» WB до резолва статуса): product_id или сопоставление по SKU.
      // Идемпотентно: reserve создаётся только если его ещё нет.
      for (const o of allOrders) {
        try {
          if (!o || !orderEligibleForProcurement(o)) continue;
          if (!o.marketplace || o.orderId == null) continue;
          const row = await ordersRepo.findByMarketplaceAndOrderId(o.marketplace, String(o.orderId), profileId);
          if (!row) continue;
          await ordersService._reserveForOrderIfStockAvailable(row);
        } catch {
          // не блокируем синк из-за одного заказа
        }
      }
    } else {
      await writeData('orders', {
        orders: allOrders,
        lastSync: new Date().toISOString()
      });
    }

    ordersSyncCache.lastSyncResult = results;
    ordersSyncCache.syncInProgress = false;

    logger.info(`[Orders Sync] done: ozon=${results.ozon.success} wb=${results.wildberries.success} yandex=${results.yandex.success} (yandex api_key was ${ymApiKey ? 'set' : 'missing'})`);
    if (ymApiKey && results.yandex.success === 0) {
      logger.info(ymReason ? `[YM Orders] 0 orders: ${ymReason}` : '[YM Orders] 0 orders. Search log for "[YM Orders]" above for details.');
    }

    return {
      rateLimited: false,
      retryAfterSeconds: 0,
      cached: false,
      result: results
    };
  }

  /**
   * Фоновый сценарий: синхронизация заказов для каждого профиля (аккаунта) с отдельными интеграциями.
   * При файловом хранилище заказов — один проход как раньше.
   */
  async syncFbsForAllProfiles(options = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return this.syncFbs(options);
    }
    const ids = await integrationsService.getProfileIdsWithActiveMarketplaceIntegrations();
    if (ids.length === 0) {
      return {
        rateLimited: false,
        cached: false,
        skipped: true,
        retryAfterSeconds: 0,
        profiles: [],
        result: [],
        message: 'Нет профилей с активными интеграциями маркетплейсов',
      };
    }
    const combined = {
      rateLimited: false,
      cached: false,
      skipped: false,
      retryAfterSeconds: 0,
      profiles: [],
      result: null
    };
    for (const profileId of ids) {
      const out = await this.syncFbs({ ...options, profileId });
      combined.profiles.push({ profileId, ...out });
      if (out.rateLimited) combined.rateLimited = true;
      if (out.cached) combined.cached = true;
      if (out.skipped) combined.skipped = true;
      if ((out.retryAfterSeconds || 0) > combined.retryAfterSeconds) {
        combined.retryAfterSeconds = out.retryAfterSeconds || 0;
      }
    }
    combined.result = combined.profiles.map((p) => p.result).filter(Boolean);
    return combined;
  }

  /**
   * Принудительное обновление конкретного заказа Ozon по posting_number.
   */
  async refreshOzonOrder(orderIdRaw, { profileId = null } = {}) {
    const storageOrderId = decodeURIComponent(String(orderIdRaw || '').trim());
    const postingNum = ozonPostingNumberFromOrderId(storageOrderId);

    const { marketplaces } = await integrationsService.getAllConfigs(profileId);
    const ozonConfig = marketplaces?.ozon || {};
    if (!ozonConfig?.client_id || !ozonConfig?.api_key) {
      const error = new Error('Ozon API не настроен');
      error.statusCode = 400;
      throw error;
    }

    let syncRows = [];
    let errorMessage = null;

    try {
      const raw = await fetchOzonOrderDetailRaw(ozonConfig, postingNum);
      syncRows = mapOzonPostingToSyncRows(raw);
    } catch (error) {
      console.error('[Order Refresh] Direct fetch failed:', error.message);
      errorMessage = error.message;
      try {
        const ozonOrders = await fetchOzonFBSOrders(ozonConfig);
        syncRows = ozonOrders.filter(
          (o) =>
            ozonPostingNumberFromOrderId(o.orderId) === postingNum ||
            o.orderId === storageOrderId
        );
      } catch (listError) {
        const err = new Error(
          `Ошибка получения заказа: ${errorMessage}. Дополнительная ошибка при попытке получить из списка: ${listError.message}`
        );
        err.statusCode = 500;
        throw err;
      }
    }

    if (!syncRows.length) {
      const err = new Error(
        errorMessage
          ? `Заказ ${storageOrderId} не найден в Ozon API. Ошибка при прямом запросе: ${errorMessage}`
          : `Заказ ${storageOrderId} не найден в Ozon API. Возможно, он не существует или недоступен через текущий API метод.`
      );
      err.statusCode = 404;
      throw err;
    }

    let oldStatus = null;
    let statusChanged = false;
    let lastMerged = null;

    const mergeOzonRow = (existing, incoming) => {
      let nextStatus = incoming.status;
      if (existing?.status === 'in_procurement' && !isTerminalMarketplaceStatus(incoming.status)) {
        nextStatus = existing.status;
      } else if (existing) {
        nextStatus = preserveOzonYandexLocalStatus(existing, nextStatus);
        if (existing.returnedToNewAt) {
          nextStatus = applyReturnedToNewStatusGuard(nextStatus);
        }
      }
      const rowStatusChanged = existing ? existing.status !== nextStatus : false;
      return {
        merged: {
          ...incoming,
          status: nextStatus,
          returnedToNewAt: existing?.returnedToNewAt ?? incoming.returnedToNewAt ?? null,
          profileId: existing?.profileId ?? existing?.profile_id ?? profileId ?? incoming.profileId
        },
        rowStatusChanged
      };
    };

    if (repositoryFactory.isUsingPostgreSQL()) {
      const ordersRepo = repositoryFactory.getOrdersRepository();
      const existingFirst = await ordersRepo.findByMarketplaceAndOrderId('ozon', storageOrderId, profileId);
      if (existingFirst) oldStatus = existingFirst.status;

      for (const row of syncRows) {
        const existing = await ordersRepo.findByMarketplaceAndOrderId('ozon', String(row.orderId), profileId);
        const { merged, rowStatusChanged } = mergeOzonRow(existing, row);
        if (rowStatusChanged) statusChanged = true;
        if (!existing && profileId != null && merged.profileId == null) {
          merged.profileId = profileId;
        }
        await ordersRepo.upsertFromSync(merged);
        lastMerged = merged;
      }
    } else {
      const existingData = await readData('orders');
      const existingOrders = (existingData && existingData.orders) || [];
      const idxFirst = existingOrders.findIndex(
        (o) => o.marketplace === 'ozon' && (o.orderId || o.order_id) === storageOrderId
      );
      if (idxFirst >= 0) oldStatus = existingOrders[idxFirst].status;

      for (const row of syncRows) {
        const rid = String(row.orderId);
        const idx = existingOrders.findIndex((o) => o.marketplace === 'ozon' && (o.orderId || o.order_id) === rid);
        const existing = idx >= 0 ? existingOrders[idx] : null;
        const { merged, rowStatusChanged } = mergeOzonRow(existing, row);
        if (rowStatusChanged) statusChanged = true;
        if (idx >= 0) existingOrders[idx] = merged;
        else existingOrders.push(merged);
        lastMerged = merged;
      }
      await writeData('orders', {
        orders: existingOrders,
        lastSync: new Date().toISOString()
      });
    }

    return {
      message: `Заказ ${storageOrderId} обновлен`,
      order: lastMerged,
      oldStatus,
      statusChanged
    };
  }

  /**
   * Получить детальную информацию по заказу для страницы «Карточка заказа».
   * Ozon: POST v3/posting/fbs/get с полным with.
   * WB: список заказов за период с пагинацией, поиск по id.
   */
  async getOrderDetail(marketplace, orderIdRaw, { profileId = null } = {}) {
    const orderId = decodeURIComponent(String(orderIdRaw || '').trim());
    if (!orderId) {
      const err = new Error('ID заказа не указан');
      err.statusCode = 400;
      throw err;
    }

    const { marketplaces } = await integrationsService.getAllConfigs(profileId);
    const normMarketplace = String(marketplace || '').toLowerCase();
    if (normMarketplace === 'ozon') {
      const ozonConfig = marketplaces?.ozon || {};
      if (!ozonConfig?.client_id || !ozonConfig?.api_key) {
        const err = new Error('Ozon API не настроен');
        err.statusCode = 400;
        throw err;
      }
      try {
        const result = await fetchOzonOrderDetailRaw(ozonConfig, orderId);
        return { marketplace: 'ozon', detail: result };
      } catch (e) {
        if (e.statusCode === 404) {
          const local = await getLocalOrderByMarketplaceAndOrderId('ozon', orderId, profileId);
          if (local) {
            return {
              marketplace: 'ozon',
              detail: buildOzonDetailFromLocalOrder(local, ozonPostingNumberFromOrderId(orderId)),
              fromLocal: true
            };
          }
        }
        throw e;
      }
    }
    if (normMarketplace === 'wildberries' || normMarketplace === 'wb') {
      const wbConfig = marketplaces?.wildberries || {};
      if (!wbConfig?.api_key) {
        const err = new Error('Wildberries API не настроен');
        err.statusCode = 400;
        throw err;
      }
      try {
        const result = await fetchWBOrderById(wbConfig, orderId);
        return { marketplace: 'wildberries', detail: result };
      } catch (e) {
        if (e.statusCode !== 404) throw e;
        const localOrder = await getLocalOrderByMarketplaceAndOrderId('wildberries', orderId, profileId);
        if (!localOrder) throw e;
        const detail = buildWBDetailFromLocalOrder(localOrder, orderId);
        return { marketplace: 'wildberries', detail, fromLocal: true };
      }
    }
    if (normMarketplace === 'yandex' || normMarketplace === 'ym' || normMarketplace === 'yandexmarket') {
      const ymConfig = marketplaces?.yandex || {};
      try {
        const rawOrder = await fetchYandexOrderDetailRaw(ymConfig, orderId);
        return { marketplace: 'yandex', detail: rawOrder };
      } catch (e) {
        if (e.statusCode !== 404) throw e;
        const localOrder = await getLocalOrderByMarketplaceAndOrderId('yandex', orderId, profileId);
        if (!localOrder) throw e;
        const detail = buildYandexDetailFromLocalOrder(localOrder);
        return { marketplace: 'yandex', detail, fromLocal: true };
      }
    }
    const err = new Error(`Детали заказа для маркетплейса "${marketplace}" пока не поддерживаются`);
    err.statusCode = 501;
    throw err;
  }
}

// ===== Helpers, перенесённые из старого server.js =====

/** Детальная информация по отправлению Ozon (сырой result для карточки заказа) */
async function fetchOzonOrderDetailRaw(config, postingNumberRaw) {
  const posting_number = ozonPostingNumberFromOrderId(postingNumberRaw);
  if (!posting_number) {
    const err = new Error('Не указан posting_number Ozon');
    err.statusCode = 400;
    throw err;
  }
  const { client_id, api_key } = config;
  const response = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/get', {
    method: 'POST',
    headers: {
      'Client-Id': String(client_id),
      'Api-Key': String(api_key),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      posting_number: String(posting_number),
      with: {
        analytics_data: false,
        barcodes: false,
        financial_data: false,
        legal_info: false,
        product_exemplars: false,
        related_postings: true,
        translit: false
      }
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`Ozon API error ${response.status}: ${errorText.substring(0, 200)}`);
    err.statusCode = response.status === 404 ? 404 : 502;
    throw err;
  }
  const data = await response.json();
  if (!data.result) {
    const err = new Error(`Заказ ${posting_number} не найден в Ozon`);
    err.statusCode = 404;
    throw err;
  }
  return data.result;
}

async function fetchOzonOrderByPostingNumber(config, postingNumberRaw) {
  const postingNumber = ozonPostingNumberFromOrderId(postingNumberRaw);
  if (!postingNumber) {
    throw new Error('Не указан posting_number Ozon');
  }
  const { client_id, api_key } = config;

  const response = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/get', {
    method: 'POST',
    headers: {
      'Client-Id': String(client_id),
      'Api-Key': String(api_key),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      posting_number: String(postingNumber),
      with: {
        analytics_data: false,
        financial_data: false,
        transliteration: false
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ozon API error ${response.status}: ${errorText.substring(0, 200)}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (parseError) {
    throw new Error(`Failed to parse Ozon API response: ${parseError.message}`);
  }

  if (!data.result) {
    throw new Error(`Order ${postingNumber} not found in Ozon API response`);
  }

  const order = data.result;
  const mappedStatus = mapOzonOrderStatus(order.status);
  const createdAt = getOzonPostingDate(order);
  if (!createdAt && order.posting_number) {
    logger.info(`[Ozon] Нет даты у постинга ${order.posting_number} (get), ключи: ${Object.keys(order).join(', ')}`);
  }
  const inProcessAt = parseOzonDate(order.in_process_at ?? order.inProcessAt);
  const shipmentDate = parseOzonDate(order.shipment_date ?? order.shipmentDate);

  return {
    marketplace: 'ozon',
    orderId: order.posting_number,
    offerId: order.products?.[0]?.offer_id || '',
    sku: order.products?.[0]?.sku || '',
    productName: order.products?.[0]?.name || '',
    quantity: order.products?.[0]?.quantity || 0,
    price: order.products?.[0]?.price || 0,
    status: mappedStatus,
    createdAt: createdAt || '',
    inProcessAt: inProcessAt || '',
    shipmentDate: shipmentDate || '',
    customerName: order.customer_name || '',
    customerPhone: order.customer_phone || '',
    deliveryAddress: order.delivery_method?.warehouse_name || ''
  };
}

/** Извлекает дату появления заказа на маркетплейсе из постинга Ozon.
 *  Приоритет: in_process_at (дата начала обработки / получения заказа), затем created_at, затем shipment_date. */
function getOzonPostingDate(posting) {
  if (!posting || typeof posting !== 'object') return '';
  const candidates = [
    posting.in_process_at,
    posting.inProcessAt,
    posting.created_at,
    posting.createdAt,
    posting.shipment_date,
    posting.shipmentDate
  ];
  for (const v of candidates) {
    const parsed = parseOzonDate(v);
    if (parsed) return parsed;
  }
  return '';
}

/** Парсит дату из ответа Ozon (строка ISO или timestamp), возвращает ISO-строку или пустую строку */
function parseOzonDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v;
  try {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  } catch {
    return '';
  }
}

/**
 * Один постинг FBS Ozon → одна или несколько строк заказа (по числу товаров).
 * Раньше брали только products[0] — штрихкод другой позиции не находил заказ на сборке.
 * Строки связаны order_group_id = posting_number; первая строка order_id = posting_number (этикетка API).
 * Доп. строки: "{posting_number}~{index}" чтобы уникальный ключ (marketplace, order_id).
 */
function mapOzonPostingToSyncRows(order) {
  const postingNumber = order?.posting_number != null ? String(order.posting_number).trim() : '';
  if (!postingNumber) return [];

  const rawProducts = Array.isArray(order.products) ? order.products.filter(Boolean) : [];
  const lines = rawProducts.length > 0 ? rawProducts : [null];

  const mappedStatus = mapOzonOrderStatus(order.status);
  const createdAt = getOzonPostingDate(order);
  if (!createdAt && postingNumber) {
    logger.debug(`[Ozon] Нет даты у постинга ${postingNumber}, ключи: ${Object.keys(order).join(', ')}`);
  }
  const inProcessAt = parseOzonDate(order.in_process_at ?? order.inProcessAt);
  const shipmentDate = parseOzonDate(order.shipment_date ?? order.shipmentDate);

  const multi = lines.length > 1;
  const groupId = multi ? postingNumber : null;

  return lines.map((p, idx) => {
    const orderId = !multi ? postingNumber : idx === 0 ? postingNumber : `${postingNumber}~${idx}`;
    const offerId = p?.offer_id != null ? String(p.offer_id).trim() : '';
    const skuVal = p?.sku != null && p.sku !== '' ? String(p.sku).trim() : '';
    const qty = parseInt(p?.quantity, 10);
    const priceNum = parseFloat(p?.price);

    return {
      marketplace: 'ozon',
      orderId,
      orderGroupId: groupId,
      offerId,
      sku: skuVal,
      productName: p?.name != null ? String(p.name) : '',
      quantity: !Number.isNaN(qty) && qty > 0 ? qty : 1,
      price: !Number.isNaN(priceNum) ? priceNum : 0,
      status: mappedStatus,
      createdAt: createdAt || '',
      inProcessAt: inProcessAt || '',
      shipmentDate: shipmentDate || '',
      customerName: order.customer_name || '',
      customerPhone: order.customer_phone || '',
      deliveryAddress: (() => {
        const wid = order?.delivery_method?.warehouse_id ?? order?.delivery_method?.warehouseId ?? null;
        const name = order?.delivery_method?.warehouse_name ?? order?.delivery_method?.warehouseName ?? '';
        const nameStr = String(name || '').trim();
        if (wid != null && String(wid).trim() !== '') {
          return nameStr ? `${String(wid).trim()} — ${nameStr}` : String(wid).trim();
        }
        return nameStr;
      })()
    };
  });
}

/**
 * v3/posting/fbs/list для одного интервала since..to: все страницы (offset), до limit записей на страницу.
 * @throws {Error} при HTTP-ошибке Ozon
 */
async function fetchOzonFbsListForPeriod(config, since, to) {
  const { client_id, api_key } = config;
  const acc = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const response = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/list', {
      method: 'POST',
      headers: {
        'Client-Id': String(client_id),
        'Api-Key': String(api_key),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        dir: 'ASC',
        filter: {
          since: since.toISOString(),
          to: to.toISOString()
        },
        limit,
        offset,
        with: {
          analytics_data: false,
          financial_data: false,
          transliteration: false
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${response.status}: ${errorText.substring(0, 400)}`);
    }

    const data = await response.json();
    const postings = data.result?.postings ?? [];
    acc.push(...postings);
    if (postings.length < limit) break;
    offset += limit;
  }
  return acc;
}

async function fetchOzonFBSOrders(config, daysBack = 90) {
  try {
    const { client_id, api_key } = config;
    if (!client_id || !api_key) return [];

    const now = new Date();
    const windowStart = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    /** Иначе 400 PERIOD_IS_TOO_LONG при одном запросе на 90–365 дн. */
    const CHUNK_DAYS = 30;
    const chunkMs = CHUNK_DAYS * 24 * 60 * 60 * 1000;

    const byPosting = new Map();
    let t = windowStart.getTime();
    const endMs = now.getTime();
    let chunkIdx = 0;
    while (t < endMs) {
      const chunkEndMs = Math.min(t + chunkMs, endMs);
      const since = new Date(t);
      const to = new Date(chunkEndMs);
      chunkIdx += 1;
      try {
        const postings = await fetchOzonFbsListForPeriod(config, since, to);
        logger.info(
          `[Ozon Orders] чанк ${chunkIdx}: ${since.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}, постингов ${postings.length}`
        );
        for (const p of postings) {
          const pn = p?.posting_number;
          if (pn) byPosting.set(String(pn), p);
        }
      } catch (e) {
        logger.warn(
          `[Ozon Orders] чанк ${chunkIdx} (${since.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}): ${e.message}`
        );
      }
      t = chunkEndMs + 1;
    }

    logger.info(`[Ozon Orders] всего уникальных постингов: ${byPosting.size} (дней назад: ${daysBack})`);
    return [...byPosting.values()].flatMap(mapOzonPostingToSyncRows);
  } catch (error) {
    logger.error('[Ozon Orders] Fetch error:', error.message);
    return [];
  }
}

/**
 * Догоняющий опрос posting/fbs/get для постингов, которые уже есть в БД с нефинальным статусом,
 * но не попали в ответ list за период (часто из‑за фильтра дат/лага списка).
 */
async function fetchOzonExtraPostingsFromExisting(existingOrders, alreadySyncedOzonRows, ozonConfig) {
  const seenBases = new Set();
  for (const o of alreadySyncedOzonRows || []) {
    if (String(o.marketplace || '').toLowerCase() !== 'ozon') continue;
    seenBases.add(ozonPostingNumberFromOrderId(o.orderId));
  }
  const terminal = new Set(['delivered', 'cancelled']);
  const bases = [];
  const queued = new Set();
  for (const o of existingOrders || []) {
    if (String(o.marketplace || '').toLowerCase() !== 'ozon') continue;
    const st = o.status;
    if (!st || terminal.has(st)) continue;
    const base = ozonPostingNumberFromOrderId(o.orderId ?? o.order_id);
    if (!base || seenBases.has(base) || queued.has(base)) continue;
    queued.add(base);
    bases.push(base);
    if (bases.length >= 40) break;
  }
  if (!bases.length) return [];
  const extra = [];
  for (const base of bases) {
    try {
      const raw = await fetchOzonOrderDetailRaw(ozonConfig, base);
      extra.push(...mapOzonPostingToSyncRows(raw));
    } catch (e) {
      logger.debug(`[Ozon catch-up] posting ${base}: ${e.message}`);
    }
    /* eslint-disable no-await-in-loop */
    await new Promise((r) => setTimeout(r, 40));
    /* eslint-enable no-await-in-loop */
  }
  if (extra.length) {
    logger.info(`[Ozon catch-up] догружено строк из get: ${extra.length} (уникальных постингов: ${bases.length})`);
  }
  return extra;
}

function normalizeWbStatusCode(c) {
  if (c == null) return '';
  return String(c).trim().toUpperCase();
}

function wbCodesIndicateCancel(codes) {
  return codes.some(c => c.includes('CANCEL'));
}

function wbCodesIndicateTransit(codes) {
  const transit = new Set([
    'SORTED',
    'ACCEPTED_BY_CARRIER',
    'SENT_TO_CARRIER',
    'READY_FOR_PICKUP',
    'POSTPONED_DELIVERY',
    'RECEIVED_BY_CARRIER',
    'ARRIVED_AT_PICKUP_POINT',
    'AT_PICKUP_POINT',
    'ON_WAY_TO_PICKUP'
  ]);
  return codes.some(c => transit.has(c));
}

function wbStringInTransit(wb) {
  const transit = new Set([
    'sorted',
    'accepted_by_carrier',
    'sent_to_carrier',
    'ready_for_pickup',
    'postponed_delivery',
    'received_by_carrier',
    'arrived_at_pickup_point',
    'at_pickup_point',
    'on_way_to_pickup'
  ]);
  return transit.has(wb);
}

function wbStringCancelled(wb) {
  return (
    wb === 'canceled' ||
    wb === 'cancelled' ||
    wb === 'canceled_by_client' ||
    wb === 'canceled_by_carrier' ||
    wb === 'declined_by_client' ||
    wb === 'defect' ||
    (wb && wb.includes('cancel'))
  );
}

/**
 * Единый разбор статуса WB FBS из supplierStatus, wbStatus и цепочки statuses[].code.
 * Учитываем оба слоя (продавец + логистика), чтобы не показывать «доставлен», пока wb не SOLD.
 * supplierStatus=complete без признаков логистики → «Собран» (пока поставка не ушла в доставку WB);
 * «В доставке» — когда в ответе есть этапы логистики (перевозчик, сортировка и т.д.), обычно после закрытия поставки.
 */
function resolveWildberriesOrderStatus(supplierStatus, wbStatus, statusCodes) {
  const sup = supplierStatus != null ? String(supplierStatus).trim().toLowerCase() : '';
  const wb = wbStatus != null ? String(wbStatus).trim().toLowerCase() : '';
  const codes = Array.isArray(statusCodes)
    ? statusCodes.map(normalizeWbStatusCode).filter(Boolean)
    : [];

  if (sup === 'cancel' || sup === 'cancel_carrier' || wbStringCancelled(wb) || wbCodesIndicateCancel(codes)) {
    return 'cancelled';
  }
  if (wb === 'sold' || codes.includes('SOLD')) {
    return 'delivered';
  }

  const inTransit = wbStringInTransit(wb) || wbCodesIndicateTransit(codes);

  // complete у продавца = всё собрано, но «В доставке» только после фактического входа в логистику WB
  if (sup === 'complete') {
    return inTransit ? 'in_transit' : 'assembled';
  }

  let stage = 0;
  if (sup === 'new') stage = Math.max(stage, 1);
  if (sup === 'confirm') stage = Math.max(stage, 2);
  if (inTransit) stage = Math.max(stage, 4);

  if (!sup && codes.length) {
    if (codes.some(c => c === 'NEW')) stage = Math.max(stage, 1);
    if (codes.some(c => c === 'CONFIRM' || c === 'CONFIRMED')) stage = Math.max(stage, 2);
    if (codes.some(c => c === 'COMPLETE' || c === 'SUPPLIER_COMPLETE')) {
      return inTransit ? 'in_transit' : 'assembled';
    }
  }

  if (stage >= 4) return 'in_transit';
  // По правилу: WB «На сборке» появляется только после действий в ERM (создали поставку/добавили заказ),
  // поэтому статус из API (confirm/waiting) не переводит заказ в in_assembly.
  if (stage === 2) return 'new';
  if (stage === 1) return 'new';
  // Нет ни new/confirm в ответе — не считаем заказ «на сборке» (иначе раздувается счётчик).
  if (!sup && wb === 'waiting') {
    return 'new';
  }
  return WB_STATUS_UNKNOWN;
}

/**
 * Согласование с вкладкой «Новые» WB (GET /api/v3/orders/new):
 * — id в этом списке → «Новый» в ERM (кроме уже финальных с маркетплейса / доставки).
 * «На сборке» (in_assembly) задаётся только из supplierStatus=confirm в /orders/status,
 * без эвристики «нет в /new значит на сборке» — она раздувала счётчик при любых «new» после резолвера.
 * Если id есть в фиде, но /orders/status уже дал confirm («На сборке») — не откатываем в «Новый».
 */
function applyWbNewOrdersFeedRule(order, newFeedIds) {
  const id = String(order.orderId ?? order.order_id ?? '');
  if (!id) return;
  if (order.status === 'in_procurement') return;

  if (order.status === 'wb_assembly') {
    order.status = 'in_assembly';
  }

  if (!order.status || order.status === 'unknown') {
    order.status = WB_STATUS_PENDING;
  }

  if (newFeedIds.has(id)) {
    if (
      [
        'delivered',
        'cancelled',
        'in_transit',
        'shipped',
        'in_assembly',
        'assembled',
        'in_procurement',
      ].includes(order.status)
    ) {
      return;
    }
    order.status = 'new';
  }
}

function extractWbStatusOrdersList(data) {
  if (!data || typeof data !== 'object') return [];
  const candidates = [data.orders, data.data, data.result?.orders, data.payload?.orders];
  for (const arr of candidates) {
    if (Array.isArray(arr)) return arr;
  }
  if (Array.isArray(data.result)) return data.result;
  return [];
}

/**
 * Получить текущие статусы заказов WB по списку ID (POST /api/v3/orders/status).
 * Нужно для обновления статусов уже загруженных заказов (которые больше не в /new).
 */
async function fetchWBOrdersStatuses(config, orderIds) {
  if (!orderIds || orderIds.length === 0) return [];
  const { api_key } = config;
  const url = 'https://marketplace-api.wildberries.ru/api/v3/orders/status';
  const BATCH = 100;
  const all = [];
  for (let i = 0; i < orderIds.length; i += BATCH) {
    const batch = orderIds.slice(i, i + BATCH);
    const numericIds = batch.map(id => (typeof id === 'string' ? parseInt(id, 10) : id)).filter(n => !Number.isNaN(n));
    if (numericIds.length === 0) continue;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: String(api_key),
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ orders: numericIds })
      });
      if (!response.ok) {
        const errText = await response.text();
        logger.warn(`[WB Orders] status API error ${response.status}: ${errText.substring(0, 200)}`);
        continue;
      }
      const data = await response.json();
      const list = extractWbStatusOrdersList(data);
      if (list.length === 0 && data && typeof data === 'object' && Object.keys(data).length > 0) {
        logger.warn('[WB Orders] status: пустой список заказов, ключи ответа: ' + Object.keys(data).join(', '));
      }
      list.forEach(item => {
        const id = item.id ?? item.orderID ?? item.orderId ?? item.order_id;

        const supplierRaw = item.supplierStatus ?? item.supplier_status ?? item.supplier_status_name ?? null;
        const wbStatus = item.wbStatus ?? item.wb_status ?? null;
        const codesFromApi = Array.isArray(item.statuses) ? item.statuses.map(s => s?.code).filter(Boolean) : [];
        const codes =
          !supplierRaw && !wbStatus && codesFromApi.length === 0 && (item.status || item.state)
            ? [item.status ?? item.state]
            : codesFromApi;
        const mapped = resolveWildberriesOrderStatus(supplierRaw, wbStatus, codes);

        if (id != null) {
          const orderIdStr = String(id);
          all.push({ orderId: orderIdStr, status: mapped });
        }
      });
      if (list.length > 0 && all.length === 0) {
        logger.warn('[WB Orders] status response had items but no id/status parsed. Sample keys: ' + (list[0] ? Object.keys(list[0]).join(', ') : 'empty'));
      }
    } catch (e) {
      logger.warn('[WB Orders] status fetch error:', e.message);
    }
  }
  return all;
}

/**
 * Корзина покупателя WB: у всех сборочных заданий одного заказа совпадает orderUid (см. WB API FBS).
 * Используем как order_group_id, чтобы в UI и отчётах сливались позиции одного заказа.
 */
function wildberriesOrderGroupIdFromRaw(order) {
  const u = order?.orderUid ?? order?.order_uid;
  const s = u != null ? String(u).trim() : '';
  if (s === '') return null;

  // WB orderUid часто выглядит как хэш (или r + hex, или префикс вроде ide + hex) и на практике может
  // давать неверную склейку разных заказов. Такие uid НЕ используем как order_group_id — группируем по order_id.
  const looksLikeHashUid =
    /^[a-f0-9]{24,}$/i.test(s) ||
    /^r[a-f0-9]{24,}$/i.test(s) ||
    /^[a-z]{3}[a-f0-9]{24,}$/i.test(s);
  if (looksLikeHashUid) {
    return null;
  }
  // Длинные только-цифровые uid (snowflake-подобные) тоже давали ложную склейку разных заказов в интерфейсе WB.
  if (/^\d{15,}$/.test(s)) {
    return null;
  }

  return s;
}

/** Поля названия, если WB добавит их в ответ /orders/new */
function pickWBOrderTitleFromRawOrder(order) {
  if (!order || typeof order !== 'object') return '';
  const candidates = [
    order.name,
    order.productName,
    order.product_name,
    order.title,
    order.offerName,
    order.subjectName,
    order.nmName
  ];
  for (const v of candidates) {
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/**
 * Названия карточек по nmID через Content API (в ответе /orders/new названия нет, только nmId/article).
 */
async function fetchWBContentTitlesByNmIds(apiKey, nmIdStrings) {
  const map = new Map();
  const nums = [...new Set(
    (nmIdStrings || [])
      .map(s => Number(s))
      .filter(n => !Number.isNaN(n) && n > 0)
  )];
  if (nums.length === 0 || !apiKey) return map;

  const agent = getFetchProxyAgent();
  const url = 'https://content-api.wildberries.ru/content/v2/get/cards/list';
  const BATCH = 100;

  for (let i = 0; i < nums.length; i += BATCH) {
    const part = nums.slice(i, i + BATCH);
    const bodies = [
      {
        settings: {
          cursor: { limit: part.length },
          filter: { withPhoto: -1 }
        },
        nmIDs: part
      },
      {
        settings: {
          cursor: { limit: part.length },
          filter: { withPhoto: -1, nmIDs: part }
        }
      }
    ];
    try {
      let data = null;
      let lastErr = '';
      for (const body of bodies) {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: String(apiKey),
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(body),
          ...(agent && { agent })
        });
        if (!resp.ok) {
          lastErr = await resp.text();
          continue;
        }
        data = await resp.json();
        break;
      }
      if (!data) {
        logger.warn(`[WB Content] cards/list failed: ${lastErr.substring(0, 200)}`);
        continue;
      }
      const cards = Array.isArray(data?.cards) ? data.cards : [];
      for (const c of cards) {
        const nm = c.nmID ?? c.nmId;
        const title = c.title ?? c.imtName ?? c.object ?? '';
        const combined = title
          ? String(title).trim()
          : [c.brand, c.subject].filter(Boolean).join(' ').trim();
        if (nm != null && combined) map.set(String(nm), combined);
      }
    } catch (e) {
      logger.warn(`[WB Content] titles batch: ${e.message}`);
    }
  }
  return map;
}

async function fetchWildberriesFBSOrders(config) {
  try {
    const { api_key } = config;

    const url = 'https://marketplace-api.wildberries.ru/api/v3/orders/new';
    const agent = getFetchProxyAgent();
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: String(api_key),
        Accept: 'application/json'
      },
      ...(agent && { agent })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[WB Orders] API error:', response.status, errorText);
      return [];
    }

    const data = await response.json();
    const orders = Array.isArray(data.orders) ? data.orders : [];

    if (orders.length === 0) {
      return [];
    }

    const nmIdsForTitles = orders.map(o => (o.nmId != null ? String(o.nmId) : '')).filter(Boolean);
    const titlesByNm = await fetchWBContentTitlesByNmIds(api_key, nmIdsForTitles);

    return orders.map(order => {
      const mappedStatus = 'new';
      const nmId = order.nmId != null ? String(order.nmId) : '';
      const sellerSku = order.skus?.[0] || '';
      const sellerArticle = order.article != null ? String(order.article).trim() : '';
      const titleFromApi = pickWBOrderTitleFromRawOrder(order);
      const titleFromContent = nmId ? titlesByNm.get(nmId) : '';
      const productName =
        titleFromContent ||
        titleFromApi ||
        sellerArticle ||
        sellerSku ||
        (nmId ? nmId : '');
      // В ERM группируем WB строго по сборочному заданию: order.id.
      // Это гарантированно уникально для разных заданий и корректно объединяет несколько товаров в одном задании.
      const wbOrderIdStr = (order.id?.toString && order.id?.toString()) || order.id || order.orderUid || '';
      const wbOrderGroupId = wbOrderIdStr ? String(wbOrderIdStr).trim() : null;

      return {
        marketplace: 'wildberries',
        orderId: wbOrderIdStr,
        orderGroupId: wbOrderGroupId,
        // Для сопоставления с вашим каталогом используем:
        // - offerId: vendorCode/артикул продавца (order.article), т.к. обычно он заведён в product_skus
        // - sku (marketplace_sku): nmId (число), если заведено сопоставление по nmId
        offerId: sellerArticle || sellerSku || nmId,
        sku: nmId || '',
        productName,
        quantity: 1,
        price: order.convertedPrice || order.price || 0,
        status: mappedStatus,
        createdAt: order.createdAt || '',
        inProcessAt: order.createdAt || '',
        shipmentDate: '',
        customerName: '',
        customerPhone: '',
        deliveryAddress: (() => {
          const wid = order.warehouseId ?? order.warehouse_id ?? null;
          const officeName = Array.isArray(order.offices) ? (order.offices[0] || '') : (order.offices || '');
          const nameStr = String(officeName || '').trim();
          if (wid != null && String(wid).trim() !== '') {
            return nameStr ? `${String(wid).trim()} — ${nameStr}` : String(wid).trim();
          }
          return nameStr;
        })()
      };
    });
  } catch (error) {
    console.error('[WB Orders] Fetch error:', error.message);
    return [];
  }
}

/**
 * Получить ВСЕ assembly orders WB за период.
 * /api/v3/orders возвращает информацию без текущего статуса, поэтому статус догружаем отдельно через /api/v3/orders/status.
 * Поддерживает диапазон максимум 30 дней за запрос (chunked by 30d).
 */
async function fetchWildberriesFBSOrdersByPeriod(config, daysBack = 90) {
  const { api_key } = config;
  const urlBase = 'https://marketplace-api.wildberries.ru/api/v3/orders';
  const toDate = new Date();
  const startDate = new Date(toDate.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const chunkDays = 30;
  const allRaw = [];
  const headers = {
    Authorization: String(api_key),
    Accept: 'application/json'
  };
  const limit = 1000;

  for (
    let chunkStart = new Date(startDate);
    chunkStart <= toDate;
    chunkStart = new Date(chunkStart.getTime() + chunkDays * 24 * 60 * 60 * 1000)
  ) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + (chunkDays - 1));
    if (chunkEnd > toDate) chunkEnd.setTime(toDate.getTime());

    const dateFrom = Math.floor(chunkStart.getTime() / 1000);
    const dateTo = Math.floor(chunkEnd.getTime() / 1000);

    let next = 0;
    let safety = 0;
    let lastNext = null;

    while (true) {
      safety++;
      if (safety > 80) break; // защита от потенциальных циклов из-за багов пагинации
      if (lastNext !== null && String(next) === String(lastNext)) break;
      lastNext = next;

      const url = `${urlBase}?limit=${limit}&next=${next}&dateFrom=${dateFrom}&dateTo=${dateTo}`;
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        const errorText = await response.text();
        logger.warn(`[WB Orders] /api/v3/orders error ${response.status}: ${errorText.substring(0, 200)}`);
        break;
      }

      const data = await response.json();
      const orders = Array.isArray(data?.orders) ? data.orders : [];
      if (orders.length === 0) break;

      allRaw.push(...orders);

      if (data?.next == null) break;
      next = data.next;
    }
  }

  const mapped = allRaw.map(order => {
    const nmId = order.nmId != null ? String(order.nmId) : '';
    const sellerSku = order.skus?.[0] || '';
    const sellerArticle = order.article != null ? String(order.article).trim() : '';
    const wbOrderIdStr = (order.id?.toString && order.id?.toString()) || order.id || order.orderUid || '';
    const wbOrderGroupId = wbOrderIdStr ? String(wbOrderIdStr).trim() : null;

    return {
      marketplace: 'wildberries',
      orderId: wbOrderIdStr,
      orderGroupId: wbOrderGroupId,
      // сопоставление с product_skus: offer_id обычно хранит артикул продавца
      offerId: sellerArticle || sellerSku || nmId,
      sku: nmId || '',
      productName: sellerArticle || sellerSku || (nmId ? `Артикул ${nmId}` : ''),
      quantity: 1,
      price: order.convertedPrice || order.price || 0,
      // До ответа /orders/status — не «Новый»: иначе годовая выгрузка даёт сотни ложных «Новых».
      status: WB_STATUS_PENDING,
      createdAt: order.createdAt || order.sellerDate || '',
      inProcessAt: order.createdAt || order.sellerDate || '',
      shipmentDate: '',
      customerName: '',
      customerPhone: '',
      deliveryAddress: order.offices?.[0] || ''
    };
  });

  return mapped;
}

/**
 * Получить один заказ WB по id.
 * Используем только GET /api/v3/orders/new (без параметров) — тот же endpoint, что и в sync.
 * GET /api/v3/orders с limit/next возвращает 400 Incorrect parameter, поэтому не вызываем его.
 * Детали по WB доступны только для заказов в статусе «новый».
 */

/** Базовый числовой id заказа YM для API (без суффикса :offerId у позиции в группе) */
function yandexOrderIdForApi(orderIdRaw) {
  const s = decodeURIComponent(String(orderIdRaw || '').trim());
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(0, i) : s;
}

/** Получить заказ из локального хранилища (БД или файл) по маркетплейсу и orderId */
async function getLocalOrderByMarketplaceAndOrderId(marketplace, orderId, profileId = null) {
  const norm = String(marketplace || '').toLowerCase();
  const id = String(orderId || '').trim();
  if (!id) return null;
  if (repositoryFactory.isUsingPostgreSQL()) {
    const repo = repositoryFactory.getOrdersRepository();
    const mp = norm === 'wb' ? 'wildberries' : marketplace;
    let row = await repo.findByMarketplaceAndOrderId(mp, id, profileId);
    if (!row && (norm === 'yandex' || norm === 'ym')) {
      const base = yandexOrderIdForApi(id);
      if (base && base !== id) {
        row = await repo.findByMarketplaceAndOrderId('yandex', base, profileId);
      }
    }
    return row;
  }
  const data = await readData('orders');
  const orders = (data && data.orders) || [];
  const matchMp = (o) => {
    const m = String(o.marketplace || '').toLowerCase();
    if (norm === 'wildberries' || norm === 'wb') return m === 'wildberries' || m === 'wb';
    if (norm === 'yandex' || norm === 'ym') return m === 'yandex' || m === 'ym';
    return m === norm;
  };
  const byId = (oid) =>
    orders.find((o) => matchMp(o) && String(o.orderId || o.order_id || '') === oid) || null;
  if (norm === 'wildberries' || norm === 'wb') return byId(id);
  if (norm === 'yandex' || norm === 'ym') {
    return byId(id) || byId(yandexOrderIdForApi(id));
  }
  if (norm === 'ozon') {
    const tilde = id.indexOf('~');
    if (tilde > 0) {
      const base = id.slice(0, tilde);
      const byBase = byId(base);
      if (byBase) return byBase;
    }
    return (
      orders.find(
        (o) =>
          matchMp(o) &&
          (String(o.orderGroupId ?? o.order_group_id ?? '') === id ||
            String(o.orderId ?? o.order_id ?? '').startsWith(`${id}~`))
      ) || byId(id)
    );
  }
  return byId(id);
}

/** Карточка заказа Ozon из локальной строки (если posting/fbs/get вернул 404) */
function buildOzonDetailFromLocalOrder(order, postingNumberHint) {
  const pn =
    postingNumberHint ||
    ozonPostingNumberFromOrderId(order.orderId ?? order.order_id ?? '') ||
    String(order.orderId ?? order.order_id ?? '');
  return {
    posting_number: pn,
    status: order.status,
    substatus: null,
    products: [],
    in_process_at: order.inProcessAt ?? order.in_process_at ?? null,
    shipment_date: order.shipmentDate ?? order.shipment_date ?? null,
    customer_name: order.customerName ?? order.customer_name ?? null,
    customer_phone: order.customerPhone ?? order.customer_phone ?? null,
    delivery_method: (order.deliveryAddress || order.delivery_address)
      ? { warehouse_name: order.deliveryAddress ?? order.delivery_address }
      : null,
    _fromLocal: true
  };
}

/** Собрать объект в формате WB detail из локального заказа (для карточки при 404 от API) */
/** Карточка заказа YM из локальной строки (если GET заказа с МП вернул 404) */
function buildYandexDetailFromLocalOrder(order) {
  const oid = order.orderId ?? order.order_id ?? '';
  const baseId = yandexOrderIdForApi(oid);
  const gid = order.orderGroupId ?? order.order_group_id ?? baseId;
  return {
    id: gid ? Number(gid) || gid : null,
    orderId: gid || baseId,
    status: order.status,
    substatus: null,
    creationDate: order.createdAt ?? order.created_at ?? null,
    updatedAt: order.inProcessAt ?? order.in_process_at ?? null,
    items: [
      {
        offerId: order.offerId ?? order.offer_id ?? '',
        offerName: order.productName ?? order.product_name ?? '—',
        count: order.quantity != null ? Number(order.quantity) : 1,
        price: order.price != null ? Number(order.price) : 0
      }
    ],
    delivery: (order.deliveryAddress || order.delivery_address)
      ? { _localAddress: order.deliveryAddress ?? order.delivery_address }
      : null,
    buyer: null,
    currency: 'RUB',
    fake: false,
    _fromLocal: true
  };
}

function buildWBDetailFromLocalOrder(order, orderId) {
  const id = orderId || order.orderId || order.order_id;
  const skus = [];
  if (order.marketplaceSku != null) skus.push(String(order.marketplaceSku));
  if (order.offerId != null && !skus.includes(String(order.offerId))) skus.push(String(order.offerId));
  if (order.sku != null && !skus.includes(String(order.sku))) skus.push(String(order.sku));
  const productName = order.productName ?? order.product_name ?? null;
  const quantity = order.quantity != null ? Number(order.quantity) : null;
  const msku = order.marketplaceSku ?? order.marketplace_sku ?? order.sku ?? null;
  return {
    id,
    orderUid: id,
    article: order.offerId ?? order.productName ?? order.product_name ?? '—',
    /** nmId из БД — для сопоставления с localLines и отображения, как в ответе WB API */
    nmId: msku != null && String(msku).trim() !== '' ? msku : null,
    productName,
    quantity: Number.isNaN(quantity) ? null : quantity,
    createdAt: order.createdAt ?? order.created_at ?? null,
    price: order.price ?? 0,
    convertedPrice: order.convertedPrice ?? order.converted_price ?? null,
    deliveryType: order.deliveryType ?? order.delivery_type ?? null,
    supplyId: order.supplyId ?? order.supply_id ?? null,
    address: { fullAddress: order.deliveryAddress ?? order.delivery_address ?? null },
    offices: order.offices ? (Array.isArray(order.offices) ? order.offices : [order.offices]) : [],
    comment: order.comment ?? null,
    skus: skus.length ? skus : null
  };
}

async function fetchWBOrderById(config, orderId) {
  const { api_key } = config;
  const url = 'https://marketplace-api.wildberries.ru/api/v3/orders/new';
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: String(api_key),
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`WB API error ${response.status}: ${errorText.substring(0, 200)}`);
    err.statusCode = response.status === 401 ? 401 : 502;
    throw err;
  }
  const data = await response.json();
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  const found = orders.find(
    o => String(o.id) === String(orderId) || String(o.orderUid) === String(orderId)
  );
  if (found) return found;
  const err = new Error(
    `Заказ ${orderId} не найден в Wildberries. Детали доступны только для заказов в статусе «новый».`
  );
  err.statusCode = 404;
  throw err;
}

/** Нормализует ID кампании из объекта (id или campaignId) */
function getCampaignId(c) {
  const id = c.id ?? c.campaignId;
  return id != null ? Number(id) : NaN;
}

function getYandexCampaignBusinessId(c) {
  const bid = c?.businessId ?? c?.business?.id;
  if (bid == null || bid === '') return null;
  const n = Number(bid);
  return Number.isNaN(n) ? null : n;
}

/** Нормализация Api-Key Яндекс.Маркета (пробелы, BOM, переносы) — как в integrations.service */
function normalizeYandexApiKey(apiKey) {
  if (apiKey == null) return '';
  return String(apiKey).replace(/\s+/g, ' ').replace(/\uFEFF/g, '').trim();
}

/**
 * Один заказ: GET v2/campaigns/{campaignId}/orders/{orderId}
 * @see https://yandex.ru/dev/market/partner-api/doc/ru/reference/orders/getOrder
 */
async function fetchYandexOrderDetailRaw(config, orderIdRaw) {
  const api_key = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!api_key) {
    const err = new Error('Яндекс.Маркет API не настроен');
    err.statusCode = 400;
    throw err;
  }
  const baseId = yandexOrderIdForApi(orderIdRaw);
  if (!baseId || !/^\d+$/.test(String(baseId))) {
    const err = new Error('Некорректный номер заказа Яндекс.Маркет');
    err.statusCode = 400;
    throw err;
  }

  const agent = getYandexHttpsAgent();
  const { campaignIds } = await getYandexBusinessAndCampaigns(config);
  const fromConfig = config?.campaign_id ?? config?.campaignId;
  const idsToTry = [];
  if (fromConfig != null && String(fromConfig).trim() !== '') {
    const n = Number(fromConfig);
    if (!Number.isNaN(n) && n >= 1) idsToTry.push(n);
  }
  for (const c of campaignIds || []) {
    const n = Number(c);
    if (!Number.isNaN(n) && n >= 1) idsToTry.push(n);
  }
  const seen = new Set();
  const orderedCampaigns = [];
  for (const n of idsToTry) {
    if (seen.has(n)) continue;
    seen.add(n);
    orderedCampaigns.push(n);
  }
  if (orderedCampaigns.length === 0) {
    const err = new Error('Не удалось определить campaignId для Яндекс.Маркет. Укажите campaign_id в интеграции.');
    err.statusCode = 400;
    throw err;
  }

  let lastStatus = 404;
  for (const campaignId of orderedCampaigns) {
    const url = `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/orders/${baseId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Api-Key': api_key,
        'Content-Type': 'application/json'
      },
      ...(agent && { agent })
    });
    if (response.ok) {
      const data = await response.json();
      const order = data?.order ?? data?.result?.order ?? data;
      if (order && typeof order === 'object') {
        return order;
      }
      const err = new Error(`Пустой ответ по заказу ${baseId} в Яндекс.Маркет`);
      err.statusCode = 502;
      throw err;
    }
    lastStatus = response.status;
    if (response.status === 404) {
      continue;
    }
    const errorText = await response.text();
    const err = new Error(`YM getOrder ${response.status}: ${errorText.substring(0, 240)}`);
    err.statusCode = response.status === 401 || response.status === 403 ? response.status : 502;
    throw err;
  }
  const err = new Error(`Заказ ${baseId} не найден в Яндекс.Маркете (проверьте campaign_id и доступ к магазину)`);
  err.statusCode = lastStatus === 404 ? 404 : 502;
  throw err;
}

/**
 * Получить businessId и списки campaignIds для API v1.
 * Используется config.business_id или запрос GET v2/campaigns.
 * При сбое/пустом ответе v2/campaigns подставляются business_id и campaign_id из конфига.
 * @returns {{
 *   businessId: number | null,
 *   campaignIds: number[],
 *   orderGroups: Array<{ businessId: number, campaignIds: number[] }>
 * }}
 */
async function getYandexBusinessAndCampaigns(config) {
  const rawKey = config?.api_key ?? config?.apiKey;
  const api_key = normalizeYandexApiKey(rawKey);
  const campaign_id = config?.campaign_id ?? config?.campaignId;
  const configBusinessId = config?.business_id ?? config?.businessId;
  const out = { businessId: null, campaignIds: [], orderGroups: [] };

  const agent = getYandexHttpsAgent();
  logger.info('[YM Orders] Запрос GET v2/campaigns...');
  const response = await fetch('https://api.partner.market.yandex.ru/v2/campaigns', {
    method: 'GET',
    headers: {
      'Api-Key': api_key,
      'Content-Type': 'application/json'
    },
    ...(agent && { agent })
  });
  logger.info(`[YM Orders] GET v2/campaigns ответ: status=${response.status}`);
  if (!response.ok) {
    const errText = await response.text();
    logger.error('[YM Orders] GET v2/campaigns failed:', response.status, errText.substring(0, 300));
    if (configBusinessId != null && String(configBusinessId).trim() !== '' && campaign_id != null && String(campaign_id).trim() !== '') {
      const bid = Number(configBusinessId);
      const cid = Number(campaign_id);
      out.businessId = bid;
      out.campaignIds = [cid];
      out.orderGroups = [{ businessId: bid, campaignIds: [cid] }];
      logger.info('[YM Orders] Используем business_id и campaign_id из настроек интеграции.');
    }
    return out;
  }
  const data = await response.json();
  const campaigns = data.campaigns ?? data.result?.campaigns ?? [];
  if (campaigns.length === 0) {
    logger.info('[YM Orders] GET v2/campaigns: список кампаний пуст. Проверьте api_key и доступ в ЛК Яндекс.Маркет.');
    if (configBusinessId != null && String(configBusinessId).trim() !== '' && campaign_id != null && String(campaign_id).trim() !== '') {
      const bid = Number(configBusinessId);
      const cid = Number(campaign_id);
      out.businessId = bid;
      out.campaignIds = [cid];
      out.orderGroups = [{ businessId: bid, campaignIds: [cid] }];
      logger.info('[YM Orders] Используем business_id и campaign_id из настроек интеграции.');
    }
    return out;
  }

  let campaign = campaign_id
    ? campaigns.find(c => getCampaignId(c) === Number(campaign_id))
    : null;
  if (!campaign) {
    const availableIds = campaigns.map(getCampaignId).filter(id => !Number.isNaN(id));
    if (campaign_id) {
      logger.warn(
        `[YM Orders] campaign_id ${campaign_id} нет в ответе v2/campaigns. Доступные: ${JSON.stringify(availableIds)}. Берём первую кампанию для определения business.`
      );
    }
    campaign = campaigns[0];
  }
  if (!campaign) {
    return out;
  }

  let rawBusinessId = configBusinessId != null && String(configBusinessId).trim() !== ''
    ? configBusinessId
    : (campaign.businessId ?? campaign.business?.id ?? data.businessId ?? data.business?.id);

  if (rawBusinessId == null || rawBusinessId === '') {
    const cid = getCampaignId(campaign);
    if (!Number.isNaN(cid) && api_key) {
      try {
        const singleRes = await fetch(`https://api.partner.market.yandex.ru/v2/campaigns/${cid}`, {
          method: 'GET',
          headers: { 'Api-Key': api_key, 'Content-Type': 'application/json' },
          ...(agent && { agent })
        });
        if (singleRes.ok) {
          const singleData = await singleRes.json();
          const camp = singleData.campaign ?? singleData.result ?? singleData;
          rawBusinessId = camp.businessId ?? camp.business?.id ?? singleData.businessId ?? singleData.business?.id;
        }
      } catch (e) {
        // ignore
      }
    }
  }

  const businessId = rawBusinessId != null ? Number(rawBusinessId) : null;
  if (businessId == null || Number.isNaN(businessId) || businessId < 1) {
    logger.info('[YM Orders] businessId не найден. Укажите Business ID в настройках интеграции Яндекс (Интеграции → Яндекс.Маркет → поле «Business ID»). Узнать: Настройки → API и модули в ЛК продавца Маркета.');
    return out;
  }

  out.businessId = businessId;

  // У одного Api-Key может быть несколько businessId (разные договоры/кабинеты). Заказы запрашиваются
  // POST .../v1/businesses/{businessId}/orders — кампании с «чужим» businessId нельзя отбрасывать.
  const bucketByBusiness = new Map();
  const addCamp = (bid, cid) => {
    if (bid == null || Number.isNaN(Number(bid)) || Number(bid) < 1) return;
    if (cid == null || Number.isNaN(Number(cid)) || Number(cid) < 1) return;
    const b = Number(bid);
    const c = Number(cid);
    if (!bucketByBusiness.has(b)) bucketByBusiness.set(b, new Set());
    bucketByBusiness.get(b).add(c);
  };

  for (const c of campaigns) {
    const cid = getCampaignId(c);
    const cb = getYandexCampaignBusinessId(c);
    const bidForRow = cb != null && !Number.isNaN(cb) && cb >= 1 ? cb : businessId;
    addCamp(bidForRow, cid);
  }
  if (campaign_id != null && String(campaign_id).trim() !== '') {
    const cfg = Number(campaign_id);
    if (!Number.isNaN(cfg) && cfg >= 1) addCamp(businessId, cfg);
  }

  if (bucketByBusiness.size === 0) {
    for (const c of campaigns) {
      const cid = getCampaignId(c);
      addCamp(businessId, cid);
    }
  }

  out.orderGroups = [...bucketByBusiness.entries()].map(([bid, set]) => ({
    businessId: bid,
    campaignIds: [...set]
  }));

  const flat = new Set();
  for (const g of out.orderGroups) for (const id of g.campaignIds) flat.add(id);
  out.campaignIds = [...flat];

  logger.info(
    `[YM Orders] Групп заказов YM: ${out.orderGroups.length} — ${out.orderGroups.map(g => `business ${g.businessId}: ${g.campaignIds.length} камп.`).join('; ')}`
  );

  return out;
}

/** Даты в фильтре POST .../orders — по календарным суткам Europe/Moscow (как в ЛК), иначе возможны «дыры» и пропуски заказов. */
function formatYandexOrderFilterDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/** YYYY-MM-DD ± n календарных дней (григориан). */
function yandexYmdAddDays(ymd, n) {
  const [y, m, day] = String(ymd).split('-').map(Number);
  const u = Date.UTC(y, m - 1, day);
  const u2 = u + Number(n) * 86400000;
  const x = new Date(u2);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

function yandexYmdCompare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Сырые объекты заказов YM для одного businessId (POST v1/businesses/{id}/orders).
 * Чанки только по календарю YYYY-MM-DD (без смешивания setDate и +30 суток в мс — иначе между окнами возможны пропуски дат).
 */
async function fetchYandexOrdersRawForBusinessGroup(api_key, businessId, campaignIds, logLabel = '') {
  const toDate = new Date();
  const DAYS_BACK = 365;
  const chunkDays = 30;
  const endYmd = formatYandexOrderFilterDate(toDate);
  const startYmd = yandexYmdAddDays(endYmd, -DAYS_BACK);

  const CAMPAIGN_BATCH = 50;
  const campaignBatches = [];
  for (let i = 0; i < campaignIds.length; i += CAMPAIGN_BATCH) {
    campaignBatches.push(campaignIds.slice(i, i + CAMPAIGN_BATCH));
  }

  logger.info(
    `[YM Orders] ${logLabel}businessId=${businessId} кампаний=${campaignIds.length} (батчи по ${CAMPAIGN_BATCH}), ~${DAYS_BACK} д., даты фильтра по МСК, окно ${startYmd}..${endYmd}`
  );

  const allOrders = [];
  const ymAgent = getYandexHttpsAgent();

  let fromYmd = startYmd;
  while (yandexYmdCompare(fromYmd, endYmd) <= 0) {
    const chunkEndCandidate = yandexYmdAddDays(fromYmd, chunkDays - 1);
    const lastInChunk = yandexYmdCompare(chunkEndCandidate, endYmd) > 0 ? endYmd : chunkEndCandidate;
    const creationDateFrom = fromYmd;
    // API: creationDateTo не включается; последний включаемый день — lastInChunk → передаём следующий день.
    const creationDateTo = yandexYmdAddDays(lastInChunk, 1);

    for (let bi = 0; bi < campaignBatches.length; bi += 1) {
      const campaignIdsPart = campaignBatches[bi];

      logger.info(
        `[YM Orders] business ${businessId}: МСК ${creationDateFrom}..${lastInChunk} вкл. (API creationDateTo=${creationDateTo} exclusive), камп. batch ${bi + 1}/${campaignBatches.length} (${campaignIdsPart.length} id)`
      );

      let pageToken = null;
      do {
        const query = new URLSearchParams();
        query.set('limit', '50');
        if (pageToken) query.set('pageToken', pageToken);

        const url = `https://api.partner.market.yandex.ru/v1/businesses/${businessId}/orders?${query.toString()}`;
        const body = {
          campaignIds: campaignIdsPart,
          dates: {
            creationDateFrom,
            creationDateTo
          },
          fake: false
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Api-Key': api_key,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          ...(ymAgent && { agent: ymAgent })
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error('[YM Orders] API error:', response.status, errorText.substring(0, 400), `businessId=${businessId}`);
          throw new Error(`YM orders HTTP ${response.status} for business ${businessId}`);
        }

        const data = await response.json();
        const paging = data.paging ?? data.result?.paging;
        const orders = data.orders ?? data.result?.orders ?? [];
        allOrders.push(...orders);

        pageToken = paging?.nextPageToken ?? null;
      } while (pageToken);
    }

    fromYmd = yandexYmdAddDays(lastInChunk, 1);
  }

  return allOrders;
}

/**
 * Заказы Яндекс.Маркета через API v1: POST v1/businesses/{businessId}/orders.
 * Требуется businessId (кабинет); при отсутствии в конфиге запрашивается GET v2/campaigns.
 * Несколько businessId (разные кабинеты под одним ключом) обрабатываются отдельными запросами.
 */
async function fetchYandexFBSOrders(config) {
  try {
    logger.info('[YM Orders] fetch started');
    const api_key = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);

    if (!api_key) {
      logger.info('[YM Orders] No API key configured');
      return { orders: [], reason: 'No API key' };
    }

    const { businessId, campaignIds, orderGroups } = await getYandexBusinessAndCampaigns(config);
    const groups =
      Array.isArray(orderGroups) && orderGroups.length > 0
        ? orderGroups.filter(g => g && g.businessId >= 1 && Array.isArray(g.campaignIds) && g.campaignIds.length > 0)
        : businessId != null && businessId >= 1 && campaignIds.length > 0
          ? [{ businessId, campaignIds }]
          : [];

    if (groups.length === 0) {
      logger.info('[YM Orders] Нет пар businessId+campaignIds. Проверьте api_key, business_id и campaign_id в интеграции Яндекс.');
      return { orders: [], reason: 'businessId/campaigns not found' };
    }

    const allOrders = [];
    for (let gi = 0; gi < groups.length; gi += 1) {
      const g = groups[gi];
      const prefix = groups.length > 1 ? `группа ${gi + 1}/${groups.length} ` : '';
      try {
        const batch = await fetchYandexOrdersRawForBusinessGroup(api_key, g.businessId, g.campaignIds, prefix);
        allOrders.push(...batch);
      } catch (e) {
        logger.warn(`[YM Orders] ${prefix}не загружена: ${e.message}`);
      }
    }

    const uniqueByOrderId = new Map();
    for (const o of allOrders) {
      const oid = yandexBusinessOrderRawId(o);
      if (oid == null) continue;
      uniqueByOrderId.set(String(oid), o);
    }
    const dedupedRaw = [...uniqueByOrderId.values()];
    logger.info(`[YM Orders] API raw строк: ${allOrders.length}, уникальных заказов по orderId: ${dedupedRaw.length}`);

    // Диагностика multi-item заказов (помогает понять, где лежат позиции)
    try {
      const wanted = ['55682943297', '55668638915', '55622675010', '55637889728', '55643376067', '55644537664', '55672283648'];
      for (const w of wanted) {
        const dbg = dedupedRaw.find(o => yandexBusinessOrderRawId(o) === w);
        if (!dbg) {
          logger.warn(
            `[YM Orders][DBG] orderId=${w} нет в ответе API после объединения групп (кампания/business или срок создания заказа)`
          );
          continue;
        }
        const items = Array.isArray(dbg.items) ? dbg.items : [];
        const offers = items.slice(0, 6).map(it => it?.offerId).filter(Boolean);
        logger.info(`[YM Orders][DBG] orderId=${w} status=${dbg.status} items=${items.length} offerIds=${offers.join(', ') || '(none)'}`);
      }
    } catch (_) {
      // ignore
    }

    const mapped = dedupedRaw.flatMap(order => mapYandexBusinessOrderToInternal(order));
    if (mapped.length > 0) {
      logger.info(`[YM Orders] Загружено заказов: ${mapped.length}`);
    }
    const reason = mapped.length === 0 ? 'API returned 0 orders (last ~365 days, chunked by 30d)' : undefined;
    return { orders: mapped, reason };
  } catch (error) {
    logger.error('[YM Orders] Fetch error:', error.message);
    const reason = error.message && /request to .* failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network/i.test(error.message)
      ? `Сеть: ${error.message}. Проверьте доступность api.partner.market.yandex.ru с сервера (firewall, VPN). При работе через прокси задайте HTTPS_PROXY.`
      : `Error: ${error.message}`;
    return { orders: [], reason };
  }
}

/** Идентификатор заказа в ответе v1/businesses/.../orders (поле обычно orderId, реже id). */
function yandexBusinessOrderRawId(o) {
  if (o == null || typeof o !== 'object') return null;
  const v = o.orderId ?? o.id ?? o.order_id ?? o.orderID;
  if (v == null || v === '') return null;
  return String(v);
}

/**
 * Цена строки заказа YM (руб.). У позиции часто пустой `item.prices.payment`;
 * тогда смотрим buyerPrice, price, массив prices[] (BUYER/costPerItem), иначе долю от `order.prices.payment`.
 */
function yandexExtractLinePriceRub(item, order, rawItemsList) {
  const qty = item != null && item.count != null ? Number(item.count) : 1;
  const qtySafe = Number.isFinite(qty) && qty > 0 ? qty : 1;

  const pos = (x) => {
    const v = Number(x);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  let p = pos(item?.prices?.payment?.value);
  if (p != null) return p;

  p = pos(item?.buyerPrice);
  if (p != null) return p;

  p = pos(item?.price);
  if (p != null) return p;

  const ip = item?.prices;
  if (ip && typeof ip === 'object' && !Array.isArray(ip)) {
    p = pos(ip.subsidy?.value) || pos(ip.cashback?.value);
    if (p != null) return p;
  }

  if (Array.isArray(ip)) {
    for (const block of ip) {
      if (!block || typeof block !== 'object') continue;
      const t = pos(block.total);
      if (t != null) return t;
      const cpi = pos(block.costPerItem);
      if (cpi != null) return cpi * qtySafe;
    }
  }

  const orderPay = pos(order?.prices?.payment?.value);
  if (orderPay != null) {
    const list = Array.isArray(rawItemsList) && rawItemsList.length ? rawItemsList : [item];
    let sumQty = 0;
    for (const it of list) {
      const c = it != null && it.count != null ? Number(it.count) : 1;
      sumQty += Number.isFinite(c) && c > 0 ? c : 1;
    }
    if (sumQty <= 0) sumQty = 1;
    return (orderPay * qtySafe) / sumQty;
  }

  return 0;
}

/** Маппинг заказа из формата BusinessOrderDTO (v1) в внутренний формат.
 * YM может возвращать несколько items в одном заказе — разворачиваем в несколько строк
 * с одинаковым orderGroupId (order.orderId), чтобы UI показывал все товары.
 */
function mapYandexBusinessOrderToInternal(order) {
  const rawOrderId = yandexBusinessOrderRawId(order) || '';
  const items = Array.isArray(order.items) ? order.items : [];
  // Для сопоставления складов: используем campaignId как идентификатор "склада" YM (обычно один склад на кампанию).
  const campaignIdRaw = order.campaignId ?? order.campaign_id ?? order.shopId ?? order.shop_id ?? null;
  const ymWarehouseKey = campaignIdRaw != null && String(campaignIdRaw).trim() !== '' ? String(campaignIdRaw).trim() : '';
  const address = order.delivery?.courier?.address ?? order.delivery?.pickup?.address;
  const deliveryAddressHuman = address
    ? [address.postcode, address.city, address.street, address.house].filter(Boolean).join(', ')
    : (address?.postcode || '');

  if (!rawOrderId) return [];

  // Если items пустой (редко, но бывает на некоторых статусах) — сохраняем хотя бы одну строку,
  // чтобы заказ не пропадал из списка.
  const safeItems = items.length ? items : [null];

  return safeItems.map((item, idx) => {
    const offerId = item?.offerId ?? '';
    const itemIdPart = offerId ? String(offerId) : String(idx + 1);
    // Важно: для UI/карточки используем "чистый" orderId у первой позиции, даже если items пустой.
    const internalOrderId = idx === 0 ? rawOrderId : `${rawOrderId}:${itemIdPart}`;
    const priceValue = yandexExtractLinePriceRub(item, order, items.length ? items : [item]);
    const count = item?.count ?? null;
    const quantity = count != null ? count : 1;

    return {
      marketplace: 'yandex',
      orderId: internalOrderId,
      orderGroupId: rawOrderId,
      offerId,
      sku: offerId,
      productName: item?.offerName ?? '',
      quantity,
      price: Number(priceValue) || 0,
      status: mapYMOrderStatus(order.status, order.substatus),
      createdAt: order.creationDate || '',
      inProcessAt: order.updateDate || order.creationDate || '',
      shipmentDate: order.delivery?.shipment?.shipmentDate || '',
      customerName: '',
      customerPhone: '',
      // Для резервирования важнее "ключ склада", чем адрес покупателя.
      // Если есть campaignId — пишем его, чтобы warehouse_mappings мог сопоставить YM→фактический склад.
      deliveryAddress: ymWarehouseKey || deliveryAddressHuman
    };
  });
}

// status mappers
function mapOzonOrderStatus(status) {
  if (!status || typeof status !== 'string') {
    return 'new';
  }
  const normalizedStatus = status.toLowerCase().trim();
  const statusMap = {
    awaiting_packaging: 'new',
    awaiting_registration: 'new',
    awaiting_approve: 'new',
    awaiting_validate: 'new',
    acceptance_in_progress: 'in_assembly',
    // у Ozon «ожидает отгрузки» ≠ «собран в ERM»; «Собран» только после markCollected
    awaiting_deliver: 'in_assembly',
    awaiting_delivery: 'in_assembly',
    sent_by_seller: 'in_transit',
    driver_pickup: 'in_transit',
    delivering: 'in_transit',
    at_last_mile: 'in_transit',
    driving_to_pickup_point: 'in_transit',
    arrived_to_pickup_point: 'in_transit',
    cancel: 'cancelled',
    cancelled: 'cancelled',
    delivered: 'delivered',
    delivery: 'in_transit'
  };
  const mapped = statusMap[normalizedStatus];
  if (mapped) return mapped;
  if (normalizedStatus === 'unknown') return 'new';
  return normalizedStatus;
}

/**
 * Статус YM из BusinessOrderDTO. У status=PROCESSING смысл задаёт substatus:
 * STARTED — «можно начать обрабатывать» (в ЛК часто «Новый»), PACKAGING — сборка, READY_TO_SHIP — собран.
 * @see https://yandex.ru/dev/market/partner-api/doc/ru/reference/orders/getBusinessOrders
 */
function mapYMOrderStatus(status, substatus) {
  const raw = status;
  if (raw == null) return 'new';
  const normalized = String(raw).trim().toUpperCase();
  const sub = substatus == null || substatus === '' ? '' : String(substatus).trim().toUpperCase();

  if (normalized === 'PROCESSING') {
    if (sub === 'STARTED') return 'new';
    if (sub === 'READY_TO_SHIP') return 'in_assembly';
    if (sub === 'PACKAGING') return 'in_assembly';
    const processingAsNew = new Set([
      'AWAIT_CONFIRMATION',
      'AWAIT_DELIVERY_DATES_CONFIRMATION',
      'WAITING_FOR_STOCKS',
      'PREORDER',
      'ASYNC_PROCESSING',
      'AWAIT_PAYMENT'
    ]);
    if (processingAsNew.has(sub)) return 'new';
    if (!sub) return 'new';
    return 'in_assembly';
  }

  const statusMap = {
    PLACING: 'new',
    RESERVED: 'new',
    UNPAID: 'new',
    PENDING: 'new',
    DELIVERY: 'in_transit',
    PICKUP: 'in_transit',
    SHIPMENT: 'in_transit',
    PENDING_DELIVERY: 'in_assembly',
    PENDING_SHIPMENT: 'in_assembly',
    CANCELLED: 'cancelled',
    DELIVERED: 'delivered',
    PARTIALLY_RETURNED: 'cancelled',
    RETURNED: 'cancelled',
    UNKNOWN: 'new'
  };
  const mapped = statusMap[normalized];
  if (mapped) return mapped;
  const low = String(raw).trim().toLowerCase();
  if (low === 'unknown') return 'new';
  return raw || 'new';
}

const ordersSyncService = new OrdersSyncService();

export default ordersSyncService;

export { getYandexBusinessAndCampaigns, normalizeYandexApiKey };


