/**
 * Мультитенантные списки: при отсутствии profile_id у пользователя аккаунта
 * нельзя отдавать все строки таблицы (WHERE без profile_id).
 * Глобальный admin (role=admin без profile_id) — по-прежнему без фильтра.
 */

export const TENANT_LIST_EMPTY = Symbol('TENANT_LIST_EMPTY');

/**
 * @param {import('express').Request} req
 * @returns {null|number|string|typeof TENANT_LIST_EMPTY}
 *   null — нет пользователя или глобальный admin без профиля (без фильтра по профилю);
 *   TENANT_LIST_EMPTY — пользователь без profile_id: список должен быть пустым;
 *   иначе — profileId для фильтра.
 */
export function tenantListProfileId(req) {
  const u = req?.user;
  if (!u) return null;
  if (u.role === 'admin' && (u.profileId == null || u.profileId === '')) {
    return null;
  }
  if (u.profileId == null || u.profileId === '') {
    return TENANT_LIST_EMPTY;
  }
  return u.profileId;
}
