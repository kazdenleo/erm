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
        organizationId: req.body?.organizationId ?? null,
        profileId: req.user?.profileId ?? null
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (e) {
      next(e);
    }
  }

  /** POST /api/marketplace-stock/sync */
  async syncBulk(req, res, next) {
    try {
      const { organizationId, productIds, warehouseId, warehouseScoped, force } = req.body || {};
      const profileId = req.user?.profileId ?? null;
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
      const inlineMax = Number(process.env.MP_STOCK_PUSH_INLINE_MAX || 50);
      const useBackground = idsList.length > inlineMax;

      if (useBackground) {
        const { startMpStockPushInBackground, getMpStockPushStatus } = await import(
          '../services/marketplaceStockPush.job.js'
        );

        const status = getMpStockPushStatus();
        if (status.inProgress && force !== true) {
          return res.status(200).json({
            ok: true,
            data: {
              inProgress: true,
              started: false,
              lastStartedAt: status.lastStartedAt,
              lastFinishedAt: status.lastFinishedAt,
              lastError: status.lastError,
              lastResult: status.lastResult
                ? {
                    pushed: status.lastResult.pushed,
                    failed: status.lastResult.failed,
                    skipped: status.lastResult.skipped,
                    productsTotal: status.lastResult.productsTotal
                  }
                : null,
              message:
                'Отправка остатков уже выполняется. Подождите завершения или нажмите кнопку снова и согласитесь на повторный запуск.'
            }
          });
        }

        const productsTotal = idsList.length;

        const started = startMpStockPushInBackground(organizationId, {
          productIds: idsList.length > 0 ? idsList : undefined,
          warehouseId: warehouseId ?? null,
          warehouseScoped: warehouseScoped === true,
          profileId,
          source: 'api_bulk',
          productsTotal,
          force: force === true
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
        profileId,
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

  /** GET /api/marketplace-stock/available/:productId?warehouseId=&forMarketplace=1 */
  async getAvailable(req, res, next) {
    try {
      const productId = req.params.productId;
      const warehouseId = req.query?.warehouseId ?? null;
      const forMp =
        req.query?.forMarketplace === 'true' ||
        req.query?.forMarketplace === '1' ||
        req.query?.forMarketplace === true;
      if (!forMp) {
        const data = await computeAvailableQuantity(productId, { warehouseId });
        return res.status(200).json({ ok: true, data });
      }
      const mp = await computeAvailableQuantity(productId, { warehouseId, forMarketplace: true });
      const ui = await computeAvailableQuantity(productId, { warehouseId });
      return res.status(200).json({
        ok: true,
        data: {
          ...mp,
          uiAvailable: ui.available,
          marketplaceAvailable: mp.available
        }
      });
    } catch (e) {
      next(e);
    }
  }
}

export default new MarketplaceStockController();
