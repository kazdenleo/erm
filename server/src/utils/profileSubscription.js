/**
 * Подписка аккаунта: статус, пробный период, доступ к записи.
 */

import {
  TRIAL_DAYS,
  TRIAL_PLAN_CODE,
  getSubscriptionPlan,
  planFeatureFlagsForProfile,
} from '../constants/subscriptionPlans.js';

export function computeTrialEndsAt(fromDate = new Date(), days = TRIAL_DAYS) {
  const d = new Date(fromDate);
  d.setUTCDate(d.getUTCDate() + Number(days) || TRIAL_DAYS);
  return d;
}

export function normalizeSubscriptionStatus(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === 'trial' || s === 'active' || s === 'past_due' || s === 'suspended') return s;
  return 'active';
}

/**
 * Эффективный статус с учётом истечения trial / subscription_ends_at.
 * Не пишет в БД — только вычисление.
 */
export function resolveSubscription(profile) {
  if (!profile) {
    return {
      status: 'suspended',
      planCode: null,
      plan: null,
      trialEndsAt: null,
      subscriptionEndsAt: null,
      effectivePlanCode: null,
      writeAllowed: false,
      readAllowed: false,
      reason: 'no_profile',
    };
  }

  let status = normalizeSubscriptionStatus(
    profile.subscription_status ?? profile.subscriptionStatus
  );
  const planCodeRaw = profile.plan_code ?? profile.planCode ?? null;
  const planCode =
    planCodeRaw != null && String(planCodeRaw).trim() !== ''
      ? String(planCodeRaw).trim().toLowerCase()
      : null;
  const trialEndsAt = profile.trial_ends_at ?? profile.trialEndsAt ?? null;
  const subscriptionEndsAt =
    profile.subscription_ends_at ?? profile.subscriptionEndsAt ?? null;
  const now = Date.now();

  if (status === 'trial' && trialEndsAt) {
    const end = new Date(trialEndsAt).getTime();
    if (Number.isFinite(end) && end < now) {
      status = 'past_due';
    }
  }

  if (status === 'active' && subscriptionEndsAt) {
    const end = new Date(subscriptionEndsAt).getTime();
    if (Number.isFinite(end) && end < now) {
      status = 'past_due';
    }
  }

  const effectivePlanCode =
    status === 'trial' ? planCode || TRIAL_PLAN_CODE : planCode;
  const plan = getSubscriptionPlan(effectivePlanCode);

  const writeAllowed = status === 'trial' || status === 'active';
  const readAllowed = status !== 'suspended';

  return {
    status,
    planCode,
    plan,
    trialEndsAt: trialEndsAt ? new Date(trialEndsAt).toISOString() : null,
    subscriptionEndsAt: subscriptionEndsAt
      ? new Date(subscriptionEndsAt).toISOString()
      : null,
    effectivePlanCode,
    writeAllowed,
    readAllowed,
    reason: writeAllowed ? null : status,
  };
}

/** Поля для /auth/me и UI. */
export function subscriptionPayloadForClient(profile) {
  const sub = resolveSubscription(profile);
  return {
    status: sub.status,
    planCode: sub.planCode,
    effectivePlanCode: sub.effectivePlanCode,
    planName: sub.plan?.name ?? null,
    trialEndsAt: sub.trialEndsAt,
    subscriptionEndsAt: sub.subscriptionEndsAt,
    writeAllowed: sub.writeAllowed,
    readAllowed: sub.readAllowed,
    features: sub.plan?.features ?? null,
    limits: sub.plan
      ? {
          maxUsers: sub.plan.maxUsers,
          maxOrganizations: sub.plan.maxOrganizations,
          maxMpCabinets: sub.plan.maxMpCabinets,
          maxProducts: sub.plan.maxProducts,
        }
      : null,
    trialDays: TRIAL_DAYS,
  };
}

/** Значения для INSERT нового аккаунта (self-serve trial). */
export function newAccountTrialFields() {
  const trialEndsAt = computeTrialEndsAt();
  const flags = planFeatureFlagsForProfile(TRIAL_PLAN_CODE);
  return {
    subscription_status: 'trial',
    plan_code: TRIAL_PLAN_CODE,
    trial_ends_at: trialEndsAt.toISOString(),
    subscription_ends_at: null,
    ...flags,
  };
}

/**
 * Обновление подписки платформенным админом.
 * @returns {object} поля для profiles.update
 */
export function buildSubscriptionUpdatePayload({
  status,
  planCode,
  trialEndsAt,
  subscriptionEndsAt,
  applyFeatureFlags = true,
} = {}) {
  const out = {};
  if (status !== undefined) {
    out.subscription_status = normalizeSubscriptionStatus(status);
  }
  if (planCode !== undefined) {
    const code =
      planCode == null || String(planCode).trim() === ''
        ? null
        : String(planCode).trim().toLowerCase();
    if (code && !getSubscriptionPlan(code)) {
      const err = new Error('Неизвестный тариф (start, business, pro)');
      err.statusCode = 400;
      throw err;
    }
    out.plan_code = code;
  }
  if (trialEndsAt !== undefined) {
    out.trial_ends_at =
      trialEndsAt == null || trialEndsAt === ''
        ? null
        : new Date(trialEndsAt).toISOString();
  }
  if (subscriptionEndsAt !== undefined) {
    out.subscription_ends_at =
      subscriptionEndsAt == null || subscriptionEndsAt === ''
        ? null
        : new Date(subscriptionEndsAt).toISOString();
  }

  const codeForFlags = out.plan_code !== undefined ? out.plan_code : planCode;
  if (
    applyFeatureFlags &&
    codeForFlags &&
    getSubscriptionPlan(codeForFlags) &&
    (out.subscription_status === 'active' ||
      out.subscription_status === 'trial' ||
      status === undefined)
  ) {
    Object.assign(out, planFeatureFlagsForProfile(codeForFlags));
  }
  return out;
}

/** Пути API, доступные при past_due / suspended (чтение сессии, поддержка, биллинг). */
export function isSubscriptionBypassPath(method, urlPath) {
  const m = String(method || 'GET').toUpperCase();
  const path = String(urlPath || '').split('?')[0];
  if (m === 'GET' && path.startsWith('/api/auth/me')) return true;
  if (m === 'POST' && path.startsWith('/api/auth/logout')) return true;
  if (m === 'POST' && path.startsWith('/api/auth/change-password')) return true;
  if (m === 'GET' && path === '/api/users/me') return true;
  if (path.startsWith('/api/billing')) return true;
  if (path.startsWith('/api/inquiries')) return true;
  if (m === 'GET' && (path === '/api/profiles/me' || path.startsWith('/api/profiles/me/'))) {
    return true;
  }
  // Платформа / супер-админ роуты не режем здесь — у admin нет profile или role=admin
  if (path.startsWith('/api/platform')) return true;
  if (path.startsWith('/api/hooks/')) return true;
  return false;
}
