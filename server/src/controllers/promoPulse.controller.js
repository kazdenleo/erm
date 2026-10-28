import * as promoPulse from '../services/promoPulse/service.js';
import { listPromoPorts } from '../services/promoPulse/registry.js';

function profileScope(req) {
  let profileId = req.user?.profileId != null ? Number(req.user.profileId) : null;
  if (req.user?.role === 'admin' && (req.body?.profileId != null || req.query?.profileId != null)) {
    profileId = Number(req.body.profileId ?? req.query.profileId);
  }
  return {
    profileId,
    integrationScope: {
      profileId,
      organizationId: req.user?.organizationId ?? null,
    },
  };
}

export const promoPulseController = {
  async ports(req, res, next) {
    try {
      res.json({ ok: true, data: listPromoPorts() });
    } catch (e) {
      next(e);
    }
  },

  async listPolicies(req, res, next) {
    try {
      const scope = profileScope(req);
      await promoPulse.ensureDefaultPolicy(scope);
      const data = await promoPulse.listPolicies(scope);
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  },

  async createPolicy(req, res, next) {
    try {
      const data = await promoPulse.createPolicy(req.body || {}, profileScope(req));
      res.status(201).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  },

  async updatePolicy(req, res, next) {
    try {
      const data = await promoPulse.updatePolicy(req.params.id, req.body || {}, profileScope(req));
      if (!data) return res.status(404).json({ ok: false, error: 'Политика не найдена' });
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  },

  async preview(req, res, next) {
    try {
      const scope = profileScope(req);
      const result = await promoPulse.previewPulse({
        ...scope,
        policyId: req.body?.policyId,
        marketplaces: req.body?.marketplaces,
        forcePhase: req.body?.forcePhase,
      });
      const status = result.ok ? 200 : 400;
      res.status(status).json(result);
    } catch (e) {
      next(e);
    }
  },

  async run(req, res, next) {
    try {
      const scope = profileScope(req);
      const result = await promoPulse.runPulse({
        ...scope,
        policyId: req.body?.policyId,
        marketplaces: req.body?.marketplaces,
        forcePhase: req.body?.forcePhase,
        dryRun: req.body?.dryRun,
      });
      const status = result.ok ? 200 : 400;
      res.status(status).json(result);
    } catch (e) {
      next(e);
    }
  },

  async listRuns(req, res, next) {
    try {
      const data = await promoPulse.listRuns(profileScope(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  },

  async getRun(req, res, next) {
    try {
      const data = await promoPulse.getRun(req.params.id, profileScope(req));
      if (!data) return res.status(404).json({ ok: false, error: 'Прогон не найден' });
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  },

  async listAssignments(req, res, next) {
    try {
      const data = await promoPulse.listAssignments(profileScope(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  },

  async createAssignment(req, res, next) {
    try {
      const data = await promoPulse.createAssignment(req.body || {}, profileScope(req));
      res.status(201).json({ ok: true, data });
    } catch (e) {
      const status = /Укажите|Нет /.test(e.message || '') ? 400 : 500;
      if (status === 400) return res.status(400).json({ ok: false, error: e.message });
      next(e);
    }
  },

  async deleteAssignment(req, res, next) {
    try {
      const ok = await promoPulse.deleteAssignment(req.params.id, profileScope(req));
      if (!ok) return res.status(404).json({ ok: false, error: 'Привязка не найдена' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },

  async listStates(req, res, next) {
    try {
      const data = await promoPulse.listPhaseStates(profileScope(req));
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  },
};
