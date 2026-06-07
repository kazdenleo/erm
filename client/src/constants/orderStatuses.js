/**
 * Подписи статусов заказов (для отображения в UI).
 */
export const orderStatusLabels = {
  new: 'Новый',
  // Технический статус WB до резолва supplierStatus/statuses[] — показываем как «Новый».
  wb_status_unknown: 'Новый',
  /** Очередь сборки / этап WB «На сборке» (supplier confirm) */
  in_assembly: 'На сборке',
  in_procurement: 'В закупке',
  assembled: 'Собран',
  in_transit: 'Отгружен',
  shipped: 'В доставке',
  delivered: 'Доставлен',
  cancelled: 'Отменён'
};

export {
  getOrderProcurementSuppliers,
  getOrderProcurementSupplierName,
  formatProcurementSuppliersLabel,
  procurementSuppliersTitle,
  aggregateProcurementSuppliersFromOrders,
} from '../utils/orderProcurementSuppliers.js';

export function getOrderStatusLabel(status) {
  if (status === 'wb_status_unknown') {
    return orderStatusLabels.wb_status_unknown;
  }
  if (!status || status === 'unknown') {
    return orderStatusLabels.in_assembly;
  }
  if (status === 'wb_assembly') {
    return orderStatusLabels.in_assembly;
  }
  if (status === '__wb_status_pending__') {
    return orderStatusLabels.new;
  }
  return orderStatusLabels[status] || status || '—';
}

/**
 * Можно ли перевести в «В закупке» (согласовано с сервером orders.service).
 * Допускаются «Новый», «На сборке», `unknown` (в UI тоже «На сборке») и у WB — pending/unknown до резолва статуса.
 */
export function isOrderStatusEligibleForProcurement(marketplace, status) {
  const sNorm = String(status ?? '').trim().toLowerCase();
  if (
    sNorm === 'new' ||
    sNorm === 'in_assembly' ||
    sNorm === 'wb_assembly' ||
    sNorm === 'unknown'
  ) {
    return true;
  }
  const sRaw = String(status ?? '').trim();
  const mp = String(marketplace || '').toLowerCase();
  if (mp === 'wb' || mp === 'wildberries') {
    return sRaw === '__wb_status_pending__' || sNorm === 'wb_status_unknown';
  }
  return false;
}

/** Кнопка «Отправить в закупку» — те же статусы, что автозакупка, плюс «В закупке». */
export function isOrderStatusEligibleForSupplierOrder(marketplace, status) {
  if (isOrderStatusEligibleForProcurement(marketplace, status)) return true;
  return String(status ?? '').trim().toLowerCase() === 'in_procurement';
}
