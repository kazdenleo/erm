/**
 * Флаг аккаунта: синхронизация остатков поставщиков.
 * @param {object|null|undefined} profile — строка profiles или фрагмент из auth/me
 */
export function isProfileSupplierSyncEnabled(profile) {
  if (profile == null) return true;
  if (profile.supplier_sync_enabled === false) return false;
  if (profile.supplierSyncEnabled === false) return false;
  return true;
}
