/**
 * Ограничение доступа при истекшем trial / past_due / suspended.
 * Супер-админ (role=admin) не ограничивается.
 */

import config from '../config/index.js';
import repositoryFactory from '../config/repository-factory.js';
import {
  isSubscriptionBypassPath,
  resolveSubscription,
} from '../utils/profileSubscription.js';

const cache = new Map();
const CACHE_TTL_MS = 15_000;

function cacheGet(pid) {
  const hit = cache.get(String(pid));
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(String(pid));
    return null;
  }
  return hit.profile;
}

function cacheSet(pid, profile) {
  cache.set(String(pid), { profile, ts: Date.now() });
}

export function clearSubscriptionAccessCache(profileId = null) {
  if (profileId == null) {
    cache.clear();
    return;
  }
  cache.delete(String(profileId));
}

export async function enforceSubscriptionAccess(req, res, next) {
  try {
    if (config.auth?.disabled) return next();
    const u = req.user;
    if (!u) return next();
    if (u.role === 'admin') return next();

    const pid = u.profileId;
    if (pid == null || pid === '') return next();

    const url = (req.originalUrl || req.url || '').split('?')[0];
    if (isSubscriptionBypassPath(req.method, url)) return next();

    let profile = cacheGet(pid);
    if (!profile) {
      const repo = repositoryFactory.getProfilesRepository();
      profile = repo ? await repo.findById(pid) : null;
      if (profile) cacheSet(pid, profile);
    }

    const sub = resolveSubscription(profile);
    req.subscription = sub;

    if (sub.writeAllowed) return next();

    // past_due / истёкший trial: чтение GET оставляем, мутации режем
    if (sub.status === 'past_due' && req.method === 'GET') {
      return next();
    }

    if (sub.status === 'suspended') {
      return res.status(403).json({
        ok: false,
        code: 'SUBSCRIPTION_SUSPENDED',
        message:
          'Аккаунт приостановлен. Обратитесь в поддержку или дождитесь активации тарифа.',
        subscription: {
          status: sub.status,
          planCode: sub.planCode,
          trialEndsAt: sub.trialEndsAt,
        },
      });
    }

    return res.status(402).json({
      ok: false,
      code: 'SUBSCRIPTION_REQUIRED',
      message:
        'Пробный период закончился. Выберите тариф — оплата пока вручную через поддержку; активацию сделает администратор.',
      subscription: {
        status: sub.status,
        planCode: sub.planCode,
        trialEndsAt: sub.trialEndsAt,
        subscriptionEndsAt: sub.subscriptionEndsAt,
      },
    });
  } catch (e) {
    return next(e);
  }
}
