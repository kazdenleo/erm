/**
 * Лимиты тарифа аккаунта (users / organizations / cabinets / products).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { resolveSubscription } from './profileSubscription.js';
import { getSubscriptionPlan, TRIAL_PLAN_CODE } from '../constants/subscriptionPlans.js';

function limitError(message) {
  const err = new Error(message);
  err.statusCode = 403;
  err.code = 'PLAN_LIMIT';
  return err;
}

export async function getEffectivePlanForProfile(profileId) {
  if (profileId == null || profileId === '') return null;
  const repo = repositoryFactory.getProfilesRepository();
  const profile = await repo.findById(profileId);
  if (!profile) return null;
  const sub = resolveSubscription(profile);
  const code = sub.effectivePlanCode || TRIAL_PLAN_CODE;
  return getSubscriptionPlan(code);
}

async function countUsers(profileId) {
  const r = await query(
    `SELECT COUNT(*)::int AS cnt FROM users WHERE profile_id = $1`,
    [profileId]
  );
  return r.rows[0]?.cnt ?? 0;
}

async function countOrganizations(profileId) {
  const r = await query(
    `SELECT COUNT(*)::int AS cnt FROM organizations WHERE profile_id = $1`,
    [profileId]
  );
  return r.rows[0]?.cnt ?? 0;
}

async function countCabinets(profileId) {
  const r = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM marketplace_cabinets mc
     JOIN organizations o ON o.id = mc.organization_id
     WHERE o.profile_id = $1`,
    [profileId]
  );
  return r.rows[0]?.cnt ?? 0;
}

async function countProducts(profileId) {
  const r = await query(
    `SELECT COUNT(*)::int AS cnt FROM products WHERE profile_id = $1`,
    [profileId]
  );
  return r.rows[0]?.cnt ?? 0;
}

/**
 * @param {'users'|'organizations'|'cabinets'|'products'} kind
 */
export async function assertPlanAllowsCreate(profileId, kind) {
  if (profileId == null || profileId === '') return;
  const plan = await getEffectivePlanForProfile(profileId);
  if (!plan) return;

  const map = {
    users: { max: plan.maxUsers, count: countUsers, label: 'пользователей' },
    organizations: {
      max: plan.maxOrganizations,
      count: countOrganizations,
      label: 'организаций',
    },
    cabinets: {
      max: plan.maxMpCabinets,
      count: countCabinets,
      label: 'кабинетов маркетплейсов',
    },
    products: { max: plan.maxProducts, count: countProducts, label: 'товаров' },
  };
  const spec = map[kind];
  if (!spec) return;
  if (spec.max == null) return; // безлимит

  const used = await spec.count(profileId);
  if (used >= Number(spec.max)) {
    throw limitError(
      `Лимит тарифа «${plan.name}»: не больше ${spec.max} ${spec.label}. Выберите тариф выше на странице «Тарифы».`
    );
  }
}

export async function getPlanUsage(profileId) {
  const plan = await getEffectivePlanForProfile(profileId);
  if (!plan || profileId == null) {
    return { plan: null, usage: null };
  }
  const [users, organizations, cabinets, products] = await Promise.all([
    countUsers(profileId),
    countOrganizations(profileId),
    countCabinets(profileId),
    countProducts(profileId),
  ]);
  return {
    plan: {
      code: plan.code,
      name: plan.name,
      maxUsers: plan.maxUsers,
      maxOrganizations: plan.maxOrganizations,
      maxMpCabinets: plan.maxMpCabinets,
      maxProducts: plan.maxProducts,
      features: plan.features,
    },
    usage: { users, organizations, cabinets, products },
  };
}

/**
 * Не даём владельцу аккаунта включить модули, которых нет в тарифе.
 * Выключать модули можно всегда. Возвращает { payload, rejected[] }.
 */
export function clampFeatureFlagsToPlan(payload, plan) {
  if (!payload || !plan?.features) {
    return { payload, rejected: [] };
  }
  const f = plan.features;
  const next = { ...payload };
  const rejected = [];

  const denyIfOn = (field, allowed) => {
    if (next[field] === true && !allowed) {
      delete next[field];
      rejected.push(field);
    }
  };

  denyIfOn('kits_enabled', f.kits !== false);
  denyIfOn('production_enabled', f.production === true);
  denyIfOn('fbo_enabled', f.fbo === true);
  denyIfOn('pricing_strategies_enabled', f.prices !== false);

  return { payload: next, rejected };
}
