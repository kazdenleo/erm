/**
 * Warehouse Receipts Service
 * Оформление приёмок на склад: создание приёмки, движение остатков, обновление себестоимости
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
import stockMovementsService from './stockMovements.service.js';
import { isKitProductId } from './kitStock.service.js';

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

  /** Себестоимость строки: из запроса или из карточки товара. */
  async _resolveLineCost(productId, lineCost) {
    const parsed = lineCost != null && lineCost !== '' ? parseFloat(lineCost) : null;
    if (parsed != null && !Number.isNaN(parsed) && parsed >= 0) return parsed;
    const product = await this.productsRepository.findById(productId);
    const fromCatalog = product?.cost != null ? Number(product.cost) : null;
    return fromCatalog != null && !Number.isNaN(fromCatalog) && fromCatalog >= 0 ? fromCatalog : null;
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

    if (byProduct.size === 0) {
      const err = new Error('Добавьте хотя бы одну позицию в приёмку');
      err.statusCode = 400;
      throw err;
    }

    let receipt = null;
    try {
      receipt = await this.receiptsRepo.create({ supplierId, organizationId, documentType: 'receipt' });
      if (!receipt) throw new Error('Не удалось создать приёмку');

      const receiptNumber = receipt.receipt_number || `ПТ-${receipt.id}`;
      const reason = `Поступление ${receiptNumber}`;

      for (const [, row] of byProduct) {
        const { productId, quantity, cost } = row;
        const isKit = await isKitProductId(productId);

        await this.receiptsRepo.addLine({
          receiptId: receipt.id,
          productId,
          quantity,
          cost: cost != null && cost >= 0 ? cost : null
        });

        // Приёмка комплекта с поставщика — оприходование целого SKU, без списания комплектующих (это не производство).
        await stockMovementsService.applyChange(productId, {
          delta: quantity,
          type: 'receipt',
          reason,
          meta: {
            receipt_id: receipt.id,
            receipt_number: receiptNumber,
            warehouse_id: whId,
            ...(isKit ? { kit_receipt: true } : {})
          }
        });

        if (cost != null && !Number.isNaN(cost) && cost >= 0) {
          await this.productsRepository.update(productId, { cost });
        }
      }

      return {
        receipt,
        linesCount: byProduct.size
      };
    } catch (err) {
      if (receipt?.id) {
        try {
          await this.receiptsRepo.delete(receipt.id);
        } catch {
          /* не блокируем исходную ошибку */
        }
      }
      throw err;
    }
  }

  /** Старая приёмка «сборки»: в журнале есть списание комплектующих по этому документу. */
  async _isLegacyKitAssemblyReceipt(receiptId) {
    const rid = Number(receiptId);
    if (!Number.isFinite(rid) || rid < 1) return false;
    const r = await query(
      `SELECT 1 FROM stock_movements
       WHERE (meta->>'receipt_id')::bigint = $1
         AND (
           meta->>'kit_component_deduct' = 'true'
           OR meta->>'kit_assembly_receipt' = 'true'
         )
       LIMIT 1`,
      [rid]
    );
    return (r.rows?.length ?? 0) > 0;
  }

  async _resolveReceiptWarehouseId(receiptId) {
    const rid = Number(receiptId);
    if (!Number.isFinite(rid) || rid < 1) {
      return this.productsRepository.resolveOwnWarehouseId(null);
    }
    try {
      const r = await query(
        `SELECT warehouse_id, meta
         FROM stock_movements
         WHERE (meta->>'receipt_id')::bigint = $1
           AND warehouse_id IS NOT NULL
         ORDER BY id DESC
         LIMIT 1`,
        [rid]
      );
      const row = r.rows?.[0];
      if (row?.warehouse_id != null) {
        return this.productsRepository.resolveOwnWarehouseId(row.warehouse_id);
      }
      const metaWh = row?.meta?.warehouse_id ?? row?.meta?.warehouseId;
      if (metaWh != null) {
        return this.productsRepository.resolveOwnWarehouseId(metaWh);
      }
    } catch {
      /* ignore */
    }
    return this.productsRepository.resolveOwnWarehouseId(null);
  }

  /**
   * Отмена старой приёмки «сборки»: K1− и возврат комплектующих на склад.
   */
  async _reverseLegacyKitAssemblyReceipt({
    kitProductId,
    quantity,
    reason,
    receiptId,
    receiptNumber,
    warehouseId
  }) {
    const { getKitComponents, buildKitComponentQtyMap } = await import('./kitStock.service.js');
    const { runWithProductStockLock } = await import('./stockMovements.service.js');
    const kitId = Number(kitProductId);
    const kits = Math.max(1, parseInt(quantity, 10) || 1);
    const components = await getKitComponents(kitId);
    if (!components.length) {
      const err = new Error('У комплекта не задан состав kit_components');
      err.statusCode = 400;
      throw err;
    }
    const whId =
      warehouseId != null
        ? await this.productsRepository.resolveStrictOwnWarehouseId(warehouseId)
        : await this._resolveReceiptWarehouseId(receiptId);
    if (!whId) {
      const err = new Error('Не определён склад для отмены приёмки комплекта');
      err.statusCode = 400;
      throw err;
    }

    const compQtyMap = buildKitComponentQtyMap(components, kits);
    const lockIds = [kitId, ...[...compQtyMap.keys()].map((n) => Number(n))]
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    const metaBase = {
      receipt_id: receiptId,
      receipt_number: receiptNumber,
      warehouse_id: whId,
      kit_assembly_receipt: true,
      kit_assembly_receipt_reversal: true,
      kit_product_id: kitId,
      kit_units: kits,
      deleted: true
    };

    const applyMoves = async () => {
      await stockMovementsService.applyChange(kitId, {
        delta: -kits,
        type: 'shipment',
        reason,
        meta: metaBase
      });
      for (const [compId, compQty] of compQtyMap) {
        await stockMovementsService.applyChange(compId, {
          delta: compQty,
          type: 'receipt',
          reason: `${reason}: возврат комплектующих при отмене приёмки комплекта`,
          meta: { ...metaBase, kit_component_restore: true }
        });
      }
    };

    const runChain = (idx) => {
      if (idx >= lockIds.length) return applyMoves();
      return runWithProductStockLock(lockIds[idx], () => runChain(idx + 1));
    };
    await runChain(0);
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
      const isKit = await isKitProductId(productId);

      await this.receiptsRepo.addLine({
        receiptId: receipt.id,
        productId,
        quantity,
        cost: null
      });

      if (isKit) {
        const { computeAvailableQuantity } = await import('./sellableQuantity.service.js');
        const metrics = await computeAvailableQuantity(productId, {
          warehouseId: whId,
          supplierSyncEnabled: false
        });
        const onHand = Math.max(0, Number(metrics.onHand) || 0);
        if (onHand < quantity) {
          const err = new Error(
            `Недостаточно комплектов на складе для возврата поставщику: нужно ${quantity}, на складе ${onHand}`
          );
          err.statusCode = 409;
          throw err;
        }
      }

      await stockMovementsService.applyChange(productId, {
        delta: -quantity,
        type: 'return_to_supplier',
        reason,
        meta: {
          receipt_id: receipt.id,
          receipt_number: receiptNumber,
          supplier_id: supplierId,
          warehouse_id: whId,
          ...(isKit ? { kit_return_to_supplier: true } : {})
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
      const { productId, quantity } = row;
      const cost = await this._resolveLineCost(productId, row.cost);
      const isKit = await isKitProductId(productId);

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
        meta: {
          receipt_id: receipt.id,
          receipt_number: receiptNumber,
          warehouse_id: whId,
          ...(isKit ? { kit_customer_return: true } : {})
        }
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

  async getList({ limit = 100, offset = 0, profileId = null, documentType = null } = {}) {
    const list = await this.receiptsRepo.findAll({ limit, offset, profileId, documentType });
    const total = await this.receiptsRepo.count({ profileId, documentType });
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

      if (
        !isReturnToSupplier &&
        !isCustomerReturn &&
        (await isKitProductId(productId)) &&
        (await this._isLegacyKitAssemblyReceipt(id))
      ) {
        const whId = await this._resolveReceiptWarehouseId(id);
        await this._reverseLegacyKitAssemblyReceipt({
          kitProductId: productId,
          quantity,
          reason,
          receiptId: id,
          receiptNumber,
          warehouseId: whId
        });
        continue;
      }

      const reverseDelta = isReturnToSupplier ? quantity : -quantity;
      const reverseType = isCustomerReturn
        ? 'customer_return'
        : isReturnToSupplier
          ? 'return_to_supplier'
          : 'manual';
      const whId = await this._resolveReceiptWarehouseId(id);
      await stockMovementsService.applyChange(productId, {
        delta: reverseDelta,
        type: reverseType,
        reason,
        meta: {
          receipt_id: id,
          receipt_number: receiptNumber,
          warehouse_id: whId,
          deleted: true,
          receipt_reversal: true
        }
      });
    }
    await this.receiptsRepo.delete(id);
    return { deleted: true, id };
  }
}

export default new WarehouseReceiptsService();
