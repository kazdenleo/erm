/**
 * Assembly Controller
 * Поиск заказа на сборке по штрихкоду товара
 */

import config from '../config/index.js';
import { isOrderOnAssemblyStatus } from '../constants/orderStatuses.js';
import productsService from '../services/products.service.js';
import ordersService from '../services/orders.service.js';
import ordersLabelsService from '../services/orders.labels.service.js';
import {
  buildAssemblyOrderItems,
  buildAssemblyOrderItemsFromGroup
} from '../services/assemblyOrderItems.service.js';

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

/** Если в БД нет product_id, сопоставить строку заказа с отсканированным товаром по артикулам Маркета */
function productIdFromScannedProductLine(product, orderRow) {
  if (!product?.id) return null;
  const offer = norm(orderRow.offerId ?? orderRow.offer_id);
  const msku = norm(orderRow.sku ?? orderRow.marketplace_sku);
  const vals = new Set();
  const add = x => {
    const v = norm(x);
    if (v) vals.add(v);
  };
  add(product.sku);
  add(product.sku_ozon);
  add(product.sku_wb);
  add(product.sku_ym);
  if (product.marketplace_skus && typeof product.marketplace_skus === 'object') {
    Object.values(product.marketplace_skus).forEach(add);
  }
  if (offer && vals.has(offer)) return Number(product.id);
  if (msku && vals.has(msku)) return Number(product.id);
  if (product.name && norm(orderRow.productName || orderRow.product_name) === norm(product.name)) {
    return Number(product.id);
  }
  return null;
}

