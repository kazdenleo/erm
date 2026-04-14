/**
 * Warehouse Receipts Service
 * Оформление приёмок на склад: создание приёмки, движение остатков, обновление себестоимости
 */

import repositoryFactory from '../config/repository-factory.js';
import stockMovementsService from './stockMovements.service.js';

class WarehouseReceiptsService {
  constructor() {
    this.receiptsRepo = repositoryFactory.getWarehouseReceiptsRepository();
    this.productsRepository = repositoryFactory.getProductsRepository();
  }

  async _requireReceiptWarehouseId(warehouseId) {
    const wid = await this.productsRepository.resolveStrictOwnWarehouseId(warehouseId);
    if (!wid) {
      const err = new Error('Укажите склад приёмки (склад хранения)');
      err.statusCode = 400;
      throw err;
    }
    return wid;
  }

  /**
   * Создать приёмку: запись приёмки, строки, движения остатков, обновление себестоимости товаров
   * @param {object} params
   * @param {number|null} params.supplierId
   * @param {number|null} params.organizationId
   * @param {number|string|null} params.warehouseId — обязательный склад размещения
   * @param {Array<{productId: number, quantity: number, cost?: number|null}>} params.lines
   */
  async createReceipt({ supplierId = null, organizationId = null, warehouseId = null, lines = [] }) {
    if (!lines.length) {
      const err = new Error('Добавьте хотя бы одну позицию в приёмку');
      err.statusCode = 400;
      throw err;
    }

    const whId = await this._requireReceiptWarehouseId(warehouseId);

    const receipt = await this.receiptsRepo.create({ supplierId, organizationId, documentType: 'receipt' });
    if (!receipt) throw new Error('Не удалось создать приёмку');

    const receiptNumber = receipt.receipt_number || `ПТ-${receipt.id}`;
    const reason = `Поступление ${receiptNumber}`;

    const byProduct = new Map();
    for (const line of lines) {
      const productId = typeof line.productId === 'string' ? parseInt(line.productId, 10) : line.productId;
      if (!productId) continue;
      const quantity = Math.max(1, parseInt(line.quantity, 10) || 1);
      const cost = line.cost != null && line.cost !== '' ? parseFloat(line.cost) : null;
      const key = productId;
      if (byProduct.has(key)) {
        const prev = byProduct.get(key);
        prev.quantity += quantity;
        if (cost != null && !Number.isNaN(cost)) prev.cost = cost;
      } else {
        byProduct.set(key, { productId, quantity, cost: Number.isNaN(cost) ? null : cost });
      }
    }

    for (const [, row] of byProduct) {
      const { productId, quantity, cost } = row;

      await this.receiptsRepo.addLine({
        receiptId: receipt.id,
        productId,
        quantity,
        cost: cost != null && cost >= 0 ? cost : null
      });

      await stockMovementsService.applyChange(productId, {
        delta: quantity,
        type: 'receipt',
        reason,
        meta: { receipt_id: receipt.id, receipt_number: receiptNumber, warehouse_id: whId }
      });

      if (cost != null && !Number.isNaN(cost) && cost >= 0) {
        await this.productsRepository.update(productId, { cost });
      }
    }

    return {
      receipt,
      linesCount: byProduct.size
    };
  }

  /**
   * Создать возврат поставщику: документ с типом return (ВН-xxx), строки, движения return_to_supplier
   * @param {object} params
   * @param {number|null} params.organizationId - от какой организации возврат
   * @param {number|null} params.supplierId - какому поставщику
   * @param {number|string|null} params.warehouseId — обязательный склад списания
   * @param {Array<{productId: number, quantity: number}>} params.lines
   */
  async createReturn({ organizationId = null, supplierId = null, warehouseId = null, lines = [] }) {
    if (!lines.length) {
      const err = new Error('Добавьте хотя бы одну позицию в возврат');
      err.statusCode = 400;
      throw err;
    }

    const whId = await this._requireReceiptWarehouseId(warehouseId);

    const receipt = await this.receiptsRepo.create({ supplierId, organizationId, documentType: 'return' });
    if (!receipt) throw new Error('Не удалось создать возвратную накладную');

    const receiptNumber = receipt.receipt_number || `ВН-${receipt.id}`;
    const reason = `Возврат поставщику ${receiptNumber}`;

    const byProduct = new Map();
    for (const line of lines) {
      const productId = typeof line.productId === 'string' ? parseInt(line.productId, 10) : line.productId;
      if (!productId) continue;
      const quantity = Math.max(1, parseInt(line.quantity, 10) || 1);
      const key = productId;
      if (byProduct.has(key)) {
        const prev = byProduct.get(key);
        prev.quantity += quantity;
      } else {
        byProduct.set(key, { productId, quantity });
      }
    }

    for (const [, row] of byProduct) {
      const { productId, quantity } = row;

      await this.receiptsRepo.addLine({
        receiptId: receipt.id,
        productId,
        quantity,
        cost: null
      });

      await stockMovementsService.applyChange(productId, {
        delta: -quantity,
        type: 'return_to_supplier',
        reason,
        meta: {
          receipt_id: receipt.id,
          receipt_number: receiptNumber,
          supplier_id: supplierId,
          warehouse_id: whId
        }
      });
    }

    return {
      receipt,
      linesCount: byProduct.size
    };
  }

