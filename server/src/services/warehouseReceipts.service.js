/**
 * Warehouse Receipts Service
 * Оформление приёмок на склад: создание приёмки, движение остатков, обновление себестоимости
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
import stockMovementsService from './stockMovements.service.js';
import { isKitProductId } from './kitStock.service.js';
import { readProductWarehouseOnHand } from './productWarehouseQuantity.service.js';
import { requireWarehouseDocumentScope, requireTransferDocumentScope, assertWarehouseBelongsToOrganization } from '../utils/stockDocumentScope.js';
import { looksLikeCis } from '../utils/chestnyZnak.js';
import chestnyZnakOps from './chestnyZnakOps.service.js';
import logger from '../utils/logger.js';

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

  _normalizeReceiptLines(lines) {
    const byProduct = new Map();
    for (const line of lines || []) {
      const productId =
        typeof line.productId === 'string'
          ? parseInt(line.productId, 10)
          : typeof line.product_id === 'string'
            ? parseInt(line.product_id, 10)
            : line.productId ?? line.product_id;
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
    return byProduct;
  }

  _receiptLinesToProductMap(lines) {
    return this._normalizeReceiptLines(
      (lines || []).map((line) => ({
        productId: line.product_id ?? line.productId,
        quantity: line.quantity,
        cost: line.cost ?? line.product_cost ?? null,
      }))
    );
  }

  _resolveReceiptDocumentType(receipt) {
    const raw = String(receipt?.document_type || receipt?.documentType || '').trim().toLowerCase();
    if (raw && raw !== 'receipt') {
      return raw;
    }
    const num = String(receipt?.receipt_number || receipt?.receiptNumber || '').trim().toUpperCase();
    if (num.startsWith('ПМ-')) return 'transfer';
    if (num.startsWith('СП-')) return 'writeoff';
    if (num.startsWith('ВН-')) return 'return';
    if (num.startsWith('ВК-')) return 'customer_return';
    return raw || 'receipt';
  }

  async _resolveReceiptToWarehouseId(receiptId, receipt = null) {
    const r = receipt || (await this.receiptsRepo.findById(receiptId));
    const direct = r?.to_warehouse_id ?? r?.toWarehouseId ?? null;
    if (direct != null && direct !== '') {
      const n = Number(direct);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const numId = typeof receiptId === 'string' ? parseInt(receiptId, 10) : Number(receiptId);
    if (!Number.isFinite(numId) || numId < 1) return null;
    const result = await query(
      `SELECT NULLIF(sm.meta->>'to_warehouse_id', '')::bigint AS warehouse_id
       FROM stock_movements sm
       WHERE sm.type = 'transfer'
         AND (sm.meta->>'receipt_id')::bigint = $1
         AND NULLIF(sm.meta->>'to_warehouse_id', '') IS NOT NULL
       ORDER BY sm.id DESC
       LIMIT 1`,
      [numId]
    );
    const wh = result.rows?.[0]?.warehouse_id;
    return wh != null ? Number(wh) : null;
  }

  async _editUsesLegacyKitAssembly(receiptId, oldLines, newByProduct) {
    const rid = Number(receiptId);
    if (!Number.isFinite(rid) || rid < 1) return false;
    if (!(await this._isLegacyKitAssemblyReceipt(rid))) return false;
    const ids = new Set();
    for (const line of oldLines || []) {
      const pid = line.product_id ?? line.productId;
      if (pid) ids.add(Number(pid));
    }
    for (const row of newByProduct?.values() || []) {
      if (row?.productId) ids.add(Number(row.productId));
    }
    for (const productId of ids) {
      if (await isKitProductId(productId)) return true;
    }
    return false;
  }

  /**
   * Редактирование приёмки одной записью в журнале: нетто-изменение по каждой позиции.
   */
  async _applyReceiptEditNetStock({
    receipt,
    receiptId,
    receiptNumber,
    warehouseId,
    oldByProduct,
    newByProduct,
    documentType = 'receipt',
  }) {
    const isReturnToSupplier = documentType === 'return';
    const isCustomerReturn = documentType === 'customer_return';
    const isWriteoff = documentType === 'writeoff';
    const docLabel = isWriteoff
      ? 'списания'
      : isReturnToSupplier
        ? 'возврата'
        : isCustomerReturn
          ? 'возврата от клиента'
          : 'приёмки';
    const productIds = new Set([...oldByProduct.keys(), ...newByProduct.keys()]);

    for (const productId of productIds) {
      const oldQty = Math.max(0, parseInt(oldByProduct.get(productId)?.quantity, 10) || 0);
      const newRow = newByProduct.get(productId);
      const newQty = newRow ? Math.max(0, parseInt(newRow.quantity, 10) || 0) : 0;
      const delta = newQty - oldQty;

      if (newQty > 0) {
        const cost =
          newRow?.cost != null && newRow.cost !== ''
            ? await this._resolveLineCost(productId, newRow.cost)
            : await this._resolveLineCost(productId, null);
        await this.receiptsRepo.addLine({
          receiptId,
          productId,
          quantity: newQty,
          cost: cost != null && cost >= 0 ? cost : null,
        });
        // Возврат поставщику: себестоимость только в документе, карточку не трогаем
        if (cost != null && !Number.isNaN(cost) && cost >= 0 && !isReturnToSupplier) {
          await this.productsRepository.update(productId, { cost });
        }
      }

      if (delta === 0) continue;

      const reason = `Изменение ${docLabel} ${receiptNumber}: ${oldQty} → ${newQty}`;
      const isKit = await isKitProductId(productId);

      if (isReturnToSupplier) {
        if (delta > 0) {
          let onHand;
          if (isKit) {
            const { computeAvailableQuantity } = await import('./sellableQuantity.service.js');
            const metrics = await computeAvailableQuantity(productId, {
              warehouseId,
              supplierSyncEnabled: false,
            });
            onHand = Math.max(0, Number(metrics.onHand) || 0);
          } else {
            onHand = await readProductWarehouseOnHand(productId, warehouseId);
          }
          if (onHand < delta) {
            const product = await this.productsRepository.findById(productId);
            const label = product?.sku || product?.name || `#${productId}`;
            const err = new Error(
              `Недостаточно товара на складе: ${label} (доступно ${onHand}, нужно ${delta})`
            );
            err.statusCode = 400;
            throw err;
          }
        }
        await stockMovementsService.applyChange(productId, {
          delta: -delta,
          type: 'return_to_supplier',
          reason,
          meta: {
            receipt_id: receiptId,
            receipt_number: receiptNumber,
            warehouse_id: warehouseId,
            receipt_edit: true,
            quantity_before: oldQty,
            quantity_after: newQty,
          },
        });
        continue;
      }

      if (isCustomerReturn) {
        await stockMovementsService.applyChange(productId, {
          delta,
          type: 'customer_return',
          reason,
          meta: {
            receipt_id: receiptId,
            receipt_number: receiptNumber,
            warehouse_id: warehouseId,
            receipt_edit: true,
            quantity_before: oldQty,
            quantity_after: newQty,
            ...(isKit ? { kit_customer_return: true } : {}),
          },
        });
        continue;
      }

      if (isWriteoff) {
        if (delta > 0) {
          let onHand;
          if (isKit) {
            const { computeAvailableQuantity } = await import('./sellableQuantity.service.js');
            const metrics = await computeAvailableQuantity(productId, {
              warehouseId,
              supplierSyncEnabled: false,
            });
            onHand = Math.max(0, Number(metrics.onHand) || 0);
          } else {
            onHand = await readProductWarehouseOnHand(productId, warehouseId);
          }
          if (onHand < delta) {
            const product = await this.productsRepository.findById(productId);
            const label = product?.sku || product?.name || `#${productId}`;
            const err = new Error(
              `Недостаточно товара на складе: ${label} (доступно ${onHand}, нужно ${delta})`
            );
            err.statusCode = 400;
            throw err;
          }
        }
        await stockMovementsService.applyChange(productId, {
          delta: -delta,
          type: 'writeoff',
          reason,
          meta: {
            receipt_id: receiptId,
            receipt_number: receiptNumber,
            warehouse_id: warehouseId,
            organization_id: receipt.organization_id ?? receipt.organizationId ?? null,
            receipt_edit: true,
            quantity_before: oldQty,
            quantity_after: newQty,
            ...(isKit ? { kit_writeoff: true } : {}),
          },
        });
        continue;
      }

      await stockMovementsService.applyChange(productId, {
        delta,
        type: 'receipt',
        reason,
        meta: {
          receipt_id: receiptId,
          receipt_number: receiptNumber,
          warehouse_id: warehouseId,
          receipt_edit: true,
          quantity_before: oldQty,
          quantity_after: newQty,
          ...(isKit ? { kit_receipt: true } : {}),
        },
      });
    }
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

    const scope = requireWarehouseDocumentScope({
      documentType: 'receipt',
      organizationId,
      supplierId,
      warehouseId,
    });
    const whId = await this._requireReceiptWarehouseId(scope.warehouseId);

    const byProduct = this._normalizeReceiptLines(lines);

    if (byProduct.size === 0) {
      const err = new Error('Добавьте хотя бы одну позицию в приёмку');
      err.statusCode = 400;
      throw err;
    }

    let receipt = null;
    try {
      receipt = await this.receiptsRepo.create({
        supplierId: scope.supplierId,
        organizationId: scope.organizationId,
        documentType: 'receipt',
      });
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

  /** Остатки по документу уже откатаны (повторное удаление — только снять запись). */
  async _isReceiptStockAlreadyReversed(receiptId, receipt = null) {
    const rid = Number(receiptId);
    if (!Number.isFinite(rid) || rid < 1) return false;

    const docType = receipt
      ? this._resolveReceiptDocumentType(receipt)
      : await this._loadReceiptDocumentType(rid);

    if (docType === 'transfer') {
      const r = await query(
        `SELECT 1
         FROM stock_movements
         WHERE (meta->>'receipt_id')::bigint = $1
           AND (
             meta->>'transfer_reversal' = 'true'
             OR (meta->>'deleted' = 'true' AND type = 'transfer')
           )
         LIMIT 1`,
        [rid]
      );
      return (r.rows?.length ?? 0) > 0;
    }

    const r = await query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(quantity_change), 0)::int AS net
       FROM stock_movements
       WHERE (meta->>'receipt_id')::bigint = $1`,
      [rid]
    );
    const total = r.rows?.[0]?.total ?? 0;
    const net = r.rows?.[0]?.net ?? 0;
    return total > 0 && net === 0;
  }

  async _loadReceiptDocumentType(receiptId) {
    const rid = Number(receiptId);
    if (!Number.isFinite(rid) || rid < 1) return 'receipt';
    try {
      const r = await query(
        `SELECT document_type, receipt_number FROM warehouse_receipts WHERE id = $1`,
        [rid]
      );
      return this._resolveReceiptDocumentType(r.rows?.[0] || {});
    } catch {
      return 'receipt';
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

  async _resolveReceiptWarehouseId(receiptId, profileId = null) {
    const rid = Number(receiptId);
    let effectiveProfileId = profileId;
    if (!effectiveProfileId && Number.isFinite(rid) && rid > 0) {
      try {
        const pr = await query(
          `SELECT w.profile_id
           FROM stock_movements sm
           INNER JOIN warehouses w ON w.id = sm.warehouse_id
           WHERE (sm.meta->>'receipt_id')::bigint = $1
             AND w.profile_id IS NOT NULL
           ORDER BY sm.id DESC
           LIMIT 1`,
          [rid]
        );
        effectiveProfileId = pr.rows?.[0]?.profile_id ?? null;
      } catch {
        effectiveProfileId = null;
      }
    }
    if (!Number.isFinite(rid) || rid < 1) {
      return this.productsRepository.resolveOwnWarehouseId(null, effectiveProfileId);
    }
    try {
      const wr = await query(`SELECT warehouse_id FROM warehouse_receipts WHERE id = $1`, [rid]);
      if (wr.rows?.[0]?.warehouse_id != null) {
        return this.productsRepository.resolveOwnWarehouseId(
          wr.rows[0].warehouse_id,
          effectiveProfileId
        );
      }
    } catch {
      /* ignore */
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
        return this.productsRepository.resolveOwnWarehouseId(row.warehouse_id, effectiveProfileId);
      }
      const metaWh = row?.meta?.warehouse_id ?? row?.meta?.warehouseId;
      if (metaWh != null) {
        return this.productsRepository.resolveOwnWarehouseId(metaWh, effectiveProfileId);
      }
    } catch {
      /* ignore */
    }
    return this.productsRepository.resolveOwnWarehouseId(null, effectiveProfileId);
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

    // applyChange сам берёт advisory lock на product_id; вложенные runWithProductStockLock давали deadlock.
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
  }

  /**
   * Создать возврат поставщику: документ с типом return (ВН-xxx), строки, движения return_to_supplier
   * @param {object} params
   * @param {number|null} params.organizationId - от какой организации возврат
   * @param {number|null} params.supplierId - какому поставщику
   * @param {number|string|null} params.warehouseId — обязательный склад списания
   * @param {Array<{productId: number, quantity: number, cost?: number|null}>} params.lines
   * Себестоимость пишется в строки документа (для суммы ВН), карточку товара не меняем.
   */
  async createReturn({ organizationId = null, supplierId = null, warehouseId = null, lines = [] }) {
    if (!lines.length) {
      const err = new Error('Добавьте хотя бы одну позицию в возврат');
      err.statusCode = 400;
      throw err;
    }

    const scope = requireWarehouseDocumentScope({
      documentType: 'return',
      organizationId,
      supplierId,
      warehouseId,
    });
    await assertWarehouseBelongsToOrganization(scope.warehouseId, scope.organizationId);
    const whId = await this._requireReceiptWarehouseId(scope.warehouseId);

    const byProduct = this._normalizeReceiptLines(lines);

    if (!byProduct.size) {
      const err = new Error('Не удалось определить товары в позициях возврата (productId)');
      err.statusCode = 400;
      throw err;
    }

    for (const [, row] of byProduct) {
      const { productId, quantity } = row;
      const isKit = await isKitProductId(productId);
      let onHand;
      if (isKit) {
        const { computeAvailableQuantity } = await import('./sellableQuantity.service.js');
        const metrics = await computeAvailableQuantity(productId, {
          warehouseId: whId,
          supplierSyncEnabled: false,
        });
        onHand = Math.max(0, Number(metrics.onHand) || 0);
      } else {
        onHand = await readProductWarehouseOnHand(productId, whId);
      }
      if (onHand < quantity) {
        const product = await this.productsRepository.findById(productId);
        const label = product?.sku || product?.name || `#${productId}`;
        const err = new Error(
          isKit
            ? `Недостаточно комплектов на складе для возврата поставщику (${label}): нужно ${quantity}, на складе ${onHand}`
            : `Недостаточно товара на выбранном складе (${label}): нужно ${quantity}, доступно ${onHand}`
        );
        err.statusCode = 409;
        throw err;
      }
    }

    const receipt = await this.receiptsRepo.create({
      supplierId: scope.supplierId,
      organizationId: scope.organizationId,
      documentType: 'return',
    });
    if (!receipt) throw new Error('Не удалось создать возвратную накладную');

    const receiptNumber = receipt.receipt_number || `ВН-${receipt.id}`;
    const reason = `Возврат поставщику ${receiptNumber}`;

    for (const [, row] of byProduct) {
      const { productId, quantity } = row;
      const isKit = await isKitProductId(productId);
      const cost = await this._resolveLineCost(productId, row.cost);

      await this.receiptsRepo.addLine({
        receiptId: receipt.id,
        productId,
        quantity,
        cost: cost != null && cost >= 0 ? cost : null,
      });

      const extraMeta = {
        receipt_id: receipt.id,
        receipt_number: receiptNumber,
        supplier_id: supplierId,
        warehouse_id: whId,
        organization_id: scope.organizationId,
      };
      if (isKit) {
        extraMeta.kit_return_to_supplier = true;
      } else {
        const kc = await query(
          `SELECT kit_product_id, quantity FROM kit_components WHERE component_product_id = $1 LIMIT 1`,
          [productId]
        );
        if (kc.rows?.[0]?.kit_product_id != null) {
          const perKit = Math.max(1, parseInt(kc.rows[0].quantity, 10) || 1);
          extraMeta.kit_component_return_to_supplier = true;
          extraMeta.kit_product_id = Number(kc.rows[0].kit_product_id);
          extraMeta.kit_assemblable_units_lost = Math.max(1, Math.floor(quantity / perKit));
        }
      }

      await stockMovementsService.applyChange(productId, {
        delta: -quantity,
        type: 'return_to_supplier',
        reason,
        meta: extraMeta,
      });
    }

    return {
      receipt,
      linesCount: byProduct.size,
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

    const scope = requireWarehouseDocumentScope({
      documentType: 'customer_return',
      organizationId,
      supplierId: null,
      warehouseId,
    });
    await assertWarehouseBelongsToOrganization(scope.warehouseId, scope.organizationId);
    const whId = await this._requireReceiptWarehouseId(scope.warehouseId);

    const receipt = await this.receiptsRepo.create({
      supplierId: null,
      organizationId: scope.organizationId,
      documentType: 'customer_return',
    });
    if (!receipt) throw new Error('Не удалось создать документ возврата от клиента');

    const receiptNumber = receipt.receipt_number || `ВК-${receipt.id}`;
    const reason = `Возврат от клиента ${receiptNumber}`;

    const byProduct = this._normalizeReceiptLines(lines);

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
          organization_id: scope.organizationId,
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

  /**
   * Создать документ списания: warehouse_receipts document_type writeoff (СП-xxx), строки, движения writeoff
   * @param {object} params
   * @param {number|null} params.organizationId
   * @param {number|string|null} params.warehouseId
   * @param {string} params.writeoffReason — «Брак» или «Утеря»
   * @param {Array<{productId: number, quantity: number}>} params.lines
   */
  async createWriteoff({ organizationId = null, warehouseId = null, writeoffReason = null, lines = [], profileId = null }) {
    const ALLOWED_WRITEOFF_REASONS = ['Брак', 'Утеря'];
    const reasonLabel = String(writeoffReason || '').trim();
    if (!ALLOWED_WRITEOFF_REASONS.includes(reasonLabel)) {
      const err = new Error('Укажите причину списания: Брак или Утеря');
      err.statusCode = 400;
      throw err;
    }
    if (!lines.length) {
      const err = new Error('Добавьте хотя бы одну позицию в списание');
      err.statusCode = 400;
      throw err;
    }

    const scope = requireWarehouseDocumentScope({
      documentType: 'writeoff',
      organizationId,
      supplierId: null,
      warehouseId,
    });
    await assertWarehouseBelongsToOrganization(scope.warehouseId, scope.organizationId);
    const whId = await this._requireReceiptWarehouseId(scope.warehouseId);

    const byProduct = this._normalizeReceiptLines(lines);
    if (!byProduct.size) {
      const err = new Error('Не удалось определить товары в позициях списания (productId)');
      err.statusCode = 400;
      throw err;
    }

    for (const [, row] of byProduct) {
      const { productId, quantity } = row;
      const isKit = await isKitProductId(productId);
      let onHand;
      if (isKit) {
        const { computeAvailableQuantity } = await import('./sellableQuantity.service.js');
        const metrics = await computeAvailableQuantity(productId, {
          warehouseId: whId,
          supplierSyncEnabled: false,
        });
        onHand = Math.max(0, Number(metrics.onHand) || 0);
      } else {
        onHand = await readProductWarehouseOnHand(productId, whId);
      }
      if (onHand < quantity) {
        const product = await this.productsRepository.findById(productId);
        const label = product?.sku || product?.name || `#${productId}`;
        const err = new Error(
          isKit
            ? `Недостаточно комплектов на складе для списания (${label}): нужно ${quantity}, на складе ${onHand}`
            : `Недостаточно товара на выбранном складе (${label}): нужно ${quantity}, доступно ${onHand}`
        );
        err.statusCode = 409;
        throw err;
      }
    }

    const receipt = await this.receiptsRepo.create({
      supplierId: null,
      organizationId: scope.organizationId,
      documentType: 'writeoff',
      warehouseId: whId,
      writeoffReason: reasonLabel,
    });
    if (!receipt) throw new Error('Не удалось создать документ списания');

    const receiptNumber = receipt.receipt_number || `СП-${receipt.id}`;
    const movementReason = `Списание ${receiptNumber}: ${reasonLabel}`;

    for (const [, row] of byProduct) {
      const { productId, quantity } = row;
      const cost = await this._resolveLineCost(productId, row.cost);
      const isKit = await isKitProductId(productId);

      await this.receiptsRepo.addLine({
        receiptId: receipt.id,
        productId,
        quantity,
        cost: cost != null && cost >= 0 ? cost : null,
      });

      await stockMovementsService.applyChange(productId, {
        delta: -quantity,
        type: 'writeoff',
        reason: movementReason,
        meta: {
          receipt_id: receipt.id,
          receipt_number: receiptNumber,
          warehouse_id: whId,
          organization_id: scope.organizationId,
          writeoff_reason: reasonLabel,
          ...(isKit ? { kit_writeoff: true } : {}),
        },
      });
    }

    const cisCodes = [];
    for (const line of lines || []) {
      const pidLine = line.productId ?? line.product_id ?? null;
      const list = Array.isArray(line.cises)
        ? line.cises
        : line.cis
          ? [line.cis]
          : [];
      for (const raw of list) {
        if (looksLikeCis(raw)) cisCodes.push({ cis: raw, productId: pidLine });
      }
    }
    if (cisCodes.length && profileId && scope.organizationId) {
      for (const row of cisCodes) {
        try {
          await chestnyZnakOps.tryBindCis({
            code: row.cis,
            kind: 'own_use',
            sourceType: 'writeoff',
            sourceId: receipt.id,
            productId: row.productId,
            warehouseId: whId,
            profileId,
            organizationId: scope.organizationId,
          });
        } catch (e) {
          logger.warn('[ChestnyZnak] writeoff CIS bind:', e?.message || e);
        }
      }
      await chestnyZnakOps
        .maybeCreateDocument({
          kind: 'own_use',
          sourceType: 'writeoff',
          sourceId: receipt.id,
          profileId,
          organizationId: scope.organizationId,
        })
        .catch((e) => {
          logger.warn('[ChestnyZnak] own_use after writeoff:', e?.message || e);
        });
    }

    return {
      receipt,
      linesCount: byProduct.size,
    };
  }

  /**
   * Создать документ перемещения: warehouse_receipts document_type transfer (ПМ-xxx), строки, движения transfer
   * @param {object} params
   * @param {number|null} params.organizationId
   * @param {number|string|null} params.fromWarehouseId — склад-источник
   * @param {number|string|null} params.toWarehouseId — склад-получатель
   * @param {Array<{productId: number, quantity: number}>} params.lines
   */
  async createTransfer({
    organizationId = null,
    fromWarehouseId = null,
    toWarehouseId = null,
    lines = [],
  }) {
    if (!lines.length) {
      const err = new Error('Добавьте хотя бы одну позицию в перемещение');
      err.statusCode = 400;
      throw err;
    }

    const scope = requireTransferDocumentScope({
      organizationId,
      fromWarehouseId,
      toWarehouseId,
    });
    await assertWarehouseBelongsToOrganization(scope.fromWarehouseId, scope.organizationId);
    await assertWarehouseBelongsToOrganization(scope.toWarehouseId, scope.organizationId);
    const fromWhId = await this._requireReceiptWarehouseId(scope.fromWarehouseId);
    const toWhId = await this._requireReceiptWarehouseId(scope.toWarehouseId);

    const byProduct = this._normalizeReceiptLines(lines);
    if (!byProduct.size) {
      const err = new Error('Не удалось определить товары в позициях перемещения (productId)');
      err.statusCode = 400;
      throw err;
    }

    for (const [, row] of byProduct) {
      const { productId, quantity } = row;
      const isKit = await isKitProductId(productId);
      let onHand;
      if (isKit) {
        const { computeAvailableQuantity } = await import('./sellableQuantity.service.js');
        const metrics = await computeAvailableQuantity(productId, {
          warehouseId: fromWhId,
          supplierSyncEnabled: false,
        });
        onHand = Math.max(0, Number(metrics.onHand) || 0);
      } else {
        onHand = await readProductWarehouseOnHand(productId, fromWhId);
      }
      if (onHand < quantity) {
        const product = await this.productsRepository.findById(productId);
        const label = product?.sku || product?.name || `#${productId}`;
        const err = new Error(
          isKit
            ? `Недостаточно комплектов на складе-источнике (${label}): нужно ${quantity}, на складе ${onHand}`
            : `Недостаточно товара на складе-источнике (${label}): нужно ${quantity}, доступно ${onHand}`
        );
        err.statusCode = 409;
        throw err;
      }
    }

    const receipt = await this.receiptsRepo.create({
      supplierId: null,
      organizationId: scope.organizationId,
      documentType: 'transfer',
      warehouseId: fromWhId,
      toWarehouseId: toWhId,
    });
    if (!receipt) throw new Error('Не удалось создать документ перемещения');

    const receiptNumber = receipt.receipt_number || `ПМ-${receipt.id}`;
    const movementReason = `Перемещение ${receiptNumber}`;
    const transferId = `tr_doc_${receipt.id}_${Date.now()}`;

    for (const [, row] of byProduct) {
      const { productId, quantity } = row;
      const cost = await this._resolveLineCost(productId, row.cost);

      await this.receiptsRepo.addLine({
        receiptId: receipt.id,
        productId,
        quantity,
        cost: cost != null && cost >= 0 ? cost : null,
      });

      await stockMovementsService.transfer(productId, {
        fromWarehouseId: fromWhId,
        toWarehouseId: toWhId,
        quantity,
        reason: movementReason,
        meta: {
          receipt_id: receipt.id,
          receipt_number: receiptNumber,
          transfer_id: transferId,
          organization_id: scope.organizationId,
          ui: 'warehouse_transfer',
        },
      });
    }

    return {
      receipt,
      linesCount: byProduct.size,
    };
  }

  async getList({
    limit = 100,
    offset = 0,
    profileId = null,
    documentType = null,
    organizationId = null,
    warehouseId = null,
  } = {}) {
    const list = await this.receiptsRepo.findAll({
      limit,
      offset,
      profileId,
      documentType,
      organizationId,
      warehouseId,
    });
    const total = await this.receiptsRepo.count({
      profileId,
      documentType,
      organizationId,
      warehouseId,
    });
    return { list, total };
  }

  async getByIdWithLines(id) {
    const purchasesService = (await import('./purchases.service.js')).default;
    await purchasesService.ensureWarehouseReceiptNotMerged(id);

    const receipt = await this.receiptsRepo.findById(id);
    if (!receipt) return null;
    const lines = await this.receiptsRepo.getLinesWithProducts(id);
    const linkedPr = await query(
      `SELECT pr.id, pr.status, pr.purchase_id
       FROM purchase_receipts pr
       WHERE pr.warehouse_receipt_id = $1
       ORDER BY pr.id DESC
       LIMIT 1`,
      [id]
    );
    const link = linkedPr.rows?.[0] || null;
    const warehouseId = await this._resolveReceiptWarehouseId(id);
    const documentType = this._resolveReceiptDocumentType(receipt);
    const toWarehouseId = await this._resolveReceiptToWarehouseId(id, receipt);
    return {
      ...receipt,
      document_type: documentType,
      lines,
      warehouse_id: warehouseId,
      to_warehouse_id: toWarehouseId,
      purchase_receipt_id: link?.id != null ? Number(link.id) : null,
      purchase_receipt_status: link?.status ?? null,
      purchase_id: link?.purchase_id != null ? Number(link.purchase_id) : null,
    };
  }

  async _reverseReceiptLinesStock(
    receipt,
    lines,
    numId,
    { reasonSuffix = '', skipAlreadyReversedCheck = false } = {}
  ) {
    const isReturnToSupplier = this._resolveReceiptDocumentType(receipt) === 'return';
    const isCustomerReturn = this._resolveReceiptDocumentType(receipt) === 'customer_return';
    const isWriteoff = this._resolveReceiptDocumentType(receipt) === 'writeoff';
    const isTransfer = this._resolveReceiptDocumentType(receipt) === 'transfer';
    const receiptNumber =
      receipt.receipt_number ||
      (isReturnToSupplier
        ? `ВН-${numId}`
        : isCustomerReturn
          ? `ВК-${numId}`
          : isWriteoff
            ? `СП-${numId}`
            : isTransfer
              ? `ПМ-${numId}`
              : `ПТ-${numId}`);
    const suffix = reasonSuffix != null ? String(reasonSuffix) : '';
    const writeoffReasonLabel =
      receipt.writeoff_reason != null && String(receipt.writeoff_reason).trim() !== ''
        ? String(receipt.writeoff_reason).trim()
        : '';
    const reason = isWriteoff
      ? `Аннулирование списания ${receiptNumber}${writeoffReasonLabel ? `: ${writeoffReasonLabel}` : ''}${suffix}`
      : isTransfer
        ? `Аннулирование перемещения ${receiptNumber}${suffix}`
      : isReturnToSupplier
        ? `Аннулирование возврата ${receiptNumber}${suffix}`
        : isCustomerReturn
          ? `Аннулирование возврата от клиента ${receiptNumber}${suffix}`
          : `Аннулирование приёмки ${receiptNumber}${suffix}`;
    if (!skipAlreadyReversedCheck) {
      const stockAlreadyReversed = await this._isReceiptStockAlreadyReversed(numId, receipt);
      if (stockAlreadyReversed) return { stockSkipped: true, reason, receiptNumber };
    }

    const isReceiptEdit = /изменение/i.test(suffix);

    for (const line of lines || []) {
      const productId = line.product_id ?? line.productId;
      const quantity = Math.max(0, parseInt(line.quantity, 10) || 0);
      if (!productId || quantity < 1) continue;

      if (isTransfer) {
        const fromWhId =
          receipt.warehouse_id != null
            ? Number(receipt.warehouse_id)
            : await this._resolveReceiptWarehouseId(numId);
        const toWhId = await this._resolveReceiptToWarehouseId(numId, receipt);
        if (!fromWhId || !toWhId) {
          const err = new Error('Не удалось определить склады для аннулирования перемещения');
          err.statusCode = 400;
          throw err;
        }
        await stockMovementsService.transfer(productId, {
          fromWarehouseId: toWhId,
          toWarehouseId: fromWhId,
          quantity,
          reason,
          meta: {
            receipt_id: numId,
            receipt_number: receiptNumber,
            organization_id: receipt.organization_id ?? receipt.organizationId ?? null,
            transfer_reversal: true,
            deleted: true,
          },
        });
        continue;
      }

      if (
        !isReturnToSupplier &&
        !isCustomerReturn &&
        !isWriteoff &&
        (await isKitProductId(productId)) &&
        (await this._isLegacyKitAssemblyReceipt(numId))
      ) {
        const whId = await this._resolveReceiptWarehouseId(numId);
        await this._reverseLegacyKitAssemblyReceipt({
          kitProductId: productId,
          quantity,
          reason,
          receiptId: numId,
          receiptNumber,
          warehouseId: whId,
        });
        continue;
      }

      // Возврат поставщику и списание уменьшали остаток (−) — откат добавляет (+).
      // Возврат от клиента и приёмка увеличивали остаток (+) — откат уменьшает (−).
      const reverseDelta =
        isReturnToSupplier || isWriteoff ? quantity : -quantity;
      const reverseType = isWriteoff
        ? 'writeoff'
        : isCustomerReturn
          ? 'customer_return'
          : isReturnToSupplier
            ? 'return_to_supplier'
            : 'manual';
      const whId = await this._resolveReceiptWarehouseId(numId);
      const isKit = isWriteoff && (await isKitProductId(productId));
      await stockMovementsService.applyChange(productId, {
        delta: reverseDelta,
        type: reverseType,
        reason,
        meta: {
          receipt_id: numId,
          receipt_number: receiptNumber,
          warehouse_id: whId,
          organization_id: receipt.organization_id ?? receipt.organizationId ?? null,
          deleted: true,
          ...(isWriteoff ? { writeoff_reversal: true } : { receipt_reversal: true }),
          ...(isKit ? { kit_writeoff: true } : {}),
          ...(isReceiptEdit ? { receipt_edit: true } : {}),
        },
      });
    }
    return { stockSkipped: false, reason, receiptNumber };
  }

  async _applyDocumentLinesStock({
    receipt,
    receiptId,
    receiptNumber,
    warehouseId,
    linesByProduct,
    documentType,
    reasonSuffix = '',
  }) {
    const isReturnToSupplier = documentType === 'return';
    const isCustomerReturn = documentType === 'customer_return';
    const suffix = reasonSuffix != null ? String(reasonSuffix) : '';
    const isReceiptEdit = /изменение/i.test(suffix);
    const reason = isReturnToSupplier
      ? `Возврат поставщику ${receiptNumber}${suffix}`
      : isCustomerReturn
        ? `Возврат от клиента ${receiptNumber}${suffix}`
        : `Поступление ${receiptNumber}${suffix}`;

    for (const [, row] of linesByProduct) {
      const { productId, quantity } = row;
      const cost =
        row.cost != null && row.cost !== ''
          ? await this._resolveLineCost(productId, row.cost)
          : await this._resolveLineCost(productId, null);
      const isKit = await isKitProductId(productId);

      if (isReturnToSupplier) {
        let onHand;
        if (isKit) {
          const { computeAvailableQuantity } = await import('./sellableQuantity.service.js');
          const metrics = await computeAvailableQuantity(productId, {
            warehouseId,
            supplierSyncEnabled: false,
          });
          onHand = Math.max(0, Number(metrics.onHand) || 0);
        } else {
          onHand = await readProductWarehouseOnHand(productId, warehouseId);
        }
        if (onHand < quantity) {
          const product = await this.productsRepository.findById(productId);
          const label = product?.sku || product?.name || `#${productId}`;
          const err = new Error(`Недостаточно товара на складе: ${label} (доступно ${onHand}, нужно ${quantity})`);
          err.statusCode = 400;
          throw err;
        }
      }

      await this.receiptsRepo.addLine({
        receiptId,
        productId,
        quantity,
        cost: cost != null && cost >= 0 ? cost : null,
      });

      if (isReturnToSupplier) {
        const extraMeta = {
          receipt_id: receiptId,
          receipt_number: receiptNumber,
          warehouse_id: warehouseId,
        };
        if (!isKit) {
          const kc = await query(
            `SELECT kit_product_id, quantity FROM kit_components WHERE component_product_id = $1 LIMIT 1`,
            [productId]
          );
          if (kc.rows?.[0]?.kit_product_id != null) {
            const perKit = Math.max(1, parseInt(kc.rows[0].quantity, 10) || 1);
            extraMeta.kit_component_return_to_supplier = true;
            extraMeta.kit_product_id = Number(kc.rows[0].kit_product_id);
            extraMeta.kit_assemblable_units_lost = Math.max(1, Math.floor(quantity / perKit));
          }
        }
        await stockMovementsService.applyChange(productId, {
          delta: -quantity,
          type: 'return_to_supplier',
          reason,
          meta: extraMeta,
        });
      } else if (isCustomerReturn) {
        await stockMovementsService.applyChange(productId, {
          delta: quantity,
          type: 'customer_return',
          reason,
          meta: {
            receipt_id: receiptId,
            receipt_number: receiptNumber,
            warehouse_id: warehouseId,
            ...(isKit ? { kit_customer_return: true } : {}),
          },
        });
        if (cost != null && !Number.isNaN(cost) && cost >= 0) {
          await this.productsRepository.update(productId, { cost });
        }
      } else {
        await stockMovementsService.applyChange(productId, {
          delta: quantity,
          type: 'receipt',
          reason,
          meta: {
            receipt_id: receiptId,
            receipt_number: receiptNumber,
            warehouse_id: warehouseId,
            ...(isKit ? { kit_receipt: true } : {}),
            ...(isReceiptEdit ? { receipt_edit: true } : {}),
          },
        });
        if (cost != null && !Number.isNaN(cost) && cost >= 0) {
          await this.productsRepository.update(productId, { cost });
        }
      }
    }
  }

  /**
   * Редактирование приёмки / возврата: откат движений, обновление шапки и строк, повторное проведение.
   */
  async updateReceipt(
    id,
    {
      organizationId = null,
      supplierId = null,
      warehouseId = null,
      lines = [],
      profileId = null,
      purchaseReceiptId = null,
    } = {}
  ) {
    const numId = parseInt(id, 10);
    if (!numId || Number.isNaN(numId)) {
      const err = new Error('Некорректный ID документа');
      err.statusCode = 400;
      throw err;
    }
    if (!Array.isArray(lines) || !lines.length) {
      const err = new Error('Добавьте хотя бы одну позицию');
      err.statusCode = 400;
      throw err;
    }

    const receipt = await this.getByIdWithLines(numId);
    if (!receipt) {
      const err = new Error('Документ не найден');
      err.statusCode = 404;
      throw err;
    }

    const oldWarehouseId = await this._resolveReceiptWarehouseId(numId);

    const linkedPr = await query(
      `SELECT pr.id FROM purchase_receipts pr WHERE pr.warehouse_receipt_id = $1 LIMIT 1`,
      [numId]
    );
    if ((linkedPr.rows?.length ?? 0) > 0) {
      if (receipt.document_type !== 'receipt') {
        const err = new Error('Документ из закупки можно редактировать только как приёмку');
        err.statusCode = 400;
        throw err;
      }
      const purchasesService = (await import('./purchases.service.js')).default;
      await purchasesService.updateWarehouseReceiptLinkedToPurchase(numId, {
        organizationId,
        supplierId,
        warehouseId,
        lines,
        profileId,
        purchaseReceiptId:
          purchaseReceiptId != null
            ? purchaseReceiptId
            : receipt.purchase_receipt_id != null
              ? receipt.purchase_receipt_id
              : null,
      });
      return this.getByIdWithLines(numId);
    }

    const documentType = this._resolveReceiptDocumentType(receipt);
    if (documentType === 'transfer') {
      const err = new Error('Перемещение редактируется отдельным API (укажите склады-источник и получатель)');
      err.statusCode = 400;
      throw err;
    }
    const scope = requireWarehouseDocumentScope({
      documentType,
      organizationId,
      supplierId,
      warehouseId,
    });
    const whId = await this._requireReceiptWarehouseId(scope.warehouseId);
    const byProduct = this._normalizeReceiptLines(lines);
    if (!byProduct.size) {
      const err = new Error('Добавьте хотя бы одну позицию');
      err.statusCode = 400;
      throw err;
    }

    const oldLines = receipt.lines || [];
    const oldByProduct = this._receiptLinesToProductMap(oldLines);
    const warehouseChanged =
      oldWarehouseId != null &&
      whId != null &&
      Number(oldWarehouseId) > 0 &&
      Number(whId) > 0 &&
      Number(oldWarehouseId) !== Number(whId);
    const receiptNumber = receipt.receipt_number || `ПТ-${numId}`;
    const useNetEdit =
      !warehouseChanged && !(await this._editUsesLegacyKitAssembly(numId, oldLines, byProduct));

    await this.receiptsRepo.updateHeader(numId, {
      supplierId: scope.supplierId,
      organizationId: scope.organizationId,
    });
    await this.receiptsRepo.deleteLines(numId);

    if (useNetEdit) {
      await this._applyReceiptEditNetStock({
        receipt,
        receiptId: numId,
        receiptNumber,
        warehouseId: whId,
        oldByProduct,
        newByProduct: byProduct,
        documentType,
      });
    } else {
      const reasonSuffix = warehouseChanged ? ' — изменение (смена склада)' : ' — изменение';
      await this._reverseReceiptLinesStock(receipt, oldLines, numId, {
        reasonSuffix,
        skipAlreadyReversedCheck: true,
      });
      await this._applyDocumentLinesStock({
        receipt,
        receiptId: numId,
        receiptNumber,
        warehouseId: whId,
        linesByProduct: byProduct,
        documentType,
        reasonSuffix,
      });
    }

    return this.getByIdWithLines(numId);
  }

  /**
   * Редактирование перемещения: откат старых движений, обновление маршрута и строк, повторное проведение.
   */
  async updateTransfer(
    id,
    {
      organizationId = null,
      fromWarehouseId = null,
      toWarehouseId = null,
      lines = [],
    } = {}
  ) {
    const numId = parseInt(id, 10);
    if (!numId || Number.isNaN(numId)) {
      const err = new Error('Некорректный ID документа');
      err.statusCode = 400;
      throw err;
    }
    if (!Array.isArray(lines) || !lines.length) {
      const err = new Error('Добавьте хотя бы одну позицию');
      err.statusCode = 400;
      throw err;
    }

    const receipt = await this.getByIdWithLines(numId);
    if (!receipt) {
      const err = new Error('Документ не найден');
      err.statusCode = 404;
      throw err;
    }
    if (this._resolveReceiptDocumentType(receipt) !== 'transfer') {
      const err = new Error('Документ не является перемещением');
      err.statusCode = 400;
      throw err;
    }

    const scope = requireTransferDocumentScope({
      organizationId,
      fromWarehouseId,
      toWarehouseId,
    });
    await assertWarehouseBelongsToOrganization(scope.fromWarehouseId, scope.organizationId);
    await assertWarehouseBelongsToOrganization(scope.toWarehouseId, scope.organizationId);
    const fromWhId = await this._requireReceiptWarehouseId(scope.fromWarehouseId);
    const toWhId = await this._requireReceiptWarehouseId(scope.toWarehouseId);

    const oldFromWhId =
      receipt.warehouse_id != null
        ? Number(receipt.warehouse_id)
        : await this._resolveReceiptWarehouseId(numId);
    const oldToWhId = await this._resolveReceiptToWarehouseId(numId, receipt);
    if (!oldFromWhId || !oldToWhId) {
      const err = new Error('Не удалось определить склады исходного перемещения');
      err.statusCode = 400;
      throw err;
    }

    const byProduct = this._normalizeReceiptLines(lines);
    if (!byProduct.size) {
      const err = new Error('Добавьте хотя бы одну позицию');
      err.statusCode = 400;
      throw err;
    }

    const oldLines = receipt.lines || [];
    const receiptForReverse = {
      ...receipt,
      document_type: 'transfer',
      warehouse_id: oldFromWhId,
      to_warehouse_id: oldToWhId,
    };
    await this._reverseReceiptLinesStock(receiptForReverse, oldLines, numId, {
      reasonSuffix: ' — изменение',
      skipAlreadyReversedCheck: true,
    });

    for (const [, row] of byProduct) {
      const { productId, quantity } = row;
      const isKit = await isKitProductId(productId);
      let onHand;
      if (isKit) {
        const { computeAvailableQuantity } = await import('./sellableQuantity.service.js');
        const metrics = await computeAvailableQuantity(productId, {
          warehouseId: fromWhId,
          supplierSyncEnabled: false,
        });
        onHand = Math.max(0, Number(metrics.onHand) || 0);
      } else {
        onHand = await readProductWarehouseOnHand(productId, fromWhId);
      }
      if (onHand < quantity) {
        const product = await this.productsRepository.findById(productId);
        const label = product?.sku || product?.name || `#${productId}`;
        const err = new Error(
          isKit
            ? `Недостаточно комплектов на складе-источнике (${label}): нужно ${quantity}, на складе ${onHand}`
            : `Недостаточно товара на складе-источнике (${label}): нужно ${quantity}, доступно ${onHand}`
        );
        err.statusCode = 409;
        throw err;
      }
    }

    await this.receiptsRepo.updateHeader(numId, {
      supplierId: null,
      organizationId: scope.organizationId,
      warehouseId: fromWhId,
      toWarehouseId: toWhId,
      documentType: 'transfer',
    });
    await this.receiptsRepo.deleteLines(numId);

    const receiptNumber = receipt.receipt_number || `ПМ-${numId}`;
    const movementReason = `Перемещение ${receiptNumber} — изменение`;
    const transferId = `tr_doc_${numId}_edit_${Date.now()}`;

    for (const [, row] of byProduct) {
      const { productId, quantity } = row;
      const cost = await this._resolveLineCost(productId, row.cost);

      await this.receiptsRepo.addLine({
        receiptId: numId,
        productId,
        quantity,
        cost: cost != null && cost >= 0 ? cost : null,
      });

      await stockMovementsService.transfer(productId, {
        fromWarehouseId: fromWhId,
        toWarehouseId: toWhId,
        quantity,
        reason: movementReason,
        meta: {
          receipt_id: numId,
          receipt_number: receiptNumber,
          transfer_id: transferId,
          organization_id: scope.organizationId,
          receipt_edit: true,
          ui: 'warehouse_transfer',
        },
      });
    }

    return this.getByIdWithLines(numId);
  }

  /**
   * Удалить приёмку или возврат: отменить движения остатков, затем удалить документ.
   * Приёмка: остаток уменьшается на количество по строкам.
   * Возврат: остаток увеличивается на количество по строкам.
   */
  async deleteReceipt(id, { profileId = null } = {}) {
    const numId = parseInt(id, 10);
    if (!numId || Number.isNaN(numId)) return null;

    const linkedPr = await query(
      `SELECT pr.id, p.profile_id
       FROM purchase_receipts pr
       JOIN purchases p ON p.id = pr.purchase_id
       WHERE pr.warehouse_receipt_id = $1
       ORDER BY pr.id DESC`,
      [numId]
    );
    if ((linkedPr.rows?.length ?? 0) > 0) {
      const purchasesService = (await import('./purchases.service.js')).default;
      let lastResult = null;
      for (const row of linkedPr.rows) {
        const effectiveProfileId =
          profileId != null && profileId !== '' ? profileId : row.profile_id ?? null;
        lastResult = await purchasesService.deleteReceipt(row.id, {
          profileId: effectiveProfileId,
        });
      }
      return { deleted: true, id: numId, viaPurchaseReceipt: true, ...(lastResult || {}) };
    }

    const receipt = await this.getByIdWithLines(numId);
    if (!receipt) return null;
    const lines = receipt.lines || (await this.receiptsRepo.getLinesWithProducts(numId));
    const stockAlreadyReversed = await this._isReceiptStockAlreadyReversed(numId, receipt);
    if (!stockAlreadyReversed) {
      await this._reverseReceiptLinesStock(receipt, lines, numId);
    }
    await this.receiptsRepo.delete(numId);
    return { deleted: true, id: numId, stockSkipped: stockAlreadyReversed };
  }
}

export default new WarehouseReceiptsService();
