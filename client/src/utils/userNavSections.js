/**
 * Видимость разделов меню (клиент).
 */

export {
  NAV_SECTION_KEYS,
  NAV_SECTION_LABELS,
  NAV_SECTION_GROUPS,
  ROLE_NAV_PRESETS,
  CONFIGURABLE_ACCOUNT_ROLES,
  ACCOUNT_ROLE_LABELS,
  parseNavSections,
  parseRoleNavSections,
  isNavSectionEnabled,
  normalizeNavSections,
  defaultNavSectionsAllEnabled,
  navSectionsToFormState,
  formStateToNavSections,
  roleNavSectionsToFormState,
  resolveNavSectionsForAccountRole,
  navSectionKeyForPath,
} from './userNavSections.shared.js';

export function isNavFeatureEnabled(features, key) {
  if (!key) return true;
  const f = features;
  if (f == null || typeof f !== 'object') return true;
  if (Object.keys(f).length === 0) return true;
  if (key === 'warehouse_return_customer' || key === 'wb_returns') {
    if (f.nav_warehouse_return_customer === false || f.nav_wb_returns === false) return false;
    return true;
  }
  return f[`nav_${key}`] !== false;
}
