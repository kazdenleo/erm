/**
 * Контекст сессии для axios: аккаунт (profile) и выбранная организация.
 * Обновляется из AuthProvider — перехватчик api.js читает без циклических импортов React.
 */

let accountId = null;
let organizationId = null;

/**
 * @param {{ accountId?: string | number | null, organizationId?: string | number | null }} next
 */
export function setApiSessionContext(next = {}) {
  const a = next.accountId;
  const o = next.organizationId;
  accountId = a != null && a !== '' ? String(a) : null;
  organizationId = o != null && o !== '' ? String(o) : null;
}

export function getApiSessionContext() {
  return { accountId, organizationId };
}
