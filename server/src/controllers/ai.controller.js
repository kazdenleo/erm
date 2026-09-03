import aiAssistantService from '../services/aiAssistant.service.js';
import aiProductCardService from '../services/aiProductCard.service.js';
import aiAttributeEditorService from '../services/aiAttributeEditor.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { aiHttpError } from '../utils/aiSettings.js';

function profileIdFromReq(req) {
  const profileId = tenantListProfileId(req);
  if (profileId === TENANT_LIST_EMPTY || profileId == null) {
    throw aiHttpError('Нет привязки к аккаунту', 403);
  }
  return profileId;
}

export async function getConfig(req, res) {
  const data = await aiAssistantService.getPublicConfig(profileIdFromReq(req));
  return res.json({ ok: true, data });
}

export async function saveConfig(req, res) {
  const data = await aiAssistantService.saveConfig(profileIdFromReq(req), req.body || {});
  return res.json({ ok: true, data });
}

export async function testConnection(req, res) {
  const data = await aiAssistantService.testConnection(profileIdFromReq(req));
  return res.json({ ok: true, data });
}

export async function chat(req, res) {
  const data = await aiAssistantService.chat(profileIdFromReq(req), req.body || {});
  return res.json({ ok: true, data });
}

export async function proposeProductCard(req, res) {
  const data = await aiProductCardService.propose(profileIdFromReq(req), req.body || {});
  return res.json({ ok: true, data });
}

export async function proposeProductCardsBulk(req, res) {
  const data = await aiProductCardService.proposeBulk(profileIdFromReq(req), req.body || {});
  return res.json({ ok: true, data });
}
