import { normalizeMarketplaceForUI } from './orderListGroupKey.js';

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
