/**
 * Фоновые поставки и этикетки после «На сборку» (ручная и авто).
 */

import ordersLabelsService from './orders.labels.service.js';
import shipmentsService from './shipments.service.js';
import ordersService from './orders.service.js';
import repositoryFactory from '../config/repository-factory.js';
import logger from '../utils/logger.js';

const profilesRepo = repositoryFactory.getProfilesRepository();

async function addOrdersToOpenShipmentsForMarketplace(code, list, { profileId, organizationId, warehouseId = null }) {
  const shipmentsUsed = [];
  const warnings = [];
  const openShipment = await shipmentsService.getOrCreateOpenShipment(code, {
    profileId,
    organizationId,
    warehouseId
  });
  const byShipmentId = new Map();
  for (const o of list) {
    const existingShip = await shipmentsService.findLocalShipmentContainingOrder(code, o.orderId, {
      profileId,
      organizationId
    });
    const useShip = existingShip || openShipment;
    if (!byShipmentId.has(useShip.id)) {
      byShipmentId.set(useShip.id, { shipment: useShip, orderIds: [] });
    }
    byShipmentId.get(useShip.id).orderIds.push(o.orderId);
  }
  for (const { shipment, orderIds: oids } of byShipmentId.values()) {
    try {
      const s = await shipmentsService.addOrdersToShipment(shipment.id, oids, { profileId, organizationId });
      shipmentsUsed.push({
        marketplace: code,
        shipmentId: s.id,
        shipmentName: s.name,
        orderIds: oids,
        localWbOnly: s.localWbOnly === true
      });
    } catch (e) {
      if (code === 'ozon' && e?.statusCode === 502) {
        warnings.push({
          marketplace: code,
          shipmentId: shipment.id,
          message: e.message,
          failedOrderIds: Array.isArray(e?.ozonErrors)
            ? e.ozonErrors.map((x) => String(x?.postingNumber || '')).filter(Boolean)
            : []
        });
        continue;
      }
      // WB 409/429/502: заказ уже записан в локальную поставку — не откатываем «На сборку».
      const failed = Array.isArray(e.failedOrderIds) ? e.failedOrderIds.map(String) : [];
      if (e?.shipment || e?.statusCode === 409 || e?.statusCode === 429 || e?.statusCode === 502) {
        warnings.push({
          marketplace: code,
          shipmentId: shipment.id,
          message: e.message,
          failedOrderIds: failed
        });
        continue;
      }
      throw e;
    }
  }
  return { shipmentsUsed, warnings };
}

/** Поставки МП + ручные отгрузки + предзагрузка этикеток — в фоне. */
export async function processAssemblyShipmentsInBackground(orderIds, { profileId, organizationId }) {
  const warnings = [];
  const shipmentsUsed = [];
  const byMarketplace = {};
  const manualRefs = [];
  for (const o of orderIds || []) {
    const mp = (o.marketplace || '').toLowerCase();
    if (mp === 'manual') {
      manualRefs.push({ marketplace: o.marketplace, orderId: String(o.orderId) });
      continue;
    }
    const code = mp === 'wb' ? 'wildberries' : mp;
    if (!['ozon', 'wildberries', 'yandex'].includes(code)) continue;
    if (!byMarketplace[code]) byMarketplace[code] = [];
    byMarketplace[code].push({ marketplace: o.marketplace, orderId: String(o.orderId) });
  }
  for (const [code, list] of Object.entries(byMarketplace)) {
    if (list.length === 0) continue;
    try {
      const batch = await addOrdersToOpenShipmentsForMarketplace(code, list, { profileId, organizationId });
      shipmentsUsed.push(...batch.shipmentsUsed);
      warnings.push(...batch.warnings);
    } catch (e) {
      logger.warn('[sendToAssembly] background shipments failed', {
        marketplace: code,
        message: e?.message || String(e)
      });
      warnings.push({ marketplace: code, message: e?.message || String(e) });
    }
  }

  if (manualRefs.length > 0) {
    const byWarehouse = new Map();
    for (const ref of manualRefs) {
      let warehouseId = null;
      try {
        const order = await ordersService.getByMarketplaceAndOrderId('manual', ref.orderId, { profileId });
        warehouseId = order?.warehouseId ?? order?.warehouse_id ?? null;
        if (warehouseId == null && profileId != null) {
          const prof = await profilesRepo.findById(profileId);
          warehouseId = prof?.manual_orders_warehouse_id ?? null;
        }
      } catch {
        /* best effort */
      }
      const whKey = warehouseId != null ? String(Number(warehouseId)) : 'none';
      if (!byWarehouse.has(whKey)) {
        byWarehouse.set(whKey, { warehouseId, orders: [] });
      }
      byWarehouse.get(whKey).orders.push(ref);
    }
    for (const { warehouseId, orders } of byWarehouse.values()) {
      if (warehouseId == null) {
        warnings.push({
          marketplace: 'manual',
          message: 'Не указан склад для ручного заказа — отгрузка не создана'
        });
        continue;
      }
      try {
        const batch = await addOrdersToOpenShipmentsForMarketplace('manual', orders, {
          profileId,
          organizationId,
          warehouseId
        });
        shipmentsUsed.push(...batch.shipmentsUsed);
        warnings.push(...batch.warnings);
      } catch (e) {
        logger.warn('[sendToAssembly] background manual shipments failed', {
          warehouseId,
          message: e?.message || String(e)
        });
        warnings.push({ marketplace: 'manual', message: e?.message || String(e) });
      }
    }
  }
  try {
    const uniq = [...new Set((orderIds || []).map((o) => (o?.orderId != null ? String(o.orderId) : '')).filter(Boolean))];
    for (const oid of uniq) {
      ordersLabelsService
        .findOrderById(oid)
        .then(async (order) => {
          if (!order) return;
          const mp = String(order.marketplace || '').toLowerCase();
          if (mp === 'manual') return;
          // После ship на Ozon/WB этикетка часто появляется с задержкой — несколько попыток.
          const maxAttempts = mp === 'ozon' || mp === 'wb' ? 4 : 2;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              await ordersLabelsService.ensureLabelFile(order, { organizationId });
              return;
            } catch (e) {
              const status = e?.statusCode;
              const retryable = status === 409 || status === 429 || status === 502 || status === 504;
              if (!retryable || attempt >= maxAttempts) {
                await ordersLabelsService.getLabelStatus(order, { organizationId });
                return;
              }
              await new Promise((r) => setTimeout(r, attempt === 1 ? 3000 : attempt === 2 ? 8000 : 15000));
            }
          }
        })
        .catch(() => {});
    }
  } catch {
    /* best effort */
  }
  if (shipmentsUsed.length || warnings.length) {
    logger.info('[sendToAssembly] background shipments done', {
      shipments: shipmentsUsed.length,
      warnings: warnings.length
    });
  }
}
