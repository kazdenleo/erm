/**
 * API: отправка остатков («Доступно») на маркетплейсы.
 */

import {
  syncWarehouseStockToMarketplaces,
  syncOrganizationWarehouseStockToMarketplaces
} from '../services/marketplaceWarehouseStockSync.service.js';
import { computeAvailableQuantity } from '../services/sellableQuantity.service.js';

class MarketplaceStockController {
  /** POST /api/marketplace-stock/sync/product/:productId */
  async syncProduct(req, res, next) {
    try {
      const productId = req.params.productId;
      const warehouseId = req.body?.warehouseId ?? req.query?.warehouseId ?? null;
      const result = await syncWarehouseStockToMarketplaces(productId, {
        source: 'api_manual',
        warehouseId,
        organizationId: req.body?.organizationId ?? null
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (e) {
      next(e);
    }
  }

  /** POST /api/marketplace-stock/sync */
  async syncBulk(req, res, next) {
    try {
      const { organizationId, productIds, warehouseId, warehouseScoped } = req.body || {};
      if (!organizationId) {
        return res.status(400).json({ ok: false, message: 'Укажите organizationId' });
      }
      if (warehouseScoped === true && (warehouseId == null || String(warehouseId).trim() === '')) {
        return res.status(400).json({
          ok: false,
          message: 'Укажите warehouseId — остатки отправляются на МП, привязанные к этому складу'
        });
      }

      const idsList = Array.isArray(productIds) ? productIds : [];
      const useBackground =
        warehouseScoped === true || idsList.length > Number(process.env.MP_STOCK_PUSH_INLINE_MAX || 25);

      if (useBackground) {
        const { startMpStockPushInBackground, getMpStockPushStatus } = await import(
          '../services/marketplaceStockPush.job.js'
        );
        const { findOrganizationMarketplaceLinkedProductIds } = await import(
          '../services/marketplaceWarehouseStockSync.service.js'
        );

        const status = getMpStockPushStatus();
        if (status.inProgress) {
          return res.status(200).json({
            ok: true,
            data: {
              inProgress: true,
              started: false,
              message:
                'Отправка остатков на маркетплейсы уже выполняется. Подождите несколько минут и обновите страницу.'
            }
          });
        }

        let productsTotal = idsList.length;
        if (warehouseScoped === true) {
          const allIds = await findOrganizationMarketplaceLinkedProductIds(organizationId);
          productsTotal = allIds.length;
        }

        const started = startMpStockPushInBackground(organizationId, {
          productIds: warehouseScoped === true ? undefined : idsList,
          warehouseId: warehouseId ?? null,
          warehouseScoped: warehouseScoped === true,
          source: 'api_bulk',
          productsTotal
        });

        return res.status(202).json({
          ok: true,
          data: {
            inProgress: true,
            started: started.started,
            productsTotal,
            message: `Отправка остатков запущена в фоне${productsTotal ? ` (~${productsTotal} товаров)` : ''}. Это может занять 5–30 минут — затем проверьте остатки на маркетплейсах.`
          }
        });
      }

      const result = await syncOrganizationWarehouseStockToMarketplaces(organizationId, {
        productIds: idsList.length > 0 ? idsList : undefined,
        warehouseId: warehouseId ?? null,
        warehouseScoped: warehouseScoped === true,
        source: 'api_bulk',
        includeDetails: true
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (e) {
      next(e);
    }
  }

  /** GET /api/marketplace-stock/sync/status */
  async syncStatus(req, res, next) {
    try {
      const { getMpStockPushStatus } = await import('../services/marketplaceStockPush.job.js');
      return res.status(200).json({ ok: true, data: getMpStockPushStatus() });
    } catch (e) {
      next(e);
    }
  }

  /** GET /api/marketplace-stock/available/:productId?warehouseId= */
  async getAvailable(req, res, next) {
    try {
      const productId = req.params.productId;
      const warehouseId = req.query?.warehouseId ?? null;
      const data = await computeAvailableQuantity(productId, { warehouseId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }
}

export default new MarketplaceStockController();
