/**
 * Флаг аккаунта: интеграция с поставщиками (настройки, остатки, фоновая синхронизация).
 * @param {object|null|undefined} profile — строка profiles или фрагмент из auth/me
 */
export function isProfileSupplierSyncEnabled(profile) {
  if (profile == null) return true;
  if (profile.supplier_sync_enabled === false) return false;
  if (profile.supplierSyncEnabled === false) return false;
  return true;
}

/** @param {object[]} profiles */
export function filterProfilesWithSupplierSyncEnabled(profiles) {
  return (profiles || []).filter(isProfileSupplierSyncEnabled);
}
