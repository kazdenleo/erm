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
    require_reserved_stock_for_assembly: isProfileBoolFlag(profile.require_reserved_stock_for_assembly),
    allow_manual_warehouse_stock_edit: isProfileBoolFlag(profile.allow_manual_warehouse_stock_edit),
    allow_stock_history_reset: isProfileBoolFlag(profile.allow_stock_history_reset),
    procurement_status_enabled: profile.procurement_status_enabled !== false,
    kits_enabled: profile.kits_enabled !== false,
    production_enabled: profile.production_enabled !== false,
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
