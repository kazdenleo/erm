/**
 * Групповой ручной заказ: order_group_id = manual-…, строки manual-…-2, manual-…-3.
 */

export function getManualOrderGroupKey(orderId) {
  const id = String(orderId ?? '').trim();
  if (!id) return '';
  if (/^manual-\d+-[a-z0-9]+-\d+$/i.test(id)) {
    return id.replace(/-\d+$/i, '');
  }
  return id;
}

export function isManualGroupLineOrderId(orderId, groupKey) {
  const id = String(orderId ?? '').trim();
  const g = String(groupKey ?? '').trim();
  if (!id || !g) return false;
  return id === g || id.startsWith(`${g}-`);
}

/** Оставить только строки marketplace=manual одной группы. */
export function filterManualGroupOrderRows(rows, anchorOrderId) {
  const groupKey = getManualOrderGroupKey(anchorOrderId);
  if (!groupKey) return Array.isArray(rows) ? rows : [];
  return (rows || []).filter((r) => {
    const mp = String(r.marketplace ?? '').toLowerCase();
    if (mp !== 'manual') return false;
    const lineId = String(r.orderId ?? r.order_id ?? '');
    return isManualGroupLineOrderId(lineId, groupKey);
  });
}

export function isManualOrderEditableStatus(status) {
  const s = String(status ?? '').trim().toLowerCase();
  return !s || s === 'new';
}
