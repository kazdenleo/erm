/**
 * Флаг аккаунта: привязка товаров к поставщику.
 */
export function isProfileProductSupplierBindingEnabled(profile) {
  if (profile == null) return false;
  if (profile.allow_product_supplier_binding === true) return true;
  if (profile.allowProductSupplierBinding === true) return true;
  if (profile.allow_product_supplier_binding === 'true' || profile.allow_product_supplier_binding === '1') {
    return true;
  }
  if (profile.allowProductSupplierBinding === 'true' || profile.allowProductSupplierBinding === '1') {
    return true;
  }
  return false;
}
