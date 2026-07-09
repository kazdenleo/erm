/**
 * Orders Controller
 * HTTP контроллер для заказов (минимально: только чтение)
 */

import fs from 'fs';
import ordersService, { orderEligibleForProcurement } from '../services/orders.service.js';
import ordersSyncService from '../services/orders.sync.service.js';
import {
  setOrdersFbsBackgroundSyncPaused,
  isOrdersFbsBackgroundSyncPaused
} from '../services/orders-fbs-sync-pause.js';
import ordersLabelsService from '../services/orders.labels.service.js';
import shipmentsService from '../services/shipments.service.js';
import productsService from '../services/products.service.js';
import repositoryFactory from '../config/repository-factory.js';
import { readData } from '../utils/storage.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import logger from '../utils/logger.js';
import orderSupplierOrderService from '../services/orderSupplierOrder.service.js';
import { processAssemblyShipmentsInBackground } from '../services/orderAssemblyBackground.service.js';

const profilesRepo = repositoryFactory.getProfilesRepository();
const warehousesRepo = repositoryFactory.getWarehousesRepository();

async function validateManualOrderWarehouseId(profileId, warehouseId) {
  const wid = warehouseId != null && warehouseId !== '' ? Number(warehouseId) : NaN;
  if (!Number.isFinite(wid) || wid < 1) {
    return 'Укажите склад списания для ручного заказа.';
  }
  const wh = await warehousesRepo?.findById?.(wid);
  if (!wh || String(wh.type || '').toLowerCase() !== 'warehouse') {
    return 'Склад не найден.';
  }
  const whProfile = wh.profile_id ?? wh.profileId ?? null;
  if (profileId != null && whProfile != null && Number(whProfile) !== Number(profileId)) {
    return 'Склад не принадлежит вашему аккаунту.';
  }
  return null;
}

/** Без limit — не отдаём весь список (риск 504 на VPS при большом каталоге заказов). */
const ORDER_LIST_DEFAULT_LIMIT = 200;
const ORDER_LIST_MAX_LIMIT = 500;

