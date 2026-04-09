/**
 * Эффективный аккаунт (profile_id), если в users.profile_id пусто:
 * 1) профиль выбранной организации (заголовок X-Organization-Id с клиента);
 * 2) профиль из последнего обращения этого пользователя.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { profileIdFromDb } from './profileId.js';

const orgRepo = repositoryFactory.getOrganizationsRepository();

/**
 * @param {import('express').Request} req
 * @param {{ profile_id?: unknown }} userRow строка users
 */
export async function resolveEffectiveProfileId(req, userRow) {
  if (!userRow) return null;
  let pid = profileIdFromDb(userRow.profile_id);
  if (pid != null) return pid;

  /** Без profile_id в users: профиль из выбранной организации или из последнего обращения (не путать с админом аккаунта — у него в БД должен быть profile_id при role=user). */
  const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
  if (orgHeader != null && String(orgHeader).trim() !== '') {
    const org = await orgRepo.findById(String(orgHeader).trim());
    if (org?.profile_id != null) {
      pid = profileIdFromDb(org.profile_id);
      if (pid != null) return pid;
    }
  }

  const r = await query(
    `SELECT profile_id FROM support_inquiries WHERE author_user_id = $1 ORDER BY id DESC LIMIT 1`,
    [req.user.id]
  );
  if (r.rows[0]?.profile_id != null) {
    return profileIdFromDb(r.rows[0].profile_id);
  }
  return null;
}
