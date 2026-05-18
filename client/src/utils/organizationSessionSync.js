/**
 * Синхронизация выбранной организации с аккаунтом (profile): сброс «чужого» id из localStorage.
 */

import { organizationsApi } from '../services/organizations.api.js';
import { getApiSessionContext, setApiSessionContext } from '../services/apiSession.js';

export const STORAGE_ORG_KEY = 'erp_selected_organization_id';

export function readStoredOrganizationId() {
  try {
    const raw = localStorage.getItem(STORAGE_ORG_KEY);
    return raw != null && raw !== '' ? String(raw) : null;
  } catch {
    return null;
  }
}

export function writeStoredOrganizationId(id) {
  try {
    if (id == null || id === '') {
      localStorage.removeItem(STORAGE_ORG_KEY);
    } else {
      localStorage.setItem(STORAGE_ORG_KEY, String(id));
    }
  } catch {
    /* ignore */
  }
}

export function clearStoredOrganizationId() {
  writeStoredOrganizationId(null);
  const { accountId } = getApiSessionContext();
  setApiSessionContext({ accountId, organizationId: null });
}

/**
 * Подобрать организацию для профиля: сохранённая (если доступна) или первая в списке.
 * Запрос /organizations выполняется без X-Organization-Id, чтобы не получить 403 до проверки.
 *
 * @param {number|string|null} profileId
 * @param {string|null} [preferredOrgId]
 * @returns {Promise<string|null>}
 */
export async function resolveOrganizationIdForProfile(profileId, preferredOrgId = null) {
  if (profileId == null || profileId === '') {
    clearStoredOrganizationId();
    return null;
  }

  setApiSessionContext({
    accountId: String(profileId),
    organizationId: null,
  });

  try {
    const res = await organizationsApi.getAll();
    const orgs = Array.isArray(res?.data) ? res.data : [];
    if (orgs.length === 0) {
      clearStoredOrganizationId();
      return null;
    }

    const ids = new Set(orgs.map((o) => String(o.id)));
    const preferred =
      preferredOrgId != null && String(preferredOrgId).trim() !== ''
        ? String(preferredOrgId).trim()
        : null;

    if (preferred && ids.has(preferred)) {
      return preferred;
    }

    return String(orgs[0].id);
  } catch {
    clearStoredOrganizationId();
    return null;
  }
}
