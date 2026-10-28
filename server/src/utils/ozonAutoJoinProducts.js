/**
 * Флаг «объединять товары автоматически» (Join SKU / attr 9048) в config кабинета Ozon.
 */

export const OZON_JOIN_SKU_ATTR_ID = 9048;
export const OZON_BRAND_ATTR_ID = 85;

export function isOzonAutoJoinProductsEnabled(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const v = cfg.ozon_auto_join_products ?? cfg.ozonAutoJoinProducts;
  return v === true || v === 'true' || v === '1' || v === 1;
}

export { pickOzonCredentials } from './ozonAutoPromotions.js';
