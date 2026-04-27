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

const profilesRepo = repositoryFactory.getProfilesRepository();

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
      const limit = limitRaw != null ? Number(limitRaw) : null;
      const offset = offsetRaw != null ? Number(offsetRaw) : 0;
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
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(Number.isFinite(offset) && offset > 0 ? { offset } : {}),
      };
      const hasPaging = Number.isFinite(limit) && limit > 0;
      const result = hasPaging
        ? await ordersService.getPage(options)
        : { items: await ordersService.getAll(options), total: null };
      // Не кэшируем: список заказов часто меняется после синхронизации.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        ok: true,
        data: result.items,
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
      const profileId = req.user?.profileId ?? null;

      // 1) Быстрый ответ из кэша (минутный лимит) — чтобы UI не зависал.
      const status = ordersSyncService.getSyncFbsStatus();
      const oneMinute = 60 * 1000;
      if (!force && status.lastSyncTime && Date.now() - status.lastSyncTime < oneMinute && status.lastSyncResult) {
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
      const start = ordersSyncService.startSyncFbsInBackground({ force, profileId });
      return res.status(202).json({
        ok: true,
        started: start.started,
        inProgress: true,
        force: force || undefined,
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

  async refreshOzon(req, res, next) {
    try {
      const { orderId } = req.params;
      const result = await ordersSyncService.refreshOzonOrder(orderId, { profileId: req.user?.profileId ?? null });
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
      const byMarketplace = {};
      for (const o of orderIds) {
        const mp = (o.marketplace || '').toLowerCase();
        const code = mp === 'wb' ? 'wildberries' : mp;
        if (!['ozon', 'wildberries', 'yandex'].includes(code)) continue;
        if (!byMarketplace[code]) byMarketplace[code] = [];
        byMarketplace[code].push({ marketplace: o.marketplace, orderId: String(o.orderId) });
      }
      const shipmentsUsed = [];
      const warnings = [];
      for (const [code, list] of Object.entries(byMarketplace)) {
        if (list.length === 0) continue;
        // Идемпотентность: если заказ уже привязан к какой-то поставке — используем её и не добавляем заново.
        const profileId = req.user?.profileId ?? null;
        const openShipment = await shipmentsService.getOrCreateOpenShipment(code, { profileId, organizationId });
        const byShipmentId = new Map(); // shipmentId -> { shipment, orderIds: [] }

        for (const o of list) {
          const existingShip = await shipmentsService.findLocalShipmentContainingOrder(code, o.orderId, {
            profileId
          });
          const useShip = existingShip || openShipment;
          if (!byShipmentId.has(useShip.id)) {
            byShipmentId.set(useShip.id, { shipment: useShip, orderIds: [] });
          }
          byShipmentId.get(useShip.id).orderIds.push(o.orderId);
        }

        for (const { shipment, orderIds } of byShipmentId.values()) {
          try {
            const s = await shipmentsService.addOrdersToShipment(shipment.id, orderIds, { profileId, organizationId });
            shipmentsUsed.push({
              marketplace: code,
              shipmentId: s.id,
              shipmentName: s.name,
              orderIds,
              localWbOnly: s.localWbOnly === true,
            });
          } catch (e) {
            // Ozon 502: не удалось перевести постинги в «Ожидает отгрузки» (статус/ошибка Ozon API).
            // По требованию: заказ всё равно уходит «На сборке» в ERM, а проблему показываем как предупреждение.
            if (code === 'ozon' && e?.statusCode === 502) {
              warnings.push({
                marketplace: code,
                shipmentId: shipment.id,
                message: e.message,
                failedOrderIds: Array.isArray(e?.ozonErrors) ? e.ozonErrors.map((x) => String(x?.postingNumber || '')).filter(Boolean) : []
              });
              continue;
            }
            // WB 409: часть заказов уже в другой поставке WB или статус не подходит.
            // По требованию: такие заказы всё равно отправляем "На сборку" в ERM (физически они у нас),
            // а ошибку превращаем в предупреждение.
            if (e?.statusCode === 409) {
              const failed = Array.isArray(e.failedOrderIds) ? e.failedOrderIds.map(String) : [];
              warnings.push({
                marketplace: code,
                shipmentId: shipment.id,
                message: e.message,
                failedOrderIds: failed
              });
              continue;
            }
            throw e;
          }
        }
      }
      const result = await ordersService.sendToAssembly(orderIds, req.user?.profileId ?? null);

      // Автопредзагрузка этикеток после перевода «На сборке».
      // Делается в фоне: чтобы UI не ждал WB/Ozon/YM и не ловил 504/таймауты.
      try {
        const uniq = Array.isArray(orderIds)
          ? [...new Set(orderIds.map((o) => (o?.orderId != null ? String(o.orderId) : '')).filter(Boolean))]
          : [];
        setTimeout(() => {
          for (const oid of uniq) {
            // getLabelStatus сам поставит скачивание в фон, если файла ещё нет
            ordersLabelsService
              .findOrderById(oid)
              .then((order) => ordersLabelsService.getLabelStatus(order, { organizationId }))
              .catch(() => {});
          }
        }, 0);
      } catch {
        /* best effort */
      }

      return res.status(200).json({
        ok: true,
        data: { ...result, shipments: shipmentsUsed, warnings }
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
      const order = await ordersService.getByMarketplaceAndOrderId(marketplace, orderId, { profileId: req.user?.profileId ?? null });
      if (!order) {
        return res.status(404).json({ ok: false, message: 'Заказ не найден' });
      }
      await ordersService.returnOrderToNew(marketplace, orderId, req.user?.profileId ?? null);
      return res.status(200).json({ ok: true, data: { message: 'Заказ возвращён в статус «Новый»' } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Перевести заказ в статус «В закупке». Только для заказов в статусе «Новый».
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
            'В статус «В закупке» можно перевести заказ в статусе «Новый» (для Wildberries также — пока статус заказа ещё не получен из API).',
          currentStatus: order.status ?? null
        });
      }
      await ordersService.setOrderToProcurement(marketplace, orderId, req.user?.profileId ?? null);
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
   * Удалить заказ (только ручные заказы). Если заказ в группе — удаляется вся группа.
   * DELETE /orders/:marketplace/:orderId
   */
  async deleteOrder(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const mp = (marketplace || '').toLowerCase();
      if (mp !== 'manual') {
        return res.status(403).json({ ok: false, message: 'Удаление разрешено только для ручных заказов' });
      }
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

  async getDetail(req, res, next) {
    try {
      const { marketplace, orderId } = req.params;
      const result = await ordersSyncService.getOrderDetail(marketplace, orderId, { profileId: req.user?.profileId ?? null });
      let assembly = null;
      let localLines = [];
      try {
        const local = await ordersService.getByMarketplaceAndOrderId(marketplace, orderId, { profileId: req.user?.profileId ?? null });
        if (
          local?.assembledAt ||
          local?.assembledByEmail ||
          local?.assembledByFullName ||
          (local?.assemblyStickerNumber ?? local?.assembly_sticker_number)
        ) {
          assembly = {
            assembledAt: local.assembledAt ?? null,
            assembledByUserId: local.assembledByUserId ?? null,
            assembledByEmail: local.assembledByEmail ?? null,
            assembledByFullName: local.assembledByFullName ?? null,
            assemblyStickerNumber: local.assemblyStickerNumber ?? local.assembly_sticker_number ?? null,
          };
        }
      } catch {
        /* нет строки в локальной БД — только маркетплейс */
      }
      try {
        localLines = await ordersService.getLocalLinesForOrderDetail(marketplace, orderId, { profileId: req.user?.profileId ?? null });
      } catch {
        localLines = [];
      }
      return res.status(200).json({
        ok: true,
        data: {
          ...result,
          assembly,
          localLines,
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
}

export default new OrdersController();


