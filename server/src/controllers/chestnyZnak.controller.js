/**
 * HTTP-контроллер интеграции «Честный знак»
 */

import chestnyZnakService from '../services/chestnyZnak.service.js';
import chestnyZnakDocsService from '../services/chestnyZnakDocs.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

function scopeFromReq(req) {
  const tid = tenantListProfileId(req);
  const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
  const organizationId =
    orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;
  return { profileId: tid, organizationId };
}

function requireTenant(res, profileId) {
  if (profileId === TENANT_LIST_EMPTY) {
    res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
    return false;
  }
  return true;
}

class ChestnyZnakController {
  async getConfig(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakService.getPublicConfig({ profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async saveConfig(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakService.saveConfig(req.body || {}, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async authKey(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakService.fetchAuthKey({ profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async signIn(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakService.signIn(req.body || {}, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async test(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakService.testConnection({ profileId, organizationId });
      return res.status(data.ok ? 200 : 400).json({ ok: data.ok, data });
    } catch (error) {
      next(error);
    }
  }

  async checkCises(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const codes = req.body?.codes ?? req.body?.cis ?? req.body?.text ?? '';
      const data = await chestnyZnakService.checkCises(codes, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async listCis(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakDocsService.listCis(req.query || {}, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async scanCis(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakDocsService.scanCis(req.body || {}, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async listDocuments(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakDocsService.listDocuments(req.query || {}, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async createDocument(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakDocsService.createDocument(req.body || {}, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getDocument(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakDocsService.getDocument(req.params.id, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async signingPayload(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakDocsService.signingPayload(req.params.id, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async markEdoDone(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakDocsService.markEdoDone(req.params.id, { profileId, organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async submitDocument(req, res, next) {
    try {
      const { profileId, organizationId } = scopeFromReq(req);
      if (!requireTenant(res, profileId)) return;
      const data = await chestnyZnakDocsService.submitDocument(
        req.params.id,
        req.body || {},
        { profileId, organizationId }
      );
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }
}

export default new ChestnyZnakController();
