/**
 * Флаг аккаунта: использовать статус заказа «В закупке» (in_procurement).
 */
import repositoryFactory from '../config/repository-factory.js';

export function isProfileProcurementStatusEnabled(profile) {
  if (profile == null) return true;
  if (profile.procurement_status_enabled === false) return false;
  if (profile.procurementStatusEnabled === false) return false;
  return true;
}

export async function resolveProfileProcurementStatusEnabled(profileId) {
  const raw = profileId;
  if (raw == null || raw === '') return true;
  const pid = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(pid) || pid < 1) return true;
  const repo = repositoryFactory.getProfilesRepository();
  if (!repo) return true;
  const profile = await repo.findById(pid);
  return isProfileProcurementStatusEnabled(profile);
}
