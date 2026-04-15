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
import { readData } from '../utils/storage.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class OrdersController {
  async getAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: [] });
      }
      const stockProblemRaw = req.query?.stockProblem ?? req.query?.stock_problem;
      const stockProblem =
        stockProblemRaw === '1' || stockProblemRaw === 'true'
          ? true
          : (stockProblemRaw === '0' || stockProblemRaw === 'false' ? false : undefined);
      const orders = await ordersService.getAll({
        ...(tid != null ? { profileId: tid } : {}),
        ...(stockProblem !== undefined ? { stockProblem } : {}),
      });
      // Не кэшируем: список заказов часто меняется после синхронизации.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: orders });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Ручное добавление заказа: один товар или несколько.
   * Body: { productId, quantity } — одна позиция;
   *   или { items: [{ productId, quantity }, ...] } — несколько товаров в одном заказе.
   */
  async createManual(req, res, next) {
    try {
      const items = req.body?.items;
      if (Array.isArray(items) && items.length > 0) {
        const valid = items.filter(it => it?.productId != null && Number(it.productId) >= 1);
        if (valid.length === 0) {
          return res.status(400).json({ ok: false, message: 'Укажите хотя бы один товар с количеством (items: [{ productId, quantity }, ...]).' });
        }
        const { orderGroupId, orders } = await ordersService.createManualWithItems(valid);
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
        price: product.cost != null ? Number(product.cost) : (product.price != null ? Number(product.price) : 0),
        status: 'new'
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
      const syncResult = await ordersSyncService.syncFbs({ force, profileId: req.user?.profileId ?? null });

      if (syncResult.rateLimited && !syncResult.result) {
        return res.status(429).json({
          ok: false,
          message:
            syncResult.message ||
            `Слишком частые запросы. Подождите ${syncResult.retryAfterSeconds} секунд перед следующим запросом.`,
          retryAfterSeconds: syncResult.retryAfterSeconds
        });
      }

      return res.status(200).json({
        ok: true,
        force: force || undefined,
        cached: syncResult.cached,
        rateLimited: syncResult.rateLimited,
        retryAfterSeconds: syncResult.retryAfterSeconds,
        data: syncResult.result
      });
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
        const openShipment = await shipmentsService.getOrCreateOpenShipment(code, { profileId });
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
            await shipmentsService.addOrdersToShipment(shipment.id, orderIds, { profileId });
            shipmentsUsed.push({ marketplace: code, shipmentId: shipment.id, shipmentName: shipment.name, orderIds });
          } catch (e) {
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
      let stockProblem = null;
      let stockProblemDetectedAt = null;
      let stockProblemDetails = null;
      try {
        const local = await ordersService.getByMarketplaceAndOrderId(marketplace, orderId, { profileId: req.user?.profileId ?? null });
        if (local?.assembledAt || local?.assembledByEmail || local?.assembledByFullName) {
          assembly = {
            assembledAt: local.assembledAt ?? null,
            assembledByUserId: local.assembledByUserId ?? null,
            assembledByEmail: local.assembledByEmail ?? null,
            assembledByFullName: local.assembledByFullName ?? null,
          };
        }
        if (local) {
          stockProblem = Boolean(local.stockProblem ?? local.stock_problem);
          stockProblemDetectedAt = local.stockProblemDetectedAt ?? local.stock_problem_detected_at ?? null;
          stockProblemDetails = local.stockProblemDetails ?? local.stock_problem_details ?? null;
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
          stockProblem,
          stockProblemDetectedAt,
          stockProblemDetails,
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
      const order = await ordersLabelsService.findOrderById(orderId);
      const filePath = await ordersLabelsService.ensureLabelFile(order);
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
      const order = await ordersLabelsService.findOrderById(orderId);
      await ordersLabelsService.ensureLabelFile(order);
      const baseUrl = `${req.protocol}://${req.get('host') || ''}${req.baseUrl || ''}`.replace(/\/$/, '');
      const labelUrl = `${baseUrl}/${encodeURIComponent(orderId)}/label`;
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
  <script>
    (function(){
      var done = false;
      function doPrint() {
        if (done) return;
        done = true;
        window.print();
      }
      var frame = document.getElementById('labelFrame');
      frame.onload = doPrint;
      window.setTimeout(doPrint, 800);
    })();
  </script>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch (error) {
      next(error);
    }
  }

  async getLabelStatus(req, res, next) {
    try {
      const { orderId } = req.params;
      const order = await ordersLabelsService.findOrderById(orderId);
      const status = await ordersLabelsService.getLabelStatus(order);
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


