import demoUxService from '../services/demoUx.service.js';
import { extendDemoTrial } from '../services/demoUx.service.js';
import repositoryFactory from '../config/repository-factory.js';

async function loadProfile(req) {
  const profileId = req.user?.profileId ?? null;
  if (profileId == null) return null;
  const profilesRepo = repositoryFactory.getProfilesRepository();
  return profilesRepo.findById(profileId);
}

export async function getUx(req, res) {
  const profile = await loadProfile(req);
  const data = await demoUxService.getUxState({ userId: req.user.id, profile });
  return res.json({ ok: true, data });
}

export async function patchUx(req, res) {
  const profile = await loadProfile(req);
  const data = await demoUxService.patchUxProgress({
    userId: req.user.id,
    profile,
    patch: req.body || {},
  });
  return res.json({ ok: true, data });
}

export async function extendDemo(req, res) {
  const profile = await loadProfile(req);
  const data = await extendDemoTrial({ userId: req.user.id, profile });
  return res.json({
    ok: true,
    message: 'Демо продлено на 3 дня',
    data,
  });
}
