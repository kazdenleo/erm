/**
 * Ежедневная рассылка: trial заканчивается через 1–2 дня.
 * Идемпотентность: subscription_audit_log action=trial_ending_notified + meta.dayKey.
 */

import { query } from '../config/database.js';
import { sendTrialEndingEmail, sendSubscriptionEndingEmail } from './mail.service.js';
import * as auditRepo from '../repositories/subscriptionAudit.repository.pg.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

function dayKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

function clientPricingUrl() {
  const base = String(config.clientUrl || process.env.CLIENT_URL || 'http://localhost:3000').replace(
    /\/+$/,
    ''
  );
  return `${base}/pricing`;
}

export async function runTrialEndingNotifications() {
  const now = new Date();
  const in2d = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const { rows } = await query(
    `SELECT id, name, contact_email, contact_full_name, trial_ends_at
     FROM profiles
     WHERE subscription_status = 'trial'
       AND trial_ends_at IS NOT NULL
       AND trial_ends_at > $1
       AND trial_ends_at <= $2
       AND contact_email IS NOT NULL
       AND btrim(contact_email) <> ''`,
    [now.toISOString(), in2d.toISOString()]
  );

  const key = dayKey(now);
  let scanned = 0;
  let sent = 0;
  let skipped = 0;

  for (const p of rows) {
    scanned += 1;
    const already = await query(
      `SELECT 1 FROM subscription_audit_log
       WHERE profile_id = $1
         AND action = 'trial_ending_notified'
         AND meta->>'dayKey' = $2
       LIMIT 1`,
      [p.id, key]
    );
    if (already.rows.length) {
      skipped += 1;
      continue;
    }

    const mail = await sendTrialEndingEmail({
      to: p.contact_email,
      fullName: p.contact_full_name || '',
      accountName: p.name || '',
      trialEndsAt: p.trial_ends_at,
      pricingUrl: clientPricingUrl(),
    });

    await auditRepo.insertAudit({
      profileId: p.id,
      action: 'trial_ending_notified',
      meta: {
        dayKey: key,
        sent: !!mail.sent,
        reason: mail.reason || null,
        trialEndsAt: p.trial_ends_at,
      },
    });

    if (mail.sent) sent += 1;
    else skipped += 1;
  }

  logger.info('[trialEndingNotify] done', { scanned, sent, skipped });

  const sub = await runSubscriptionEndingNotifications({ now, in2d, key });
  return { scanned, sent, skipped, subscription: sub };
}

/** Оплаченная подписка заканчивается через 1–2 дня. */
export async function runSubscriptionEndingNotifications({
  now = new Date(),
  in2d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  key = dayKey(),
} = {}) {
  const { rows } = await query(
    `SELECT id, name, contact_email, contact_full_name, subscription_ends_at
     FROM profiles
     WHERE subscription_status = 'active'
       AND subscription_ends_at IS NOT NULL
       AND subscription_ends_at > $1
       AND subscription_ends_at <= $2
       AND contact_email IS NOT NULL
       AND btrim(contact_email) <> ''`,
    [now.toISOString(), in2d.toISOString()]
  );

  let scanned = 0;
  let sent = 0;
  let skipped = 0;

  for (const p of rows) {
    scanned += 1;
    const already = await query(
      `SELECT 1 FROM subscription_audit_log
       WHERE profile_id = $1
         AND action = 'subscription_ending_notified'
         AND meta->>'dayKey' = $2
       LIMIT 1`,
      [p.id, key]
    );
    if (already.rows.length) {
      skipped += 1;
      continue;
    }

    const mail = await sendSubscriptionEndingEmail({
      to: p.contact_email,
      fullName: p.contact_full_name || '',
      accountName: p.name || '',
      endsAt: p.subscription_ends_at,
      pricingUrl: clientPricingUrl(),
    });

    await auditRepo.insertAudit({
      profileId: p.id,
      action: 'subscription_ending_notified',
      meta: {
        dayKey: key,
        sent: !!mail.sent,
        reason: mail.reason || null,
        subscriptionEndsAt: p.subscription_ends_at,
      },
    });

    if (mail.sent) sent += 1;
    else skipped += 1;
  }

  logger.info('[subscriptionEndingNotify] done', { scanned, sent, skipped });
  return { scanned, sent, skipped };
}
