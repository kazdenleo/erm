/**
 * Флаг аккаунта: модуль обогащения карточек (PartsAPI).
 * @param {object|null|undefined} profile
 */
export function isProfileProductEnrichmentEnabled(profile) {
  if (profile == null) return false;
  if (profile.product_enrichment_enabled === true) return true;
  if (profile.productEnrichmentEnabled === true) return true;
  if (profile.product_enrichment_enabled === 'true' || profile.product_enrichment_enabled === 1) {
    return true;
  }
  if (profile.productEnrichmentEnabled === 'true' || profile.productEnrichmentEnabled === 1) {
    return true;
  }
  return false;
}