  /**
   * Создать возврат от клиента на склад: документ с типом customer_return (ВК-xxx), строки, движение остатков +quantity
   * @param {object} params
   * @param {number|null} params.organizationId - организация (принимающая возврат)
   * @param {number|string|null} params.warehouseId — обязательный склад приёмки
   * @param {Array<{productId: number, quantity: number, cost?: number|null}>} params.lines
   */
  async createCustomerReturn({ organizationId = null, warehouseId = null, lines = [] }) {
    if (!lines.length) {
      const err = new Error('Добавьте хотя бы одну позицию в возврат от клиента');
      err.statusCode = 400;
      throw err;
    }

    const whId = await this._requireReceiptWarehouseId(warehouseId);

    const receipt = await this.receiptsRepo.create({ supplierId: null, organizationId, documentType: 'customer_return' });
    if (!receipt) throw new Error('Не удалось создать документ возврата от клиента');

    const receiptNumber = receipt.receipt_number || `ВК-${receipt.id}`;
    const reason = `Возврат от клиента ${receiptNumber}`;

    const byProduct = new Map();
    for (const line of lines) {
      const productId = typeof line.productId === 'string' ? parseInt(line.productId, 10) : line.productId;
      if (!productId) continue;
      const quantity = Math.max(1, parseInt(line.quantity, 10) || 1);
      const cost = line.cost != null && line.cost !== '' ? parseFloat(line.cost) : null;
      const key = productId;
      if (byProduct.has(key)) {
        const prev = byProduct.get(key);
        prev.quantity += quantity;
        if (cost != null && !Number.isNaN(cost)) prev.cost = cost;
      } else {
        byProduct.set(key, { productId, quantity, cost: Number.isNaN(cost) ? null : cost });
      }
    }

    for (const [, row] of byProduct) {
      const { productId, quantity, cost } = row;

      await this.receiptsRepo.addLine({
        receiptId: receipt.id,
        productId,
        quantity,
        cost: cost != null && cost >= 0 ? cost : null
      });

      await stockMovementsService.applyChange(productId, {
        delta: quantity,
        type: 'customer_return',
        reason,
        meta: { receipt_id: receipt.id, receipt_number: receiptNumber, warehouse_id: whId }
      });

      if (cost != null && !Number.isNaN(cost) && cost >= 0) {
        await this.productsRepository.update(productId, { cost });
      }
    }

    return {
      receipt,
      linesCount: byProduct.size
    };
  }

  async getList({ limit = 100, offset = 0 } = {}) {
    const list = await this.receiptsRepo.findAll({ limit, offset });
    const total = await this.receiptsRepo.count();
    return { list, total };
  }

  async getByIdWithLines(id) {
    const receipt = await this.receiptsRepo.findById(id);
    if (!receipt) return null;
    const lines = await this.receiptsRepo.getLinesWithProducts(id);
    return { ...receipt, lines };
  }

  /**
   * Удалить приёмку или возврат: отменить движения остатков, затем удалить документ.
   * Приёмка: остаток уменьшается на количество по строкам.
   * Возврат: остаток увеличивается на количество по строкам.
   */
  async deleteReceipt(id) {
    const receipt = await this.getByIdWithLines(id);
    if (!receipt) return null;
    const receiptNumber = receipt.receipt_number ||
      (receipt.document_type === 'return' ? `ВН-${id}` : (receipt.document_type === 'customer_return' ? `ВК-${id}` : `ПТ-${id}`));
    const lines = receipt.lines || await this.receiptsRepo.getLinesWithProducts(id);
    const isReturnToSupplier = receipt.document_type === 'return';
    const isCustomerReturn = receipt.document_type === 'customer_return';
    const reason = isReturnToSupplier
      ? `Аннулирование возврата ${receiptNumber}`
      : (isCustomerReturn ? `Аннулирование возврата от клиента ${receiptNumber}` : `Аннулирование приёмки ${receiptNumber}`);
    for (const line of lines) {
      const productId = line.product_id;
      const quantity = Math.max(0, parseInt(line.quantity, 10) || 0);
      if (!productId || quantity < 1) continue;
      const reverseDelta = isReturnToSupplier ? quantity : -quantity;
      await stockMovementsService.applyChange(productId, {
        delta: reverseDelta,
        type: 'manual',
        reason,
        meta: { receipt_id: id, receipt_number: receiptNumber, deleted: true }
      });
    }
    await this.receiptsRepo.delete(id);
    return { deleted: true, id };
  }
}

export default new WarehouseReceiptsService();
