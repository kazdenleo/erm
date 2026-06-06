/**
 * Расчёт дефицита для закупки после резерва и уже созданных закупок.
 */

export function computeProcurementDeficit({
  quantityNeeded = 0,
  quantityReserved = 0,
  quantityPurchased = 0,
} = {}) {
  const need = Math.max(0, Math.floor(Number(quantityNeeded) || 0));
  const reserved = Math.max(0, Math.floor(Number(quantityReserved) || 0));
  const purchased = Math.max(0, Math.floor(Number(quantityPurchased) || 0));
  const covered = Math.min(need, reserved + purchased);
  const deficit = Math.max(0, need - covered);
  const reservedApplied = Math.min(need, reserved);
  const purchasedApplied = Math.min(Math.max(0, need - reservedApplied), purchased);

  return {
    need,
    reserved: reservedApplied,
    purchased: purchasedApplied,
    covered,
    deficit,
  };
}

/** Статус строки покрытия по количествам. */
export function fulfillmentLineStatusFromQuantities({ need, reserved, purchased, deficit, manual }) {
  if (manual) return 'manual_required';
  if (deficit <= 0 && need > 0) {
    if (purchased > 0 && reserved > 0) return 'partial';
    if (purchased >= need) return 'purchased';
    return 'reserved';
  }
  if (reserved > 0 || purchased > 0) return 'partial';
  return 'pending';
}