class AssemblyController {
  /**
   * GET /api/assembly/find-by-barcode?barcode=xxx
   * Найти первый по списку заказ на сборке, содержащий товар с данным штрихкодом.
   * Возвращает заказ, товар и список позиций заказа (для отображения «осталось дособрать»).
   */
  async findOrderByBarcode(req, res, next) {
    try {
      const barcode = String(req.query.barcode ?? '')
        .trim()
        .replace(/[\r\n\t]+/g, '');
      if (!barcode) {
        return res.status(400).json({
          ok: false,
          message: 'Укажите штрихкод: ?barcode=...'
        });
      }

      const productFound = await productsService.getByBarcode(barcode);
      if (!productFound) {
        return res.status(404).json({
          ok: false,
          message: 'Товар с таким штрихкодом не найден'
        });
      }
      const product =
        productFound.id != null
          ? (await productsService.getByIdWithDetails(productFound.id).catch(() => null)) || productFound
          : productFound;

      // Поиск только по product_id / SKU / комплекту — без fallback по названию:
      // общие названия («Салонный фильтр») давали ложные совпадения с чужими заказами.
      const order = await ordersService.findFirstAssembledByProductId(product.id);
      if (!order) {
        const { query: dbQuery } = await import('../config/database.js');
        const kitHint = await dbQuery(
          `SELECT 1 FROM kit_components WHERE component_product_id = $1 LIMIT 1`,
          [Number(product.id)]
        );
        const hint = (kitHint.rows?.length ?? 0) > 0
          ? ' Товар входит в комплект — проверьте, что заказ на сборке оформлен на SKU комплекта и привязан в ERP.'
          : '';
        return res.status(404).json({
          ok: false,
          message: `Заказ на сборке с этим товаром не найден.${hint}`
        });
      }

      const orderMatchesProduct = await ordersService.assemblyOrderMatchesScannedProduct(order, product.id);
      if (!orderMatchesProduct) {
        return res.status(404).json({
          ok: false,
          message: 'Заказ на сборке с этим товаром не найден.'
        });
      }

      let orderItems;
      if (order.orderGroupId) {
        const groupOrders = await ordersService.getByOrderGroupId(order.orderGroupId);
        orderItems = await buildAssemblyOrderItemsFromGroup(groupOrders, ordersService, {
          scannedProductId: product.id
        });
        if (!orderItems.length) {
          orderItems = await Promise.all(
            (groupOrders || []).map(async (o) => {
              let productId = o.productId ?? o.product_id;
              if (productId == null) {
                productId = await ordersService.resolveProductIdForAssemblyLine(o);
              }
              if (productId == null) {
                productId = productIdFromScannedProductLine(product, o);
              }
              const n = productId != null ? Number(productId) : NaN;
              const oid = o.orderId ?? o.order_id;
              return {
                productId: Number.isNaN(n) ? productId : n,
                productName: o.productName || o.product_name,
                quantity: o.quantity ?? 1,
                offerId: o.offerId ?? o.offer_id ?? null,
                orderLineId: oid != null ? String(oid) : null
              };
            })
          );
        }
      } else {
        orderItems = await buildAssemblyOrderItems(order, ordersService, {
          scannedProductId: product.id
        });
        if (!orderItems.length) {
          let linePid = order.productId ?? order.product_id;
          if (linePid == null) {
            linePid = await ordersService.resolveProductIdForAssemblyLine(order);
          }
          if (linePid == null) {
            linePid = product.id;
          }
          const n = linePid != null ? Number(linePid) : NaN;
          const oidSingle = order.orderId ?? order.order_id;
          orderItems = [
            {
              productId: Number.isNaN(n) ? linePid : n,
              productName: order.productName || order.product_name,
              quantity: order.quantity ?? 1,
              offerId: order.offerId ?? order.offer_id ?? null,
              orderLineId: oidSingle != null ? String(oidSingle) : null
            }
          ];
        }
      }

      return res.status(200).json({
        ok: true,
        data: {
          // Для сборки по штрихкоду важно, чтобы productId был заполнен,
          // иначе фронт не сможет корректно считать "осталось дособрать".
          order: order.productId ? order : { ...order, productId: product.id },
          product,
          orderItems
        }
      });
    } catch (error) {
      if (error.statusCode === 404) {
        return res.status(404).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  /**
   * POST /api/assembly/mark-collected
   * Отметить заказ как собранный: статус → 'assembled', заказ убирается из списка сборки.
   * Body: { marketplace, orderId, stickerNumber? }
   */
  async markCollected(req, res, next) {
    try {
      const { marketplace, orderId } = req.body || {};
      const stickerNumberRaw = req.body?.stickerNumber ?? req.body?.sticker_number ?? null;
      const stickerNumber = stickerNumberRaw != null ? String(stickerNumberRaw).trim() : null;
      if (!marketplace || orderId == null) {
        return res.status(400).json({
          ok: false,
          message: 'Укажите marketplace и orderId в теле запроса'
        });
      }
      const order = await ordersService.getByMarketplaceAndOrderId(marketplace, String(orderId), {
        profileId: req.user?.profileId ?? null
      });
      if (!order) {
        return res.status(404).json({
          ok: false,
          message: 'Заказ не найден'
        });
      }
      if (!isOrderOnAssemblyStatus(order.status)) {
        return res.status(400).json({
          ok: false,
          message: 'Заказ не на сборке или уже собран'
        });
      }
      const mpNorm = String(marketplace || '').toLowerCase();
      const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
      const organizationId =
        orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;
      const needsMpLabel =
        mpNorm !== 'manual' &&
        (mpNorm === 'ozon' ||
          mpNorm === 'wb' ||
          mpNorm === 'wildberries' ||
          mpNorm === 'yandex' ||
          mpNorm === 'ym' ||
          mpNorm === 'yandexmarket');
      if (needsMpLabel && !ordersLabelsService.hasLabelCached(order)) {
        try {
          await ordersLabelsService.ensureLabelFile(order, { organizationId });
        } catch (e) {
          const hint =
            mpNorm === 'ozon'
              ? 'Для Ozon этикетка появляется после перевода в «Ожидает отгрузки»; для продаж юрлицам заполните данные в ЛК Ozon.'
              : 'Дождитесь загрузки этикетки на странице сборки (иконка печати) или проверьте заказ в ЛК маркетплейса.';
          return res.status(409).json({
            ok: false,
            message: e?.message ? `${e.message}. ${hint}` : `Этикетка не готова. ${hint}`
          });
        }
      }
      if (!config.auth?.disabled && !req.user?.id) {
        return res.status(401).json({ ok: false, message: 'Требуется авторизация для отметки сборки' });
      }
      const assembledByUserId =
        req.user?.id != null && Number(req.user.id) > 0 ? Number(req.user.id) : null;
      const updated = await ordersService.markOrderAsAssembled(
        marketplace,
        String(orderId),
        assembledByUserId,
        req.user?.profileId ?? null,
        stickerNumber
      );
      let labelReady = needsMpLabel ? ordersLabelsService.hasLabelCached(updated || order) : false;
      if (updated && needsMpLabel && !labelReady) {
        try {
          await ordersLabelsService.ensureLabelFile(updated, { organizationId });
          labelReady = true;
        } catch {
          /* сборка уже отмечена — этикетку догрузит клиент */
        }
      } else if (updated && needsMpLabel) {
        labelReady = true;
      }
      return res.status(200).json({
        ok: true,
        data: { order: updated, labelReady }
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new AssemblyController();
