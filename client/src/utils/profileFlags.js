/** Булевы флаги профиля из API (PostgreSQL / JSON могут отдавать разные типы). */
export function isProfileBoolFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function accountSettingsFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    name: profile.name ?? '',
    contact_email: profile.contact_email ?? '',
    contact_phone: profile.contact_phone ?? '',
    allow_private_orders: isProfileBoolFlag(profile.allow_private_orders),
    manual_orders_warehouse_id:
      profile.manual_orders_warehouse_id != null && profile.manual_orders_warehouse_id !== ''
        ? String(profile.manual_orders_warehouse_id)
        : profile.manualOrdersWarehouseId != null && profile.manualOrdersWarehouseId !== ''
          ? String(profile.manualOrdersWarehouseId)
          : '',
    fbo_enabled: isProfileBoolFlag(profile.fbo_enabled ?? profile.fboEnabled),
    fbo_deduction_warehouse_id:
      profile.fbo_deduction_warehouse_id != null && profile.fbo_deduction_warehouse_id !== ''
        ? String(profile.fbo_deduction_warehouse_id)
        : profile.fboDeductionWarehouseId != null && profile.fboDeductionWarehouseId !== ''
          ? String(profile.fboDeductionWarehouseId)
          : '',
    require_reserved_stock_for_assembly: isProfileBoolFlag(profile.require_reserved_stock_for_assembly),
    auto_send_to_assembly_on_reserve: isProfileBoolFlag(profile.auto_send_to_assembly_on_reserve),
    allow_manual_warehouse_stock_edit: isProfileBoolFlag(profile.allow_manual_warehouse_stock_edit),
    allow_stock_history_reset: isProfileBoolFlag(profile.allow_stock_history_reset),
    procurement_status_enabled: profile.procurement_status_enabled !== false,
    kits_enabled: profile.kits_enabled !== false,
    production_enabled: profile.production_enabled !== false,
    allow_product_supplier_binding: isProfileBoolFlag(
      profile.allow_product_supplier_binding ?? profile.allowProductSupplierBinding
    ),
  };
}

/** Статус заказа «В закупке» включён (по умолчанию да). */
export function isProfileProcurementStatusEnabled(profile) {
  if (profile == null) return true;
  return profile.procurement_status_enabled !== false;
}

/** Комплекты включены (по умолчанию да). */
export function isProfileKitsEnabled(profile) {
  if (profile == null) return true;
  return profile.kits_enabled !== false;
}

/** Раздел «Производство» включён (по умолчанию да). */
export function isProfileProductionEnabled(profile) {
  if (profile == null) return true;
  return profile.production_enabled !== false;
}

/** Поставки FBO включены в настройках аккаунта. */
export function isProfileFboEnabled(profile) {
  if (profile == null) return false;
  return isProfileBoolFlag(profile.fbo_enabled ?? profile.fboEnabled);
}

/** Привязка товаров к поставщику включена (по умолчанию нет). */
export function isProfileProductSupplierBindingEnabled(profile) {
  if (profile == null) return false;
  return isProfileBoolFlag(
    profile.allow_product_supplier_binding ?? profile.allowProductSupplierBinding
  );
}
