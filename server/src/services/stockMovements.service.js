/**
 * Stock Movements Service
 * Бизнес-логика для журнала движений остатков
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';

class StockMovementsService {
  constructor() {
    this.repository = repositoryFactory.getStockMovementsRepository();
    this.productsRepository = repositoryFactory.getProductsRepository();
  }

  /**
   * Применить изменение остатка к товару и записать движение.
   * Остаток изменяется по выбранному складу (meta.warehouse_id / meta.warehouseId или склад по умолчанию);
   * products.quantity — сумма свободных остатков по всем складам.
   *
   * @param {number|string} productId
   * @param {object} options
   * @param {number} options.delta - изменение остатка на выбранном складе
   * @param {string} options.type - тип операции (receipt, writeoff, shipment, reserve, unreserve, inventory, manual)
   * @param {string} [options.reason] - человекочитаемое описание причины
   * @param {object} [options.meta] - дополнительные данные (warehouse_id опционально)
   */
  async applyChange(productId, { delta, type, reason, meta } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : productId;
    if (!idNum || Number.isNaN(idNum)) {
      const error = new Error('Некорректный ID товара');
      error.statusCode = 400;
      throw error;
    }

    const product = await this.productsRepository.findById(idNum);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }

    const metaObj = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
    const whRaw = metaObj.warehouse_id ?? metaObj.warehouseId;
    const warehouseId = await this.productsRepository.resolveOwnWarehouseId(whRaw);
    if (!warehouseId) {
      const error = new Error('Не найден склад для операции (добавьте склад type=warehouse без поставщика)');
      error.statusCode = 400;
      throw error;
    }

    const totalBefore = product.quantity != null ? Number(product.quantity) : 0;
    const currentReserved = product.reserved_quantity != null ? Number(product.reserved_quantity) : 0;
    const safeDelta = Number.isNaN(Number(delta)) ? 0 : Number(delta);

    const currentWh = await this.productsRepository.getWarehouseFreeStock(idNum, warehouseId);
    let newWh = currentWh + safeDelta;
    if (newWh < 0) newWh = 0;

    let newReserved = currentReserved;
    if (type === 'reserve' && safeDelta < 0) {
      newReserved = currentReserved + Math.abs(safeDelta);
    } else if (type === 'unreserve' && safeDelta > 0) {
      newReserved = Math.max(0, currentReserved - safeDelta);
    }

    // ВАЖНО: резерв не должен менять фактический остаток.
    // products.quantity и product_warehouse_stock.quantity считаем "фактом" на складе,
    // а reserved_quantity — отдельное логическое поле "сколько закреплено под заказы".
    if (type !== 'reserve' && type !== 'unreserve') {
      await this.productsRepository.setWarehouseFreeStock(idNum, warehouseId, newWh);
    }

    if (type === 'reserve' || type === 'unreserve') {
      await query(
        'UPDATE products SET reserved_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newReserved, idNum]
      );
    }

    const productAfter = await this.productsRepository.findById(idNum);
    const totalAfter = productAfter?.quantity != null ? Number(productAfter.quantity) : 0;

    const metaOut = { ...metaObj, warehouse_id: warehouseId };
    const profId = product.profile_id ?? product.profileId ?? null;
    const movement = await this.repository.create({
      productId: idNum,
      type,
      quantityChange: safeDelta,
      balanceAfter: totalAfter,
      reason: reason || null,
      meta: metaOut,
      warehouseId,
      profileId: profId
    });

    if (type !== 'reserve' && type !== 'unreserve') {
      try {
        const { default: ordersService } = await import('./orders.service.js');
        await ordersService.trimExcessReservesForProduct(idNum, {
          reason: reason || undefined,
          meta: { from_stock_movement_type: type }
        });
      } catch {
        // не блокируем движение при сбое пересчёта резервов
      }
    }

    return {
      productId: idNum,
      quantityBefore: totalBefore,
      quantityAfter: totalAfter,
      delta: safeDelta,
      warehouseId,
      movement
    };
  }

  /**
   * Получить историю движений по товару
   */
  async getHistory(productId, { limit = 100, profileId = null } = {}) {
    return await this.repository.findByProduct(productId, { limit, profileId });
  }
}

export default new StockMovementsService();
