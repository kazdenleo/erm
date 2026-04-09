/**
 * Buyout Rate Controller
 * Контроллер для синхронизации процента выкупа товаров
 */

import buyoutRateService from '../services/buyout-rate.service.js';

class BuyoutRateController {
  /**
   * Синхронизировать процент выкупа для одного товара
   * GET /api/buyout-rate/sync/:productId
   */
  async syncForProduct(req, res) {
    try {
      const { productId } = req.params;
      console.log(`[Buyout Rate Controller] Received sync request for productId: ${productId} (type: ${typeof productId})`);
      
      // Пробуем преобразовать в число (может быть строка с точкой или число)
      let productIdNum = null;
      if (typeof productId === 'string' && productId.includes('.')) {
        // Если это строка с точкой (например, "1761603626713.7747"), берем целую часть
        productIdNum = parseInt(productId.split('.')[0], 10);
      } else {
        productIdNum = parseInt(productId, 10);
      }
      
      if (isNaN(productIdNum) || productIdNum <= 0) {
        console.error(`[Buyout Rate Controller] Invalid productId: ${productId}`);
        return res.status(400).json({
          ok: false,
          error: `Неверный ID товара: ${productId}`
        });
      }

      console.log(`[Buyout Rate Controller] Parsed productId: ${productIdNum} (original: ${productId})`);
      
      // Проверяем, что ID валидный
      if (isNaN(productIdNum) || productIdNum <= 0) {
        console.error(`[Buyout Rate Controller] Invalid parsed productId: ${productIdNum}`);
        return res.status(400).json({
          ok: false,
          error: `Неверный ID товара: ${productId} (parsed: ${productIdNum})`
        });
      }
      
      // Передаем req в сервис для доступа к query параметрам (если нужно искать по SKU)
      const result = await buyoutRateService.syncBuyoutRateForProduct(productIdNum, req);
      
      console.log(`[Buyout Rate Controller] Sync result:`, result);
      
      if (result.success) {
        res.json({
          ok: true,
          data: result
        });
      } else {
        res.status(400).json({
          ok: false,
          error: result.error || 'Ошибка синхронизации',
          details: result
        });
      }
    } catch (error) {
      console.error('[Buyout Rate Controller] Error:', error);
      console.error('[Buyout Rate Controller] Error stack:', error.stack);
      res.status(500).json({
        ok: false,
        error: error.message || 'Внутренняя ошибка сервера',
        details: error.stack
      });
    }
  }

  /**
   * Синхронизировать процент выкупа для всех товаров
   * POST /api/buyout-rate/sync/all
   */
  async syncForAll(req, res) {
    try {
      const { limit = 100, offset = 0 } = req.body;
      
      const result = await buyoutRateService.syncBuyoutRateForAll({ limit, offset });
      
      res.json({
        ok: true,
        data: result
      });
    } catch (error) {
      console.error('[Buyout Rate Controller] Error:', error);
      res.status(500).json({
        ok: false,
        error: error.message || 'Внутренняя ошибка сервера'
      });
    }
  }
}

export default new BuyoutRateController();

