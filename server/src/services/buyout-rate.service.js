/**
 * Buyout Rate Service — синхронизация % выкупа с API маркетплейсов.
 */

import productsService from './products.service.js';
import { syncMarketplaceBuyoutForProduct } from './marketplaceBuyoutFetch.service.js';

class BuyoutRateService {
  async syncBuyoutRateForProduct(productId, req = null) {
    try {
      let productIdNum = Number(productId);
      if (typeof productId === 'string' && productId.includes('.')) {
        productIdNum = parseInt(productId.split('.')[0], 10);
      }
      if (!Number.isFinite(productIdNum) || productIdNum <= 0) {
        return { success: false, error: `Неверный ID товара: ${productId}` };
      }

      let product;
      try {
        product = await productsService.getById(productIdNum);
      } catch {
        if (req?.query?.sku) {
          product = await productsService.getBySku(req.query.sku);
          if (product) productIdNum = Number(product.id);
        }
      }

      if (!product) {
        return { success: false, error: `Товар с ID ${productId} не найден` };
      }

      const result = await syncMarketplaceBuyoutForProduct(productIdNum);
      if (!result.ok) {
        return { success: false, error: result.error || 'Ошибка синхронизации', ...result };
      }

      return {
        success: true,
        productId: productIdNum,
        updated: result.updated === true,
        newBuyoutRates: result.buyoutRates,
        source: result.source,
      };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  }

  async syncBuyoutRateForAll(options = {}) {
    const { limit = 100, offset = 0 } = options;
    try {
      const products = await productsService.getAll({ limit, offset });
      const results = {
        total: products.length,
        processed: 0,
        updated: 0,
        errors: 0,
        details: [],
      };

      for (const product of products) {
        if (!product.sku_ozon && !product.sku_wb && !product.sku_ym) continue;
        try {
          const result = await syncMarketplaceBuyoutForProduct(product.id);
          results.processed++;
          if (result.ok && result.updated) results.updated++;
          else if (!result.ok) results.errors++;
          results.details.push({ productId: product.id, sku: product.sku, ...result });
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error) {
          results.errors++;
          results.details.push({
            productId: product.id,
            sku: product.sku,
            ok: false,
            error: error.message,
          });
        }
      }

      return results;
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  }
}

export default new BuyoutRateService();
