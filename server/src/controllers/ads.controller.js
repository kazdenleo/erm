import adsService from '../services/ads/ads.service.js';
import adsAutomationService from '../services/ads/adsAutomation.service.js';
import logger from '../utils/logger.js';

function scopeFromReq(req) {
  return {
    profileId: req.user?.profileId ?? req.profileId ?? null,
    organizationId:
      req.query?.organizationId != null
        ? Number(req.query.organizationId)
        : req.body?.organizationId != null
          ? Number(req.body.organizationId)
          : null,
    userId: req.user?.id ?? req.user?.userId ?? null,
  };
}

class AdsController {
  async dashboard(req, res, next) {
    try {
      const data = await adsService.getDashboard({
        ...scopeFromReq(req),
        marketplace: req.query.marketplace,
        days: req.query.days,
      });
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async sync(req, res, next) {
    try {
      const marketplace = req.body?.marketplace || req.query?.marketplace;
      const days = req.body?.days ?? req.query?.days ?? 14;
      const data = marketplace
        ? await adsService.syncStats(marketplace, { ...scopeFromReq(req), days })
        : await adsService.syncAll({ ...scopeFromReq(req), days });
      res.json({ ok: true, data });
    } catch (e) {
      logger.error('[Ads] sync error', e);
      next(e);
    }
  }

  async testConnection(req, res, next) {
    try {
      const marketplace = req.params.marketplace || req.body?.marketplace;
      const data = await adsService.testConnection(marketplace, scopeFromReq(req));
      res.json({ ok: !!data?.ok, data });
    } catch (e) {
      next(e);
    }
  }

  async listCampaigns(req, res, next) {
    try {
      const data = await adsService.listCampaigns({
        ...scopeFromReq(req),
        marketplace: req.query.marketplace,
      });
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getCampaign(req, res, next) {
    try {
      const data = await adsService.getCampaign(req.params.id, scopeFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async patchCampaign(req, res, next) {
    try {
      const data = await adsService.patchCampaign(req.params.id, req.body || {}, scopeFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async patchCampaignProduct(req, res, next) {
    try {
      const data = await adsService.patchCampaignProduct(
        req.params.id,
        req.params.productId,
        req.body || {},
        scopeFromReq(req)
      );
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async actionLog(req, res, next) {
    try {
      const data = await adsService.listActionLog(scopeFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async listRules(req, res, next) {
    try {
      const data = await adsAutomationService.listRules(scopeFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async createRule(req, res, next) {
    try {
      const data = await adsAutomationService.createRule(req.body || {}, scopeFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async updateRule(req, res, next) {
    try {
      const data = await adsAutomationService.updateRule(
        req.params.id,
        req.body || {},
        scopeFromReq(req)
      );
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async deleteRule(req, res, next) {
    try {
      const data = await adsAutomationService.deleteRule(req.params.id, scopeFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async listAutomationRuns(req, res, next) {
    try {
      const data = await adsAutomationService.listRuns(scopeFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async runRule(req, res, next) {
    try {
      const data = await adsAutomationService.runRule(req.params.id, scopeFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async runAutomation(req, res, next) {
    try {
      const data = await adsAutomationService.runAllEnabled(scopeFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }
}

export default new AdsController();
