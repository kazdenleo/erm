import { normalizeMarketplaceForUI } from './orderListGroupKey.js';

const MANUAL_WAREHOUSE_RETURN_STATUSES = new Set(['shipped', 'in_transit', 'delivered']);

/** Ручной заказ после отгрузки — можно оформить возврат от клиента на склад. */
export function manualOrderCanAcceptWarehouseReturn(marketplace, status, { shipmentClosed = false } = {}) {
  const mp = normalizeMarketplaceForUI(marketplace);
  if (mp !== 'manual') return false;
  const st = String(status || '').trim().toLowerCase();
  if (MANUAL_WAREHOUSE_RETURN_STATUSES.has(st)) return true;
  // Закрытая отгрузка: остаток списан, статус мог остаться «Собран».
  if (st === 'assembled' && shipmentClosed === true) return true;
  return false;
}

export function isManualMarketplaceOrder(marketplace) {
  return normalizeMarketplaceForUI(marketplace) === 'manual';
}

/** Строка списка заказов из localLines (карточка / модалка). */
export function manualOrderDisplayRowFromLocalLines(localLines, { orderId, warehouseId, orderGroupId } = {}) {
  const lines = Array.isArray(localLines) ? localLines : [];
  if (!lines.length) return null;
  const orders = lines.map((line) => ({
    marketplace: 'manual',
    productId: line.productId ?? line.product_id,
    quantity: line.quantity ?? 1,
    offerId: line.offerId ?? line.marketplaceSku,
    productName: line.productName ?? line.product_name,
    warehouseId: line.warehouseId ?? line.warehouse_id ?? warehouseId ?? null,
    orderGroupId: line.orderGroupId ?? line.order_group_id ?? orderGroupId ?? null,
    orderId: line.orderLineId ?? line.order_line_id ?? orderId ?? null,
  }));
  const first = {
    ...orders[0],
    marketplace: 'manual',
    orderId: orderGroupId || orderId || orders[0]?.orderId,
    orderGroupId: orderGroupId ?? orders[0]?.orderGroupId ?? null,
    warehouseId: warehouseId ?? orders[0]?.warehouseId ?? null,
  };
  return { first, orders };
}

/** Навигация на приёмку возврата: из строки списка или из localLines. */
export function resolveManualOrderReturnNavigationState({
  displayRow = null,
  localLines = null,
  orderId = '',
  warehouseId = null,
  orderGroupId = null,
  organizationId = null,
} = {}) {
  const row =
    displayRow ||
    manualOrderDisplayRowFromLocalLines(localLines, { orderId, warehouseId, orderGroupId });
  if (!row) return null;
  return buildManualOrderReturnNavigationState(row, { organizationId });
}
export function customerReturnLinesFromOrderRows(orders) {
  const byProduct = new Map();
  for (const o of orders || []) {
    const productId = Number(o.productId ?? o.product_id);
    if (!Number.isFinite(productId) || productId < 1) continue;
    const qty = Math.max(1, Number(o.quantity) || 1);
    const sku = String(
      o.offerId ?? o.offer_id ?? o.marketplaceSku ?? o.marketplace_sku ?? o.product_sku ?? o.sku ?? ''
    ).trim();
    const name = String(o.productName ?? o.product_name ?? o.name ?? '').trim();
    const prev = byProduct.get(productId);
    if (prev) {
      prev.quantity += qty;
      continue;
    }
    byProduct.set(productId, {
      productId,
      quantity: qty,
      sku: sku || '—',
      name: name || `Товар #${productId}`,
      cost: '',
    });
  }
  return [...byProduct.values()];
}

/** Состояние навигации в «Склад → Возвраты от клиентов» с предзаполнением из ручного заказа. */
export function buildManualOrderReturnNavigationState(row, { organizationId } = {}) {
  const orders = row?.orders?.length ? row.orders : row?.first ? [row.first] : [];
  const first = orders[0] || row?.first;
  if (!first) return null;
  const lines = customerReturnLinesFromOrderRows(orders);
  if (!lines.length) return null;
  const warehouseRaw = first.warehouseId ?? first.warehouse_id ?? null;
  const warehouseId =
    warehouseRaw != null && warehouseRaw !== '' && Number.isFinite(Number(warehouseRaw))
      ? Number(warehouseRaw)
      : null;
  const orderId = String(
    first.orderGroupId ?? first.order_group_id ?? first.orderId ?? first.order_id ?? ''
  ).trim();
  const orgRaw = organizationId ?? first.organizationId ?? first.organization_id ?? null;
  const orgId =
    orgRaw != null && String(orgRaw).trim() !== '' && Number.isFinite(Number(orgRaw))
      ? Number(orgRaw)
      : null;
  return {
    prefillCustomerReturn: {
      source: 'manual_order',
      marketplace: 'manual',
      orderId,
      warehouseId,
      organizationId: orgId,
      lines,
      scanCode: lines[0]?.sku && lines[0].sku !== '—' ? lines[0].sku : '',
    },
  };
}

/** То же из карточки заказа (localLines + метаданные). */
export function buildManualOrderReturnNavigationStateFromDetail({
  marketplace,
  status,
  orderId,
  localLines,
  warehouseId,
  organizationId,
  orderGroupId,
  displayRow = null,
  shipmentClosed = false,
}) {
  if (!manualOrderCanAcceptWarehouseReturn(marketplace, status, { shipmentClosed })) return null;
  return resolveManualOrderReturnNavigationState({
    displayRow,
    localLines,
    orderId,
    warehouseId,
    orderGroupId,
    organizationId,
  });
}

/** Отмена на МП + в ERM для этих МП и статусов (до отгрузки). */
export function orderCanShowCancel(marketplace, status) {
  const mp = normalizeMarketplaceForUI(marketplace);
  if (!['wildberries', 'ozon', 'yandex', 'manual'].includes(mp)) return false;
  return ['new', 'in_procurement', 'in_assembly', 'assembled', 'wb_assembly'].includes(
    String(status || '').trim().toLowerCase()
  );
}

export function orderDeleteConfirmMessage(marketplace) {
  const mp = normalizeMarketplaceForUI(marketplace);
  const groupHint = 'При заказе с несколькими товарами удалится вся группа.';
  if (mp === 'manual') {
    return `Удалить заказ из системы? ${groupHint} Отмена на маркетплейсе не выполняется.`;
  }
  return (
    `Удалить заказ из ERM? ${groupHint} На маркетплейсе заказ не отменяется. ` +
    'При синхронизации активный заказ на МП может снова появиться в списке.'
  );
}
