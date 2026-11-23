/**
 * Pricing strategies API
 */

import * as pricingStrategyService from '../services/pricingStrategy.service.js';
import logger from '../utils/logger.js';

function profileIdFromReq(req) {
  if (req.user?.role === 'admin' && (req.body?.profileId != null || req.query?.profileId != null)) {
    return Number(req.body.profileId ?? req.query.profileId);
  }
  return req.user?.profileId != null ? Number(req.user.profileId) : null;
}

export const pricingStrategiesController = {
  async list(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      if (profileId) {
        await pricingStrategyService.ensureDefaultStrategies(profileId);
      }
      const list = await pricingStrategyService.listStrategies({ profileId });
      const settings = profileId
        ? await pricingStrategyService.getProfilePricingSettings(profileId)
        : { enabled: true, defaultStrategy: null };
      res.json({ ok: true, data: list, settings });
    } catch (e) {
      next(e);
    }
  },

  async getSettings(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      if (!profileId) {
        return res.status(400).json({ ok: false, message: 'Нет профиля' });
      }
      const settings = await pricingStrategyService.getProfilePricingSettings(profileId);
      res.json({ ok: true, data: settings });
    } catch (e) {
      next(e);
    }
  },

  async updateSettings(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      if (!profileId) {
        return res.status(400).json({ ok: false, message: 'Нет профиля' });
      }
      const enabled =
        req.body?.enabled ??
        req.body?.pricing_strategies_enabled ??
        req.body?.pricingStrategiesEnabled;
      const defaultStrategyId =
        req.body?.defaultStrategyId ??
        req.body?.default_strategy_id ??
        req.body?.defaultStrategy?.id;
      let settings = null;
      if (enabled !== undefined) {
        settings = await pricingStrategyService.setProfilePricingStrategiesEnabled(
          profileId,
          enabled
        );
      }
      if (defaultStrategyId !== undefined) {
        settings = await pricingStrategyService.setProfileDefaultStrategy(
          profileId,
          defaultStrategyId
        );
      }
      if (!settings) {
        return res.status(400).json({
          ok: false,
          message: 'Передайте enabled и/или defaultStrategyId',
        });
      }
      res.json({ ok: true, data: settings });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  },

  async listRules(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      if (!profileId) {
        return res.status(400).json({ ok: false, message: 'Нет профиля' });
      }
      const data = await pricingStrategyService.listStrategyRules({ profileId });
      res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  },

  async upsertRule(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      if (!profileId) {
        return res.status(400).json({ ok: false, message: 'Нет профиля' });
      }
      const body = req.body || {};
      const data = await pricingStrategyService.upsertStrategyRule({
        profileId,
        strategyId: body.strategyId ?? body.strategy_id,
        scopeType: body.scopeType ?? body.scope_type,
        scopeId: body.scopeId ?? body.scope_id,
        marketplace: body.marketplace,
        isActive: body.isActive ?? body.is_active,
      });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  },

  async deleteRule(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      const ok = await pricingStrategyService.deleteStrategyRule(req.params.id, { profileId });
      if (!ok) return res.status(404).json({ ok: false, message: 'Правило не найдено' });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  },

  async getOne(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      const item = await pricingStrategyService.getStrategy(req.params.id);
      if (!item) return res.status(404).json({ ok: false, message: 'Стратегия не найдена' });
      if (
        profileId != null &&
        item.profile_id != null &&
        Number(item.profile_id) !== Number(profileId)
      ) {
        return res.status(404).json({ ok: false, message: 'Стратегия не найдена' });
      }
      const assignments = await pricingStrategyService.getStrategyAssignments(item.id, {
        profileId,
      });
      res.json({ ok: true, data: { ...item, assignments } });
    } catch (e) {
      next(e);
    }
  },

  async create(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      const body = req.body || {};
      const item = await pricingStrategyService.createStrategy(body, { profileId });
      if (body.assignments != null) {
        const assignments = body.assignments || {};
        await pricingStrategyService.replaceStrategyAssignments(
          item.id,
          {
            isDefault: assignments.isDefault ?? assignments.is_default ?? false,
            items: assignments.items || assignments.rules || [],
          },
          { profileId }
        );
      }
      const full = await pricingStrategyService.getStrategy(item.id);
      const assignmentsOut = await pricingStrategyService.getStrategyAssignments(item.id, {
        profileId,
      });
      res.status(201).json({ ok: true, data: { ...full, assignments: assignmentsOut } });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  },

  async update(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      const body = req.body || {};
      const item = await pricingStrategyService.updateStrategy(req.params.id, body);
      if (!item) return res.status(404).json({ ok: false, message: 'Стратегия не найдена' });
      if (
        profileId != null &&
        item.profile_id != null &&
        Number(item.profile_id) !== Number(profileId)
      ) {
        return res.status(404).json({ ok: false, message: 'Стратегия не найдена' });
      }
      if (body.assignments != null) {
        const assignments = body.assignments || {};
        await pricingStrategyService.replaceStrategyAssignments(
          item.id,
          {
            isDefault: assignments.isDefault ?? assignments.is_default ?? false,
            items: assignments.items || assignments.rules || [],
          },
          { profileId }
        );
      }
      const full = await pricingStrategyService.getStrategy(item.id);
      const assignmentsOut = await pricingStrategyService.getStrategyAssignments(item.id, {
        profileId,
      });
      res.json({ ok: true, data: { ...full, assignments: assignmentsOut } });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  },

  async remove(req, res, next) {
    try {
      const ok = await pricingStrategyService.deleteStrategy(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, message: 'Стратегия не найдена' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },

  async defaults(req, res, next) {
    try {
      res.json({
        ok: true,
        data: {
          modes: pricingStrategyService.PRICING_STRATEGY_MODES,
          defaultConfig: {
            floor: pricingStrategyService.defaultStrategyConfig('floor'),
            target_margin: pricingStrategyService.defaultStrategyConfig('target_margin'),
            competitor: pricingStrategyService.defaultStrategyConfig('competitor'),
            sales: pricingStrategyService.defaultStrategyConfig('sales'),
            hybrid: pricingStrategyService.defaultStrategyConfig('hybrid'),
          },
        },
      });
    } catch (e) {
      next(e);
    }
  },

  async recalculateProduct(req, res, next) {
    try {
      const productId = Number(req.body?.productId ?? req.params.productId);
      if (!Number.isFinite(productId) || productId < 1) {
        return res.status(400).json({ ok: false, message: 'Некорректный productId' });
      }
      const result = await pricingStrategyService.recalculateSellingPricesForProduct(productId, {
        marketplace: req.body?.marketplace || null,
      });
      if (!result.ok) {
        return res.status(400).json({ ok: false, message: result.error || 'Ошибка расчёта' });
      }
      res.json({ ok: true, data: result });
    } catch (e) {
      logger.error('[PricingStrategies] recalculateProduct', e);
      next(e);
    }
  },

  async assignProduct(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      const productId = Number(req.body?.productId ?? req.body?.product_id);
      if (!Number.isFinite(productId) || productId < 1) {
        return res.status(400).json({ ok: false, message: 'Некорректный productId' });
      }
      const rawSid = req.body?.strategyId ?? req.body?.strategy_id;
      const strategyId =
        rawSid === null || rawSid === undefined || rawSid === '' || rawSid === 'null'
          ? null
          : Number(rawSid);
      const data = await pricingStrategyService.assignProductPricingStrategy(productId, strategyId, {
        profileId,
        marketplace: req.body?.marketplace || null,
      });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  },

  async preview(req, res, next) {
    try {
      const body = req.body || {};
      const computed = pricingStrategyService.computeSellingPriceFromInputs({
        mode: body.mode || 'hybrid',
        config: body.config,
        floor: body.floor,
        cost: body.cost,
        competitorPrices: body.competitorPrices || [],
        velocity: body.velocity || null,
        previousSelling: body.previousSelling ?? null,
        marketplace: body.marketplace || 'wb',
        ceiling: body.ceiling ?? body.maxPrice ?? body.max_price ?? null,
      });
      res.json({ ok: true, data: computed });
    } catch (e) {
      next(e);
    }
  },

  async priceChanges(req, res, next) {
    try {
      const marketplacePriceChanges = await import('../services/marketplacePriceChanges.service.js');
      // opportunistic prune
      marketplacePriceChanges.pruneMarketplacePriceChanges().catch(() => {});
      const profileId = profileIdFromReq(req);
      const data = await marketplacePriceChanges.listMarketplacePriceChanges({
        days: req.query?.days ?? 30,
        limit: req.query?.limit ?? 150,
        offset: req.query?.offset ?? 0,
        productId: req.query?.productId ?? null,
        marketplace: req.query?.marketplace ?? null,
        search: req.query?.search ?? null,
        profileId,
      });
      res.json({ ok: true, data });
    } catch (e) {
      logger.error('[PricingStrategies] priceChanges', e);
      next(e);
    }
  },
};
