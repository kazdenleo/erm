/**
 * Заявки на тариф (ручная оплата) + аудит подписки.
 */

import * as requestsRepo from '../repositories/subscriptionRequests.repository.pg.js';
import * as auditRepo from '../repositories/subscriptionAudit.repository.pg.js';
import repositoryFactory from '../config/repository-factory.js';
import {
  getSubscriptionPlan,
  PLAN_CODES,
} from '../constants/subscriptionPlans.js';
import {
  buildSubscriptionUpdatePayload,
  resolveSubscription,
} from '../utils/profileSubscription.js';
import { clearSubscriptionAccessCache } from '../middleware/subscriptionAccess.js';
import {
  createRedirectPayment,
  getPayment,
  isYookassaConfigured,
} from './yookassa.service.js';
import {
  sendSubscriptionActivatedEmail,
  sendSubscriptionRequestAdminEmail,
} from './mail.service.js';
import { getLegalParty } from '../constants/legalDocuments.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

function clientPricingUrl() {
  const base = String(config.clientUrl || process.env.CLIENT_URL || 'http://localhost:3000').replace(
    /\/+$/,
    ''
  );
  return `${base}/pricing`;
}

async function notifyAdminNewRequest(row, { plan, period, amountRub, userId, profileId }) {
  try {
    const to = getLegalParty()?.email;
    if (!to || to.includes('example.com')) return;
    let requester = '';
    if (userId) {
      const usersRepo = repositoryFactory.getUsersRepository();
      const u = await usersRepo.findById(userId);
      requester = [u?.full_name, u?.email, u?.phone].filter(Boolean).join(' · ');
    }
    let profileName = row.profile_name;
    if (!profileName && profileId) {
      const profilesRepo = repositoryFactory.getProfilesRepository();
      const p = await profilesRepo.findById(profileId);
      profileName = p?.name || `profile#${profileId}`;
    }
    await sendSubscriptionRequestAdminEmail({
      to,
      profileName: profileName || `profile#${row.profile_id}`,
      planName: plan?.name || row.plan_code,
      periodLabel: period === 'year' ? 'год' : 'месяц',
      amountRub,
      requester,
      comment: row.comment_text,
    });
  } catch (e) {
    logger.warn('[billing] admin request email failed', e?.message || e);
  }
}

async function notifyCustomerActivated(profile, { planName, period, endsAt }) {
  try {
    const to = profile?.contact_email;
    if (!to) return;
    await sendSubscriptionActivatedEmail({
      to,
      fullName: profile.contact_full_name || '',
      accountName: profile.name || '',
      planName,
      periodLabel: period === 'year' ? 'год' : period === 'month' ? 'месяц' : '',
      endsAt,
      pricingUrl: clientPricingUrl(),
    });
  } catch (e) {
    logger.warn('[billing] activation email failed', e?.message || e);
  }
}

