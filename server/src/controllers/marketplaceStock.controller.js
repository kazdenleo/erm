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
      const { organizationId, productIds, warehouseId } = req.body || {};
      if (!organizationId) {
        return res.status(400).json({ ok: false, message: 'Укажите organizationId' });
      }
      const result = await syncOrganizationWarehouseStockToMarketplaces(organizationId, {
        productIds: Array.isArray(productIds) ? productIds : undefined,
        warehouseId: warehouseId ?? null,
        source: 'api_bulk'
      });
      return res.status(200).json({ ok: true, data: result });
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
