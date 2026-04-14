/**
 * Подписи статусов заказов (для отображения в UI).
 */
export const orderStatusLabels = {
  new: 'Новый',
  wb_status_unknown: 'WB: статус не получен',
  /** Очередь сборки / этап WB «На сборке» (supplier confirm) */
  in_assembly: 'На сборке',
  in_procurement: 'В закупке',
  assembled: 'Собран',
  in_transit: 'В доставке',
  shipped: 'Отгружен',
  delivered: 'Доставлен',
  cancelled: 'Отменён'
};

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
    return orderStatusLabels.wb_status_unknown;
  }
  return orderStatusLabels[status] || status || '—';
}

/**
 * Можно ли перевести в «В закупке» (согласовано с сервером orders.service).
 * Для WB строка может быть ещё в pending/unknown, пока не пришёл финальный «Новый» из синка.
 */
export function isOrderStatusEligibleForProcurement(marketplace, status) {
  const sNorm = String(status ?? '').trim().toLowerCase();
  if (sNorm === 'new') return true;
  const sRaw = String(status ?? '').trim();
  const mp = String(marketplace || '').toLowerCase();
  if (mp === 'wb' || mp === 'wildberries') {
    return sRaw === '__wb_status_pending__' || sNorm === 'wb_status_unknown';
  }
  return false;
}