class OrdersController {
  async getAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: [] });
      }
      const marketplace = req.query?.marketplace ? String(req.query.marketplace).trim() : null;
      const status = req.query?.status ? String(req.query.status).trim() : null;
      const search = req.query?.search ? String(req.query.search).trim() : null;
      const limitRaw = req.query?.limit;
      const offsetRaw = req.query?.offset;
      let limit = limitRaw != null ? Number(limitRaw) : null;
      const offset = offsetRaw != null ? Number(offsetRaw) : 0;
      let hasPaging = Number.isFinite(limit) && limit > 0;
      if (!hasPaging) {
        limit = ORDER_LIST_DEFAULT_LIMIT;
        hasPaging = true;
      }
      if (limit > ORDER_LIST_MAX_LIMIT) limit = ORDER_LIST_MAX_LIMIT;
      let excludeManual = false;
      if (tid != null) {
        const prof = await profilesRepo.findById(tid);
        excludeManual = !prof || prof.allow_private_orders !== true;
      }
      const options = {
        ...(tid != null ? { profileId: tid } : {}),
        ...(excludeManual ? { excludeManual: true } : {}),
        ...(marketplace ? { marketplace } : {}),
        ...(status ? { status } : {}),
        ...(search ? { search } : {}),
        limit,
        ...(Number.isFinite(offset) && offset > 0 ? { offset } : {}),
      };
      const fullReserveEnrich = req.query?.enrichReserve === 'full';
      const listOptions = {
        ...options,
        ...(hasPaging ? { lightReserveEnrich: !fullReserveEnrich } : {}),
        ...(req.query?.skipAutoReserve === '1' ||
        req.query?.skipAutoReserve === 'true' ||
        req.query?.skip_auto_reserve === '1'
          ? { skipAutoReserve: true }
          : {}),
      };
      const result = hasPaging
        ? await ordersService.getPage(listOptions)
        : { items: await ordersService.getAll(listOptions), total: null };
      const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
      const organizationId =
        orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;
      const shipmentIndex = await shipmentsService.getOrderShipmentIndex({
        profileId: tid,
        organizationId,
        onlyOrders: result.items,
      });
      const itemsWithLabel = (result.items || []).map((o) => {
        const mpDb = o.marketplace === 'wb' ? 'wildberries' : o.marketplace;
        const ship = shipmentIndex.get(`${mpDb}|${String(o.orderId ?? '')}`);
        return {
          ...o,
          hasLabel: ordersLabelsService.hasLabelCached(o),
          ...(ship
            ? {
                localShipmentId: ship.shipmentId,
                localShipmentName: ship.shipmentName,
                localShipmentClosed: ship.shipmentClosed,
              }
            : {}),
        };
      });
      // Не кэшируем: список заказов часто меняется после синхронизации.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        ok: true,
        data: itemsWithLabel,
        ...(hasPaging ? { meta: { total: result.total, limit, offset: Number.isFinite(offset) && offset > 0 ? offset : 0 } } : {}),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Счётчики по статусам (для кнопок фильтра) без пагинации.
   * GET /orders/status-counts?marketplace=...&search=...
   */
  async getStatusCounts(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: { all: 0 } });
      }

      const marketplace = req.query?.marketplace ? String(req.query.marketplace).trim() : null;
      const search = req.query?.search ? String(req.query.search).trim() : null;

      let excludeManual = false;
      if (tid != null) {
        const prof = await profilesRepo.findById(tid);
        excludeManual = !prof || prof.allow_private_orders !== true;
      }

      const options = {
        ...(tid != null ? { profileId: tid } : {}),
        ...(excludeManual ? { excludeManual: true } : {}),
        ...(marketplace ? { marketplace } : {}),
        ...(search ? { search } : {}),
      };

      const data = await ordersService.getStatusCounts(options);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Лёгкий счётчик «Новых» заказов для глобального звукового оповещения.
   * GET /orders/new-count
   */
  async getNewCount(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: { new: 0 } });
      }

      let excludeManual = false;
      if (tid != null) {
        const prof = await profilesRepo.findById(tid);
        excludeManual = !prof || prof.allow_private_orders !== true;
      }

      const options = {
        ...(tid != null ? { profileId: tid } : {}),
        ...(excludeManual ? { excludeManual: true } : {}),
      };

      const count = await ordersService.getNewCount(options);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: { new: count } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Ручное добавление заказа: один товар или несколько.
   * Body: { customerName, customerPhone, productId, quantity, price } — одна позиция;
   *   или { customerName, customerPhone, items: [{ productId, quantity, price }, ...] } — несколько позиций.
   * price — за единицу товара (неотрицательное число). ФИО и телефон обязательны.
   */
  async createManual(req, res, next) {
    try {
      const pid = req.user?.profileId;
      if (pid == null || pid === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
      }
      const prof = await profilesRepo.findById(pid);
      if (!prof || prof.allow_private_orders !== true) {
        return res.status(403).json({
          ok: false,
          message: 'Частные заказы отключены в общих настройках аккаунта.',
        });
      }
      const customerName = String(req.body?.customerName ?? req.body?.customer_name ?? '').trim();
      const customerPhone = String(req.body?.customerPhone ?? req.body?.customer_phone ?? '').trim();
      if (!customerName) {
        return res.status(400).json({ ok: false, message: 'Укажите ФИО покупателя.' });
      }
      if (!customerPhone) {
        return res.status(400).json({ ok: false, message: 'Укажите телефон покупателя.' });
      }
      const rawWarehouseId = req.body?.warehouseId ?? req.body?.warehouse_id ?? null;
      let resolvedWarehouseId = rawWarehouseId;
      if (resolvedWarehouseId == null || resolvedWarehouseId === '') {
        const profWh = prof?.manual_orders_warehouse_id ?? prof?.manualOrdersWarehouseId ?? null;
        if (profWh != null && profWh !== '') resolvedWarehouseId = profWh;
      }
      const warehouseError = await validateManualOrderWarehouseId(pid, resolvedWarehouseId);
      if (warehouseError) {
        return res.status(400).json({ ok: false, message: warehouseError });
      }
      const warehouseId = Number(resolvedWarehouseId);
      const items = req.body?.items;
      if (Array.isArray(items) && items.length > 0) {
        const parsedItems = [];
        for (const it of items) {
          const productId = it?.productId != null ? Number(it.productId) : null;
          if (!productId || !Number.isInteger(productId) || productId < 1) continue;
          const quantity = Math.max(1, parseInt(it?.quantity, 10) || 1);
          const rawPrice = it?.price;
          const unitPrice = rawPrice != null && rawPrice !== '' ? Number(rawPrice) : NaN;
          if (!Number.isFinite(unitPrice) || unitPrice < 0) {
            return res.status(400).json({
              ok: false,
              message: 'Укажите цену за единицу для каждой позиции (неотрицательное число).',
            });
          }
          parsedItems.push({ productId, quantity, price: unitPrice });
        }
        if (parsedItems.length === 0) {
          return res.status(400).json({
            ok: false,
            message: 'Укажите хотя бы одну позицию: товар, количество и цену за единицу.',
          });
        }
        const { orderGroupId, orders } = await ordersService.createManualWithItems(parsedItems, {
          profileId: pid,
          customerName,
          customerPhone,
          warehouseId,
        });
        return res.status(201).json({ ok: true, data: { orderGroupId, orders } });
      }
      const productId = req.body?.productId != null ? Number(req.body.productId) : null;
      const quantity = req.body?.quantity != null ? Number(req.body.quantity) : 1;
      if (!productId || !Number.isInteger(productId) || productId < 1) {
        return res.status(400).json({ ok: false, message: 'Укажите товар (productId).' });
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ ok: false, message: 'Количество должно быть не менее 1.' });
      }
      const rawUnitPrice = req.body?.price;
      const unitPrice = rawUnitPrice != null && rawUnitPrice !== '' ? Number(rawUnitPrice) : NaN;
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return res.status(400).json({ ok: false, message: 'Укажите цену за единицу товара (неотрицательное число).' });
      }
      const product = await productsService.getById(productId);
      if (!product) {
        return res.status(404).json({ ok: false, message: 'Товар не найден.' });
      }
      const productIdNum = product.id != null ? Number(product.id) : NaN;
      if (!Number.isInteger(productIdNum) || productIdNum < 1) {
        return res.status(400).json({ ok: false, message: 'Некорректный ID товара (ожидается число).' });
      }
      const orderId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const orderData = {
        profile_id: req.user?.profileId ?? null,
        marketplace: 'manual',
        order_id: orderId,
        product_id: productIdNum,
        product_name: product.name ?? product.product_name ?? null,
        offer_id: null,
        marketplace_sku: null,
        quantity,
        price: unitPrice,
        status: 'new',
        customer_name: customerName,
        customer_phone: customerPhone,
        warehouse_id: warehouseId,
      };
      const created = await ordersService.create(orderData);
      return res.status(201).json({ ok: true, data: created });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 501 || error.statusCode === 400) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  /**
   * PATCH /orders/manual/:orderGroupId
   * Body: { customerName, customerPhone, warehouseId, items: [{ id?, productId, quantity, price }, ...] }
   */
  async updateManual(req, res, next) {
    try {
      const pid = req.user?.profileId;
      if (pid == null || pid === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
      }
      const prof = await profilesRepo.findById(pid);
      if (!prof || prof.allow_private_orders !== true) {
        return res.status(403).json({
          ok: false,
          message: 'Частные заказы отключены в общих настройках аккаунта.',
        });
      }
      const orderGroupId = String(req.params?.orderGroupId ?? '').trim();
      if (!orderGroupId) {
        return res.status(400).json({ ok: false, message: 'Не указан идентификатор заказа.' });
      }
      const customerName = String(req.body?.customerName ?? req.body?.customer_name ?? '').trim();
      const customerPhone = String(req.body?.customerPhone ?? req.body?.customer_phone ?? '').trim();
      if (!customerName) {
        return res.status(400).json({ ok: false, message: 'Укажите ФИО покупателя.' });
      }
      if (!customerPhone) {
        return res.status(400).json({ ok: false, message: 'Укажите телефон покупателя.' });
      }
      const rawWarehouseId = req.body?.warehouseId ?? req.body?.warehouse_id ?? null;
      let resolvedWarehouseId = rawWarehouseId;
      if (resolvedWarehouseId == null || resolvedWarehouseId === '') {
        const profWh = prof?.manual_orders_warehouse_id ?? prof?.manualOrdersWarehouseId ?? null;
        if (profWh != null && profWh !== '') resolvedWarehouseId = profWh;
      }
      const warehouseError = await validateManualOrderWarehouseId(pid, resolvedWarehouseId);
      if (warehouseError) {
        return res.status(400).json({ ok: false, message: warehouseError });
      }
      const warehouseId = Number(resolvedWarehouseId);
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
          ok: false,
          message: 'Укажите хотя бы одну позицию: товар, количество и цену за единицу.',
        });
      }
      const parsedItems = [];
      for (const it of items) {
        const productId = it?.productId != null ? Number(it.productId) : null;
        if (!productId || !Number.isInteger(productId) || productId < 1) continue;
        const quantity = Math.max(1, parseInt(it?.quantity, 10) || 1);
        const rawPrice = it?.price;
        const unitPrice = rawPrice != null && rawPrice !== '' ? Number(rawPrice) : NaN;
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
          return res.status(400).json({
            ok: false,
            message: 'Укажите цену за единицу для каждой позиции (неотрицательное число).',
          });
        }
        const line = { productId, quantity, price: unitPrice };
        if (it?.id != null && it.id !== '') {
          const lineId = Number(it.id);
          if (Number.isInteger(lineId) && lineId > 0) line.id = lineId;
        }
        parsedItems.push(line);
      }
      if (parsedItems.length === 0) {
        return res.status(400).json({
          ok: false,
          message: 'Укажите хотя бы одну позицию: товар, количество и цену за единицу.',
        });
      }
      const { orderGroupId: gid, orders } = await ordersService.updateManualWithItems(
        orderGroupId,
        parsedItems,
        {
          profileId: pid,
          customerName,
          customerPhone,
          warehouseId,
        }
      );
      return res.status(200).json({ ok: true, data: { orderGroupId: gid, orders } });
    } catch (error) {
      if (
        error.statusCode === 404 ||
        error.statusCode === 501 ||
        error.statusCode === 400
      ) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  /** Пауза только фонового опроса МП; ручная кнопка «Обновить статусы» вызывает syncFbs без scheduler. */
  async getOrdersFbsSyncPause(req, res, next) {
    try {
      return res.status(200).json({
        ok: true,
        data: { paused: isOrdersFbsBackgroundSyncPaused() }
      });
    } catch (error) {
      next(error);
    }
  }

  async setOrdersFbsSyncPause(req, res, next) {
    try {
      if (typeof req.body?.paused !== 'boolean') {
        return res.status(400).json({
          ok: false,
          message: 'Ожидается JSON: { "paused": true } или { "paused": false }'
        });
      }
      setOrdersFbsBackgroundSyncPaused(req.body.paused);
      return res.status(200).json({
        ok: true,
        data: { paused: isOrdersFbsBackgroundSyncPaused() }
      });
    } catch (error) {
      next(error);
    }
  }

  async syncFbs(req, res, next) {
    try {
      const force =
        req.query?.force === '1' ||
        req.query?.force === 'true' ||
        req.body?.force === true ||
        req.body?.force === 'true';
      const refreshStatuses =
        req.query?.refreshStatuses === '1' ||
        req.query?.refreshStatuses === 'true' ||
        req.body?.refreshStatuses === true ||
        req.body?.refreshStatuses === 'true';
      const effectiveForce = force || refreshStatuses;
      const daysBackRaw = req.body?.daysBack ?? req.query?.daysBack ?? null;
      const daysBackParsed =
        daysBackRaw != null && String(daysBackRaw).trim() !== '' ? Number(daysBackRaw) : null;
      const daysBack =
        daysBackParsed != null && Number.isFinite(daysBackParsed) && [7, 14, 28, 90].includes(daysBackParsed)
          ? daysBackParsed
          : null;
      const profileId = req.user?.profileId ?? null;
      const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
      const organizationId =
        orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;

      // 1) Быстрый ответ из кэша (минутный лимит) — чтобы UI не зависал.
      const status = ordersSyncService.getSyncFbsStatus();
      const oneMinute = 60 * 1000;
      if (!effectiveForce && status.lastSyncTime && Date.now() - status.lastSyncTime < oneMinute && status.lastSyncResult) {
        const timeLeft = Math.ceil((oneMinute - (Date.now() - status.lastSyncTime)) / 1000);
        return res.status(200).json({
          ok: true,
          force: force || undefined,
          cached: true,
          rateLimited: true,
          retryAfterSeconds: timeLeft,
          data: status.lastSyncResult
        });
      }

      // 2) Если синк уже идёт — сообщаем (клиент подождёт и обновит список).
      if (status.inProgress) {
        return res.status(202).json({
          ok: true,
          started: false,
          inProgress: true,
          force: force || undefined,
          message: 'Синхронизация заказов уже выполняется',
          status
        });
      }

      // 3) Запускаем синк в фоне (без удержания HTTP‑запроса → нет 504 от nginx).
      const start = ordersSyncService.startSyncFbsInBackground({
        force: effectiveForce,
        refreshStatuses,
        daysBack,
        profileId,
        organizationId
      });
      return res.status(202).json({
        ok: true,
        started: start.started,
        inProgress: true,
        force: effectiveForce || undefined,
        refreshStatuses: refreshStatuses || undefined,
        daysBack: daysBack ?? undefined,
        message: start.started ? 'Синхронизация запущена' : 'Синхронизация уже выполняется',
        status: ordersSyncService.getSyncFbsStatus()
      });
    } catch (error) {
      next(error);
    }
  }

  async getSyncFbsStatus(req, res, next) {
    try {
      return res.status(200).json({ ok: true, data: ordersSyncService.getSyncFbsStatus() });
    } catch (error) {
      next(error);
    }
  }

  /** Сброс зависшей блокировки синхронизации (если импорт «висит» минутами). */
  async resetSyncFbs(req, res, next) {
    try {
      const data = ordersSyncService.clearSyncFbsLock();
      return res.status(200).json({ ok: true, data, message: 'Блокировка синхронизации снята' });
    } catch (error) {
      next(error);
    }
  }

  async refreshOzon(req, res, next) {
    try {
      const { orderId } = req.params;
      const result = await ordersSyncService.refreshOzonOrder(orderId, { profileId: req.user?.profileId ?? null });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async refreshYandex(req, res, next) {
    try {
      const { orderId } = req.params;
      const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
      const organizationId =
        orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;
      const result = await ordersSyncService.refreshYandexOrder(orderId, {
        profileId: req.user?.profileId ?? null,
        organizationId
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async sendToAssembly(req, res, next) {
    try {
      const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
      const organizationId = orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;
      const orderIds = req.body?.orderIds;
      if (!Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({
          ok: false,
          message: 'Передайте массив заказов orderIds: [{ marketplace, orderId }, ...]'
        });
      }

      const warnings = [];

      // Правило (опционально): запрет «На сборку», если под заказ нет фактического резерва на складе.
      // Управляется тумблером в общих настройках аккаунта (profiles.require_reserved_stock_for_assembly).
      const profileId = req.user?.profileId ?? null;
      try {
        const prof = profileId != null ? await profilesRepo.findById(profileId) : null;
        const requireReserve = prof?.require_reserved_stock_for_assembly === true;
        if (requireReserve) {
          const check = await ordersService.validateReservedStockForAssembly(orderIds, { profileId });
          if (Array.isArray(check?.blocked) && check.blocked.length > 0) {
            const allowed = Array.isArray(check?.ok) ? check.ok : [];
            if (allowed.length === 0) {
              const sample = check.blocked.slice(0, 8).map((x) => `${x.orderId}${x.reason ? ` — ${x.reason}` : ''}`).join('; ');
              return res.status(409).json({
                ok: false,
                message:
                  'Нельзя отправить на сборку: нет фактически зарезервированного товара под заказ. ' +
                  `Проверьте резерв/остатки. Примеры: ${sample}${check.blocked.length > 8 ? '…' : ''}`
              });
            }
            // Частичный пропуск: разрешённые уйдут на сборку, заблокированные останутся как есть.
            req.body.orderIds = allowed;
            warnings.push({
              marketplace: 'erm',
              message:
                `Часть заказов не отправлена на сборку из-за отсутствия фактического резерва: ` +
                check.blocked.slice(0, 12).map((x) => String(x.orderId)).join(', ') +
                (check.blocked.length > 12 ? '…' : '')
            });
          }
        }
      } catch (_) {
        // best effort: не ломаем сборку из-за сбоя проверки
      }
      const effectiveOrderIds = req.body?.orderIds;

      // Сначала статус в БД (быстро), поставки МП — в фоне (иначе nginx 504).
      const preserveAssembled = req.body?.preserveAssembled === true;
      const result = await ordersService.sendToAssembly(effectiveOrderIds, profileId, {
        deferReserve: true,
        preserveAssembled
      });

      setImmediate(() => {
        processAssemblyShipmentsInBackground(effectiveOrderIds, { profileId, organizationId }).catch((e) => {
          logger.error('[sendToAssembly] background shipments error', { message: e?.message || String(e) });
        });
      });

      return res.status(200).json({
        ok: true,
        data: {
          ...result,
          shipments: [],
          shipmentsPending: true,
          warnings,
          statusPreserved: result?.statusPreserved ?? 0,
        },
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  /**
   * Вернуть заказ в статус «Новый» (сборка / собран).
   * PUT /orders/:marketplace/:orderId/return-to-new
   */
  async returnToNew(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const updated = await ordersService.returnOrderToNew(
        marketplace,
        orderId,
        req.user?.profileId ?? null
      );
      if (!updated) {
        return res.status(404).json({ ok: false, message: 'Заказ не найден' });
      }
      return res.status(200).json({
        ok: true,
        data: {
          message: 'Заказ возвращён в статус «Новый»',
          reservePending: true,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Массово перевести заказы в «В закупке».
   * POST /orders/bulk-to-procurement  body: { items: [{ marketplace, orderId }] }
   */
  async bulkSetToProcurement(req, res, next) {
    try {
      const raw = req.body?.items ?? req.body?.orderIds ?? [];
      const items = Array.isArray(raw) ? raw : [];
      const data = await ordersService.bulkSetToProcurement(items, req.user?.profileId ?? null);
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Массово вернуть в «Новый».
   * POST /orders/bulk-return-to-new  body: { items: [{ marketplace, orderId }] }
   */
  async bulkReturnToNew(req, res, next) {
    try {
      const raw = req.body?.items ?? req.body?.orderIds ?? [];
      const items = Array.isArray(raw) ? raw : [];
      const data = await ordersService.bulkReturnToNew(items, req.user?.profileId ?? null);
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Перевести заказ в статус «В закупке» («Новый», «На сборке»; у WB — также pending/unknown).
   * PUT /orders/:marketplace/:orderId/to-procurement
   */
  async setToProcurement(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const order = await ordersService.getByMarketplaceAndOrderId(marketplace, orderId, { profileId: req.user?.profileId ?? null });
      if (!order) {
        return res.status(404).json({ ok: false, message: 'Заказ не найден' });
      }
      const stNorm = String(order.status ?? '').trim().toLowerCase();
      if (stNorm === 'in_procurement') {
        return res.status(200).json({
          ok: true,
          data: { message: 'Заказ уже в статусе «В закупке»', alreadyInProcurement: true }
        });
      }
      if (!orderEligibleForProcurement(order)) {
        return res.status(400).json({
          ok: false,
          message:
            'В статус «В закупке» можно перевести заказ в статусе «Новый» или «На сборке» (для Wildberries также — пока статус заказа ещё не получен из API).',
          currentStatus: order.status ?? null
        });
      }
      const { resolveProfileProcurementStatusEnabled } = await import(
        '../utils/profileProcurementStatus.js'
      );
      const procurementEnabled = await resolveProfileProcurementStatusEnabled(
        req.user?.profileId ?? null
      );
      await ordersService.setOrderToProcurement(marketplace, orderId, req.user?.profileId ?? null);
      if (!procurementEnabled) {
        return res.status(200).json({
          ok: true,
          data: {
            message:
              'Статус «В закупке» отключён в настройках аккаунта. Заказ остаётся в текущем статусе; резерв обновляется.',
            procurementStatusDisabled: true,
          },
        });
      }
      return res.status(200).json({ ok: true, data: { message: 'Статус заказа изменён на «В закупке»' } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Отменить заказ на стороне МП (если поддерживается API) и локально в «Отменён».
   * PUT /orders/:marketplace/:orderId/cancel-marketplace
   */
  async cancelWildberries(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const data = await ordersService.cancelOrderOnMarketplace(marketplace, orderId);
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 502) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  /**
   * Отметить заказ как отгруженный (для ручных заказов — тестирование).
   * PUT /orders/:marketplace/:orderId/mark-shipped
   */
  async markShipped(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const order = await ordersService.getByMarketplaceAndOrderId(marketplace, orderId, { profileId: req.user?.profileId ?? null });
      if (!order) {
        return res.status(404).json({ ok: false, message: 'Заказ не найден' });
      }
      await ordersService.markOrderAsShipped(marketplace, orderId, req.user?.profileId ?? null);
      return res.status(200).json({ ok: true, data: { message: 'Статус заказа изменён на «Отгружен»' } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Удалить заказ из ERM (без отмены на МП). Если заказ в группе — удаляется вся группа.
   * DELETE /orders/:marketplace/:orderId
   */
  async deleteOrder(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const order = await ordersService.getByMarketplaceAndOrderId(marketplace, orderId, { profileId: req.user?.profileId ?? null });
      if (!order) {
        return res.status(404).json({ ok: false, message: 'Заказ не найден' });
      }
      const deleted = await ordersService.deleteOrder(marketplace, orderId, { profileId: req.user?.profileId ?? null });
      if (deleted === 0) {
        return res.status(404).json({ ok: false, message: 'Заказ не найден' });
      }
      return res.status(200).json({
        ok: true,
        data: { message: `Заказ удалён${deleted > 1 ? ` (позиций: ${deleted})` : ''}` }
      });
    } catch (error) {
      next(error);
    }
  }

  async getOrderReserve(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const augmentMp =
        req.query.augment_mp === '1' ||
        req.query.augmentMp === '1' ||
        req.query.augment === '1';
      const fast =
        req.query.fast === '1' ||
        req.query.skip_reconcile === '1' ||
        req.query.skipReconcile === '1';
      const data = await ordersService.getOrderReserveSummary(marketplace, orderId, {
        profileId: req.user?.profileId ?? null,
        skipDetailAugment: !augmentMp,
        skipReconcile: fast,
        lightCoverage: true
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode === 404) {
        return res.status(404).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  async setOrderReserve(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const action = req.body?.action ?? 'toggle';
      const productId = req.body?.productId ?? req.body?.product_id ?? null;
      const quantity = req.body?.quantity ?? null;
      const data = await ordersService.setOrderReserve(marketplace, orderId, {
        profileId: req.user?.profileId ?? null,
        action,
        productId,
        quantity
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 501) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  async getDetail(req, res, next) {
    try {
      const { marketplace: marketplaceFromUrl, orderId } = req.params;
      const profileId = req.user?.profileId ?? null;
      const marketplace = await ordersService.resolveMarketplaceForOrderDetail(
        marketplaceFromUrl,
        orderId,
        { profileId }
      );
      const fast =
        req.query.fast === '1' ||
        req.query.fast === 'true' ||
        req.query.quick === '1';

      let assembly = null;
      let localLines = [];
      let reserve = null;
      let ermStatus = null;

      try {
        ermStatus = await ordersService.getErmStatusForOrder(marketplace, orderId, { profileId });
      } catch {
        ermStatus = null;
      }

      try {
        assembly = await ordersService.getAssemblyInfoForOrder(marketplace, orderId, { profileId });
      } catch {
        assembly = null;
      }

      try {
        localLines = await ordersService.getLocalLinesForOrderDetail(marketplace, orderId, { profileId });
      } catch {
        localLines = [];
      }

      try {
        reserve = await ordersService.getOrderReserveSummary(marketplace, orderId, {
          profileId,
          skipDetailAugment: true
        });
      } catch {
        reserve = null;
      }

      if (fast) {
        const localPack =
          (await ordersSyncService.getOrderDetailLocalOnly(marketplace, orderId, { profileId })) || {
            marketplace: String(marketplace || '').toLowerCase() === 'wb' ? 'wildberries' : marketplace,
            detail: null,
            fromLocal: true
          };
        return res.status(200).json({
          ok: true,
          data: {
            ...localPack,
            orderId: String(orderId),
            ermStatus,
            assembly,
            localLines,
            reserve
          }
        });
      }

      const mpTimeoutMs = Number(process.env.ORDER_DETAIL_MP_TIMEOUT_MS) || 25000;
      let result;
      try {
        result = await Promise.race([
          ordersSyncService.getOrderDetail(marketplace, orderId, { profileId }),
          new Promise((_, reject) => {
            setTimeout(() => {
              const err = new Error(
                'Превышено время ожидания ответа маркетплейса. Резерв доступен по данным из системы.'
              );
              err.statusCode = 504;
              reject(err);
            }, mpTimeoutMs);
          })
        ]);
      } catch (mpErr) {
        const localPack = await ordersSyncService.getOrderDetailLocalOnly(marketplace, orderId, {
          profileId
        });
        if (localPack) {
          result = localPack;
        } else if (mpErr?.statusCode === 400 || mpErr?.statusCode === 404 || mpErr?.statusCode === 501) {
          return res.status(mpErr.statusCode).json({ ok: false, message: mpErr.message });
        } else if (localLines.length > 0 || reserve) {
          result = {
            marketplace: String(marketplace || '').toLowerCase(),
            detail: null,
            fromLocal: true
          };
        } else {
          throw mpErr;
        }
      }

      return res.status(200).json({
        ok: true,
        data: {
          ...result,
          orderId: String(orderId),
          ermStatus,
          assembly,
          localLines,
          reserve
        }
      });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 501) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  async getLabel(req, res, next) {
    try {
      const { orderId } = req.params;
      const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
      const organizationId = orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;
      const order = await ordersLabelsService.findOrderById(orderId);
      const filePath = await ordersLabelsService.ensureLabelFile(order, { organizationId });
      const stat = fs.statSync(filePath);
      if (!stat || stat.size === 0) {
        try { fs.unlinkSync(filePath); } catch (_) {}
        const err = new Error('Этикетка не загружена для заказа ' + orderId);
        err.statusCode = 502;
        throw err;
      }
      const ext = filePath.endsWith('.png') ? 'png' : 'pdf';
      res.setHeader(
        'Content-Type',
        ext === 'png' ? 'image/png' : 'application/pdf'
      );
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${order.marketplace}_${order.orderId}.${ext}"`
      );
      return fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      next(error);
    }
  }

  /**
   * HTML-страница с этикеткой и автозапуском печати (для сборки — сразу печатать).
   * GET /orders/:orderId/label/print
   */
  async getLabelPrint(req, res, next) {
    try {
      const { orderId } = req.params;
      const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
      const organizationId = orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;
      const order = await ordersLabelsService.findOrderById(orderId);
      await ordersLabelsService.ensureLabelFile(order, { organizationId });
      const baseUrl = `${req.protocol}://${req.get('host') || ''}${req.baseUrl || ''}`.replace(/\/$/, '');
      const labelUrl = `${baseUrl}/${encodeURIComponent(orderId)}/label`;
      const jsUrl = `${baseUrl}/label/print.js`;
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Этикетка ${orderId}</title>
  <style>
    body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    img, iframe { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <iframe id="labelFrame" src="${labelUrl.replace(/"/g, '&quot;')}" style="width: 100%; height: 100vh; border: none;"></iframe>
  <script src="${jsUrl.replace(/"/g, '&quot;')}" defer></script>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch (error) {
      next(error);
    }
  }

  async getLabelPrintScript(req, res, next) {
    try {
      // CSP: script-src 'self' — ок, т.к. это отдельный файл, не inline.
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(`(function(){'use strict';
var done=false;
function doPrint(){if(done)return;done=true;try{window.focus();}catch(e){}try{window.print();}catch(e){}}
function bind(){var frame=document.getElementById('labelFrame');if(!frame){setTimeout(bind,50);return;}
frame.addEventListener('load',function(){setTimeout(doPrint,50);});
setTimeout(doPrint,800);
}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',bind);}else{bind();}
})();`);
    } catch (error) {
      next(error);
    }
  }

  async getLabelStatus(req, res, next) {
    try {
      const { orderId } = req.params;
      const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
      const organizationId = orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;
      const order = await ordersLabelsService.findOrderById(orderId);
      const status = await ordersLabelsService.getLabelStatus(order, { organizationId });
      return res.status(200).json({ ok: true, data: status });
    } catch (error) {
      next(error);
    }
  }

  async preloadLabels(req, res, next) {
    try {
      const data = await readData('orders');
      const orders = (data && data.orders) || [];
      await ordersLabelsService.preloadLabels(orders);
      return res.status(200).json({ ok: true, data: { processed: orders.length } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Отправить заказ в закупку: резерв + закупка дефицита (без API поставщика).
   * POST /orders/:marketplace/:orderId/send-to-procurement
   */
  async sendToProcurement(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const tid = tenantListProfileId(req);
      const profileId = tid === TENANT_LIST_EMPTY ? null : tid;
      const data = await orderSupplierOrderService.sendToProcurement(marketplace, orderId, {
        profileId,
        userId: req.user?.id ?? null,
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (
        error.statusCode === 400 ||
        error.statusCode === 403 ||
        error.statusCode === 404 ||
        error.statusCode === 409 ||
        error.statusCode === 422 ||
        error.statusCode === 501
      ) {
        return res.status(error.statusCode).json({
          ok: false,
          message: error.message,
          details: error.details ?? null,
        });
      }
      next(error);
    }
  }

  /**
   * @deprecated POST /orders/:marketplace/:orderId/order-at-supplier — алиас submit-to-supplier
   */
  async orderAtSupplier(req, res, next) {
    return this.submitToSupplier(req, res, next);
  }

  /**
   * Отправить открытые закупки заказа в API поставщика.
   * POST /orders/:marketplace/:orderId/submit-to-supplier
   */
  async submitToSupplier(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const tid = tenantListProfileId(req);
      const profileId = tid === TENANT_LIST_EMPTY ? null : tid;
      const force = req.body?.force === true;
      const data = await orderSupplierOrderService.submitToSupplier(marketplace, orderId, {
        profileId,
        userId: req.user?.id ?? null,
        force,
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (
        error.statusCode === 400 ||
        error.statusCode === 403 ||
        error.statusCode === 404 ||
        error.statusCode === 422 ||
        error.statusCode === 501
      ) {
        return res.status(error.statusCode).json({
          ok: false,
          message: error.message,
          details: error.details ?? null,
        });
      }
      next(error);
    }
  }

  /** GET /orders/:marketplace/:orderId/procurement-lines */
  async getProcurementLines(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const tid = tenantListProfileId(req);
      const profileId = tid === TENANT_LIST_EMPTY ? null : tid;
      const data = await orderSupplierOrderService.getProcurementLines(marketplace, orderId, {
        profileId,
      });
      if (!data?.ok && data?.error === 'order_not_found') {
        return res.status(404).json({ ok: false, message: data.message });
      }
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /** POST /orders/:marketplace/:orderId/manual-procurement */
  async manualProcure(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const tid = tenantListProfileId(req);
      const profileId = tid === TENANT_LIST_EMPTY ? null : tid;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const data = await orderSupplierOrderService.manualProcure(marketplace, orderId, {
        profileId,
        userId: req.user?.id ?? null,
        supplierId: body.supplierId,
        existingPurchaseId: body.existingPurchaseId,
        organizationId: body.organizationId,
        warehouseId: body.warehouseId,
        items: body.items,
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (
        error.statusCode === 400 ||
        error.statusCode === 403 ||
        error.statusCode === 404 ||
        error.statusCode === 501
      ) {
        return res.status(error.statusCode).json({
          ok: false,
          message: error.message,
          details: error.details ?? null,
        });
      }
      next(error);
    }
  }

  /** Снять резерв и списать по списку заказов (если при закрытии поставки движения не создались). */
  async reapplyAssemblyStock(req, res, next) {
    try {
      const marketplace = req.body?.marketplace != null ? String(req.body.marketplace).trim() : '';
      const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds.map((x) => String(x).trim()).filter(Boolean) : [];
      if (!marketplace || orderIds.length === 0) {
        return res.status(400).json({ ok: false, message: 'Укажите marketplace и массив orderIds' });
      }
      const tid = tenantListProfileId(req);
      const profileId = tid === TENANT_LIST_EMPTY ? null : tid;
      const data = await ordersService.applyAssemblyStockForShipmentOrders(marketplace, orderIds, profileId);
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }
}

export default new OrdersController();


