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
      if (enabled === undefined) {
        return res.status(400).json({ ok: false, message: 'Передайте enabled: true|false' });
      }
      const settings = await pricingStrategyService.setProfilePricingStrategiesEnabled(
        profileId,
        enabled
      );
      res.json({ ok: true, data: settings });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  },

  async getOne(req, res, next) {
    try {
      const item = await pricingStrategyService.getStrategy(req.params.id);
      if (!item) return res.status(404).json({ ok: false, message: 'Стратегия не найдена' });
      res.json({ ok: true, data: item });
    } catch (e) {
      next(e);
    }
  },

  async create(req, res, next) {
    try {
      const profileId = profileIdFromReq(req);
      const item = await pricingStrategyService.createStrategy(req.body || {}, { profileId });
      res.status(201).json({ ok: true, data: item });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  },

  async update(req, res, next) {
    try {
      const item = await pricingStrategyService.updateStrategy(req.params.id, req.body || {});
      if (!item) return res.status(404).json({ ok: false, message: 'Стратегия не найдена' });
      res.json({ ok: true, data: item });
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
      });
      res.json({ ok: true, data: computed });
    } catch (e) {
      next(e);
    }
  },
};
