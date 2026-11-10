/**
 * Гейт модулей по тарифу (ads, ai, fbo, kits, production, …).
 */

import config from '../config/index.js';
import repositoryFactory from '../config/repository-factory.js';
import {
  planHasFeature,
  resolveSubscription,
} from '../utils/profileSubscription.js';

/**
 * @param {string} featureKey — ключ из subscriptionPlans.features
 * @param {{ label?: string }} [opts]
 */
export function requirePlanFeature(featureKey, opts = {}) {
  const label = opts.label || featureKey;
  return async function planFeatureMiddleware(req, res, next) {
    try {
      if (config.auth?.disabled) return next();
      const u = req.user;
      if (!u) return next();
      if (u.role === 'admin') return next();

      let sub = req.subscription;
      if (!sub) {
        const pid = u.profileId;
        if (pid == null || pid === '') return next();
        const repo = repositoryFactory.getProfilesRepository();
        const profile = repo ? await repo.findById(pid) : null;
        sub = resolveSubscription(profile);
        req.subscription = sub;
      }

      if (planHasFeature(sub, featureKey)) return next();

      return res.status(403).json({
        ok: false,
        code: 'PLAN_FEATURE',
        message: `Модуль «${label}» недоступен на текущем тарифе. Выберите тариф выше на странице «Тарифы».`,
        feature: featureKey,
        subscription: {
          status: sub.status,
          planCode: sub.effectivePlanCode || sub.planCode,
          planName: sub.plan?.name ?? null,
        },
      });
    } catch (e) {
      return next(e);
    }
  };
}
