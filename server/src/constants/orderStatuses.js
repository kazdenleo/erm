/** Подписи статусов заказов ERM для API и отчётов. */

export const ORDER_STATUS_LABELS = {
  new: 'Новый',
  wb_status_unknown: 'Новый',
  in_assembly: 'На сборке',
  wb_assembly: 'На сборке',
  in_procurement: 'В закупке',
  assembled: 'Собран',
  in_transit: 'Отгружен',
  shipped: 'В доставке',
  delivered: 'Доставлен',
  cancelled: 'Отменён',
  'заказ удалён': 'Заказ удалён'
};

export function getOrderStatusLabel(status) {
  if (status === 'wb_status_unknown') return ORDER_STATUS_LABELS.wb_status_unknown;
  if (!status || status === 'unknown') return ORDER_STATUS_LABELS.in_assembly;
  if (status === 'wb_assembly') return ORDER_STATUS_LABELS.wb_assembly;
  if (status === '__wb_status_pending__') return ORDER_STATUS_LABELS.new;
  return ORDER_STATUS_LABELS[status] || status || '—';
}
