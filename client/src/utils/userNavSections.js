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
  // wb_returns — устаревший раздел; не должен скрывать «Возвраты от клиентов»
  if (key === 'assembly') {
    return f.nav_assembly !== false;
  }
  return f[`nav_${key}`] !== false;
}
