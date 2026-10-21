/** Маршруты закупок / приёмок (полноценные страницы, не модалки). */

export function purchaseDetailPath(purchaseId) {
  const id = Number(purchaseId);
  if (!Number.isFinite(id) || id < 1) return '/stock-levels/purchases';
  return `/stock-levels/purchases/${id}`;
}

export function purchaseReceiptPath(purchaseId, receiptId) {
  const pid = Number(purchaseId);
  const rid = Number(receiptId);
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(rid) || rid < 1) {
    return '/stock-levels/purchases';
  }
  return `/stock-levels/purchases/${pid}/receipts/${rid}`;
}

export function purchasesListPath() {
  return '/stock-levels/purchases';
}
