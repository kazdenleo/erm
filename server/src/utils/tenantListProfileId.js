import config from '../config/index.js';

/**
 * Мультитенантные списки: при отсутствии profile_id у пользователя аккаунта
 * нельзя отдавать все строки таблицы (WHERE без profile_id).
 *
 * Глобальный admin (role=admin без profile_id): без фильтра только если включено
 * config.auth.globalAdminUnfilteredLists (в production по умолчанию выключено — иначе видны чужие заказы).
 * Для одного аккаунта на сервере: GLOBAL_ADMIN_UNFILTERED_LISTS=1 в .env
 */

export const TENANT_LIST_EMPTY = Symbol('TENANT_LIST_EMPTY');

/**
 * @param {import('express').Request} req
 * @returns {null|number|string|typeof TENANT_LIST_EMPTY}
 *   null — только супер-админ (role=admin без profile_id) при globalAdminUnfilteredLists=true (без фильтра);
 *   TENANT_LIST_EMPTY — нет пользователя, или супер-админ с выключенным bypass, или user без profile_id;
 *   иначе — profileId для фильтра.
 */
export function tenantListProfileId(req) {
  const u = req?.user;
  // Без пользователя нельзя отдавать «все строки» (раньше null давал отсутствие WHERE profile_id).
  if (!u) return TENANT_LIST_EMPTY;
  if (u.role === 'admin' && (u.profileId == null || u.profileId === '')) {
    return config.auth?.globalAdminUnfilteredLists === true ? null : TENANT_LIST_EMPTY;
  }
  if (u.profileId == null || u.profileId === '') {
    return TENANT_LIST_EMPTY;
  }
  return u.profileId;
}