function periodAmount(plan, period) {
  if (!plan) return null;
  if (period === 'year') return plan.priceYearRub != null ? Number(plan.priceYearRub) : null;
  return Number(plan.priceMonthRub);
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export async function createSubscriptionRequest({
  profileId,
  userId,
  planCode,
  period = 'month',
  commentText = '',
}) {
  const code = String(planCode || '')
    .trim()
    .toLowerCase();
  if (!PLAN_CODES.includes(code)) {
    const err = new Error('Выберите тариф: start, business или pro');
    err.statusCode = 400;
    throw err;
  }
  const per = String(period || 'month').toLowerCase() === 'year' ? 'year' : 'month';
  const plan = getSubscriptionPlan(code);
  const amountRub = periodAmount(plan, per);

  const existing = await requestsRepo.findPendingByProfile(profileId);
  if (existing) {
    const err = new Error(
      'Уже есть открытая заявка. Дождитесь ответа или отмените текущую.'
    );
    err.statusCode = 409;
    err.data = existing;
    throw err;
  }

  let row;
  try {
    row = await requestsRepo.create({
      profileId,
      userId,
      planCode: code,
      period: per,
      amountRub,
      commentText: String(commentText || '').trim().slice(0, 2000),
    });
  } catch (e) {
    if (String(e?.code) === '23505') {
      const err = new Error('Уже есть открытая заявка');
      err.statusCode = 409;
      throw err;
    }
    throw e;
  }

  await auditRepo.insertAudit({
    profileId,
    actorUserId: userId,
    action: 'request_created',
    toPlanCode: code,
    meta: { requestId: row.id, period: per, amountRub },
  });

  logger.info('[billing] subscription request created', {
    profileId,
    requestId: row.id,
    planCode: code,
    period: per,
  });

  setImmediate(() => {
    notifyAdminNewRequest(row, {
      plan,
      period: per,
      amountRub,
      userId,
      profileId,
    }).catch(() => {});
  });

  return row;
}

export async function listMyRequests(profileId) {
  return requestsRepo.listByProfile(profileId);
}

export async function cancelMyPendingRequest(profileId, userId) {
  const rows = await requestsRepo.cancelPending(profileId, userId);
  if (rows?.[0]) {
    await auditRepo.insertAudit({
      profileId,
      actorUserId: userId,
      action: 'request_cancelled',
      meta: { requestId: rows[0].id },
    });
  }
  return rows;
}

export async function listAdminRequests({ status, limit } = {}) {
  return requestsRepo.listAll({ status, limit });
}

/**
 * Одобрить заявку: активировать тариф на 1 или 12 мес.
 */
export async function approveRequest(requestId, { adminUserId, adminNote } = {}) {
  const req = await requestsRepo.findById(requestId);
  if (!req) {
    const err = new Error('Заявка не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (req.status !== 'pending') {
    const err = new Error('Заявка уже обработана');
    err.statusCode = 400;
    throw err;
  }

  const profilesRepo = repositoryFactory.getProfilesRepository();
  const before = await profilesRepo.findById(req.profile_id);
  const months = req.period === 'year' ? 12 : 1;
  const ends = addMonths(new Date(), months);

  const payload = buildSubscriptionUpdatePayload({
    status: 'active',
    planCode: req.plan_code,
    subscriptionEndsAt: ends.toISOString(),
    applyFeatureFlags: true,
  });

  const updated = await profilesRepo.update(req.profile_id, payload);
  clearSubscriptionAccessCache(req.profile_id);

  const resolved = await requestsRepo.resolve(requestId, {
    status: 'approved',
    adminNote,
    resolvedByUserId: adminUserId,
  });

  await auditRepo.insertAudit({
    profileId: req.profile_id,
    actorUserId: adminUserId,
    action: 'request_approved',
    fromStatus: before?.subscription_status ?? null,
    toStatus: 'active',
    fromPlanCode: before?.plan_code ?? null,
    toPlanCode: req.plan_code,
    meta: {
      requestId,
      period: req.period,
      subscriptionEndsAt: ends.toISOString(),
      adminNote: adminNote || null,
    },
  });

  const plan = getSubscriptionPlan(req.plan_code);
  setImmediate(() => {
    notifyCustomerActivated(updated || before, {
      planName: plan?.name || req.plan_code,
      period: req.period,
      endsAt: ends.toISOString(),
    }).catch(() => {});
  });

  return { request: resolved, profile: updated };
}

export async function rejectRequest(requestId, { adminUserId, adminNote } = {}) {
  const req = await requestsRepo.findById(requestId);
  if (!req) {
    const err = new Error('Заявка не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (req.status !== 'pending') {
    const err = new Error('Заявка уже обработана');
    err.statusCode = 400;
    throw err;
  }
  const resolved = await requestsRepo.resolve(requestId, {
    status: 'rejected',
    adminNote,
    resolvedByUserId: adminUserId,
  });
  await auditRepo.insertAudit({
    profileId: req.profile_id,
    actorUserId: adminUserId,
    action: 'request_rejected',
    meta: { requestId, adminNote: adminNote || null },
  });
  return resolved;
}

export async function recordManualSubscriptionChange({
  profileId,
  actorUserId,
  before,
  after,
}) {
  if (!before || !after) return null;
  const fromStatus = before.subscription_status ?? null;
  const toStatus = after.subscription_status ?? null;
  const fromPlan = before.plan_code ?? null;
  const toPlan = after.plan_code ?? null;
  if (fromStatus === toStatus && fromPlan === toPlan) {
    const fromTrial = before.trial_ends_at ? String(before.trial_ends_at) : null;
    const toTrial = after.trial_ends_at ? String(after.trial_ends_at) : null;
    const fromSub = before.subscription_ends_at
      ? String(before.subscription_ends_at)
      : null;
    const toSub = after.subscription_ends_at
      ? String(after.subscription_ends_at)
      : null;
    if (fromTrial === toTrial && fromSub === toSub) return null;
  }
  return auditRepo.insertAudit({
    profileId,
    actorUserId,
    action: 'admin_update',
    fromStatus,
    toStatus,
    fromPlanCode: fromPlan,
    toPlanCode: toPlan,
    meta: {
      trialEndsAt: after.trial_ends_at ?? null,
      subscriptionEndsAt: after.subscription_ends_at ?? null,
    },
  });
}

export async function getSubscriptionAudit(profileId, opts) {
  return auditRepo.listByProfile(profileId, opts);
}

export function presentRequest(row) {
  if (!row) return row;
  const plan = getSubscriptionPlan(row.plan_code);
  return {
    id: row.id,
    profileId: row.profile_id,
    planCode: row.plan_code,
    planName: plan?.name ?? row.plan_code,
    period: row.period,
    amountRub: row.amount_rub,
    comment: row.comment_text,
    status: row.status,
    adminNote: row.admin_note,
    paymentProvider: row.payment_provider || 'manual',
    paymentStatus: row.payment_status || null,
    confirmationUrl: row.confirmation_url || null,
    externalPaymentId: row.external_payment_id || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    profileName: row.profile_name,
    profileContactEmail: row.profile_contact_email,
    profileContactPhone: row.profile_contact_phone,
    profileSubscriptionStatus: row.profile_subscription_status,
    profilePlanCode: row.profile_plan_code,
    profileTrialEndsAt: row.profile_trial_ends_at,
    requesterEmail: row.requester_email,
    requesterName: row.requester_name,
    requesterPhone: row.requester_phone,
    subscription: resolveSubscription({
      subscription_status: row.profile_subscription_status,
      plan_code: row.profile_plan_code,
      trial_ends_at: row.profile_trial_ends_at,
    }),
  };
}

function paymentReturnUrl() {
  const custom = String(process.env.YOOKASSA_RETURN_URL || '').trim();
  if (custom) return custom;
  const base = String(config.clientUrl || process.env.CLIENT_URL || 'http://localhost:3000').replace(
    /\/+$/,
    ''
  );
  return `${base}/pricing?paid=1`;
}

/**
 * Создать заявку и платёж ЮKassa; вернуть confirmationUrl для редиректа.
 */
export async function createOnlineCheckout({
  profileId,
  userId,
  planCode,
  period = 'month',
}) {
  if (!isYookassaConfigured()) {
    const err = new Error(
      'Онлайн-оплата пока не подключена. Оставьте заявку — активируем после перевода.'
    );
    err.statusCode = 503;
    err.code = 'YOOKASSA_DISABLED';
    throw err;
  }

  const code = String(planCode || '')
    .trim()
    .toLowerCase();
  if (!PLAN_CODES.includes(code)) {
    const err = new Error('Выберите тариф: start, business или pro');
    err.statusCode = 400;
    throw err;
  }
  const per = String(period || 'month').toLowerCase() === 'year' ? 'year' : 'month';
  const plan = getSubscriptionPlan(code);
  const amountRub = periodAmount(plan, per);
  if (amountRub == null || !(amountRub > 0)) {
    const err = new Error('Для тарифа не задана цена');
    err.statusCode = 400;
    throw err;
  }

  const existing = await requestsRepo.findPendingByProfile(profileId);
  if (existing) {
    if (existing.confirmation_url && existing.payment_status === 'pending') {
      return existing;
    }
    const err = new Error(
      'Уже есть открытая заявка. Отмените её или дождитесь активации.'
    );
    err.statusCode = 409;
    err.data = existing;
    throw err;
  }

  const row = await requestsRepo.create({
    profileId,
    userId,
    planCode: code,
    period: per,
    amountRub,
    commentText: 'Онлайн-оплата ЮKassa',
    paymentProvider: 'yookassa',
    paymentStatus: 'pending',
  });

  let payment;
  try {
    payment = await createRedirectPayment({
      amountRub,
      description: `Подписка ${plan.name} (${per === 'year' ? 'год' : 'мес'})`,
      returnUrl: paymentReturnUrl(),
      metadata: {
        requestId: row.id,
        profileId,
        planCode: code,
        period: per,
      },
      idempotenceKey: `subreq-${row.id}`,
    });
  } catch (e) {
    await requestsRepo.resolve(row.id, {
      status: 'cancelled',
      adminNote: `Ошибка создания платежа: ${e?.message || e}`,
      resolvedByUserId: userId,
    });
    throw e;
  }

  const updated = await requestsRepo.updatePaymentFields(row.id, {
    externalPaymentId: payment.id,
    paymentStatus: payment.status || 'pending',
    confirmationUrl: payment.confirmationUrl,
    paymentProvider: 'yookassa',
  });

  await auditRepo.insertAudit({
    profileId,
    actorUserId: userId,
    action: 'payment_created',
    toPlanCode: code,
    meta: {
      requestId: row.id,
      paymentId: payment.id,
      amountRub,
      period: per,
    },
  });

  return updated || { ...row, confirmation_url: payment.confirmationUrl };
}

/**
 * Webhook / сверка: активировать подписку после succeeded.
 */
export async function applySucceededPayment(paymentId, { source = 'webhook' } = {}) {
  const payment = await getPayment(paymentId);
  if (!payment || payment.status !== 'succeeded') {
    return { ok: false, reason: 'not_succeeded', status: payment?.status };
  }

  let req =
    (await requestsRepo.findByExternalPaymentId(paymentId)) ||
    (payment.metadata?.requestId
      ? await requestsRepo.findById(Number(payment.metadata.requestId))
      : null);

  if (!req) {
    logger.warn('[billing] payment succeeded but request not found', { paymentId });
    return { ok: false, reason: 'request_not_found' };
  }

  await requestsRepo.updatePaymentFields(req.id, {
    paymentStatus: 'succeeded',
    externalPaymentId: paymentId,
  });

  if (req.status === 'approved') {
    return { ok: true, already: true, requestId: req.id };
  }
  if (req.status !== 'pending') {
    return { ok: false, reason: 'request_not_pending', status: req.status };
  }

  const out = await approveRequest(req.id, {
    adminUserId: null,
    adminNote: `Оплачено через ЮKassa (${source}), payment ${paymentId}`,
  });

  await auditRepo.insertAudit({
    profileId: req.profile_id,
    action: 'payment_succeeded',
    toStatus: 'active',
    toPlanCode: req.plan_code,
    meta: { requestId: req.id, paymentId, source, amount: payment.amount },
  });

  return { ok: true, requestId: req.id, profile: out.profile };
}

export async function handleYookassaNotification(body) {
  const event = body?.event;
  const obj = body?.object;
  if (!obj?.id) {
    return { ok: false, reason: 'bad_payload' };
  }
  if (event === 'payment.succeeded' || obj.status === 'succeeded') {
    return applySucceededPayment(obj.id, { source: 'webhook' });
  }
  if (event === 'payment.canceled' || obj.status === 'canceled') {
    const req = await requestsRepo.findByExternalPaymentId(obj.id);
    if (req && req.status === 'pending') {
      await requestsRepo.updatePaymentFields(req.id, { paymentStatus: 'canceled' });
    }
    return { ok: true, canceled: true };
  }
  return { ok: true, ignored: true, event };
}

export { isYookassaConfigured };
