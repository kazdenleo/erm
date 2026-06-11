/**
 * Флаги аккаунта: комплекты и производство.
 */
import repositoryFactory from '../config/repository-factory.js';

const cache = new Map();
const CACHE_TTL_MS = 30_000;

export function isProfileKitsEnabled(profile) {
  if (profile == null) return true;
  if (profile.kits_enabled === false) return false;
  if (profile.kitsEnabled === false) return false;
  return true;
}

export function isProfileProductionEnabled(profile) {
  if (profile == null) return true;
  if (profile.production_enabled === false) return false;
  if (profile.productionEnabled === false) return false;
  return true;
}

function normalizeProfileId(raw) {
  if (raw == null || raw === '') return null;
  const pid = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export async function loadProfileFeatureFlags(profileId) {
  const pid = normalizeProfileId(profileId);
  if (pid == null) {
    return { kitsEnabled: true, productionEnabled: true };
  }
  const now = Date.now();
  const hit = cache.get(pid);
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.flags;

  const repo = repositoryFactory.getProfilesRepository();
  const profile = repo ? await repo.findById(pid) : null;
  const flags = {
    kitsEnabled: isProfileKitsEnabled(profile),
    productionEnabled: isProfileProductionEnabled(profile),
  };
  cache.set(pid, { flags, ts: now });
  return flags;
}

export async function resolveProfileKitsEnabled(profileId) {
  const { kitsEnabled } = await loadProfileFeatureFlags(profileId);
  return kitsEnabled;
}

export async function resolveProfileProductionEnabled(profileId) {
  const { productionEnabled } = await loadProfileFeatureFlags(profileId);
  return productionEnabled;
}

export function clearProfileFeatureFlagsCache(profileId = null) {
  if (profileId == null) {
    cache.clear();
    return;
  }
  const pid = normalizeProfileId(profileId);
  if (pid != null) cache.delete(pid);
}
