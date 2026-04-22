/**
 * Assembly Controller
 * Поиск заказа на сборке по штрихкоду товара
 */

import config from '../config/index.js';
import productsService from '../services/products.service.js';
import ordersService from '../services/orders.service.js';

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

      // 1) Основной путь: по product_id / sku-сопоставлению.
      // 2) Fallback: по названию товара (если заказ не привязан к product_id).
      let order = await ordersService.findFirstAssembledByProductId(product.id);
      if (!order && product?.name) {
        order = await ordersService.findFirstAssembledByProductName(product.name);
      }
      if (!order) {
        return res.status(404).json({
          ok: false,
          message: 'Заказ на сборке с этим товаром не найден'
        });
      }

      let orderItems;
      if (order.orderGroupId) {
        const groupOrders = await ordersService.getByOrderGroupId(order.orderGroupId);
        orderItems = await Promise.all(
          (groupOrders || []).map(async o => {
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
              /** Идентификатор строки заказа в БД (для отображения, напр. 69394478-0087-1) */
              orderLineId: oid != null ? String(oid) : null
            };
          })
        );
      } else {
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
   * Body: { marketplace, orderId, stickerNumber }
   */
  async markCollected(req, res, next) {
    try {
      const { marketplace, orderId } = req.body || {};
      const stickerNumber = String(req.body?.stickerNumber ?? req.body?.sticker_number ?? '').trim();
      if (!stickerNumber) {
        return res.status(400).json({
          ok: false,
          message: 'Укажите номер стикера (stickerNumber)'
        });
      }
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
      if (order.status !== 'in_assembly') {
        return res.status(400).json({
          ok: false,
          message: 'Заказ не на сборке или уже собран'
        });
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
      return res.status(200).json({
        ok: true,
        data: { order: updated }
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new AssemblyController();
