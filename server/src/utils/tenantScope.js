/**
 * Жёсткая изоляция тенанта: без profileId не отдаём чужие строки.
 */

import { profileIdFromDb } from './profileId.js';

/**
 * @param {unknown} profileId
 * @param {string} [context]
 * @returns {number}
 */
export function requireTenantProfileId(profileId, context = 'tenant scope') {
  const pid = profileIdFromDb(profileId);
  if (pid == null) {
    const err = new Error(`Требуется profileId (${context})`);
    err.statusCode = 403;
    err.code = 'PROFILE_REQUIRED';
    throw err;
  }
  return pid;
}

/**
 * Fail-closed: без профиля — null (не искать по всей БД).
 * @param {unknown} profileId
 * @returns {number|null}
 */
export function scopedProfileIdOrNull(profileId) {
  return profileIdFromDb(profileId);
}

/**
 * Проверка, что строка принадлежит профилю пользователя.
 * @param {{ profile_id?: unknown, profileId?: unknown }|null|undefined} row
 * @param {unknown} profileId
 * @param {string} [notFoundMessage]
 */
export function assertRowBelongsToProfile(row, profileId, notFoundMessage = 'Не найдено') {
  const pid = requireTenantProfileId(profileId, 'row ownership');
  if (!row) {
    const err = new Error(notFoundMessage);
    err.statusCode = 404;
    throw err;
  }
  const rowPid = row.profile_id ?? row.profileId ?? null;
  if (rowPid != null && String(rowPid) !== String(pid)) {
    const err = new Error(notFoundMessage);
    err.statusCode = 404;
    throw err;
  }
  return row;
}
