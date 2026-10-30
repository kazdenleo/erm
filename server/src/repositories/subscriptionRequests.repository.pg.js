import { query } from '../config/database.js';

const SELECT_LIST = `
  sr.id, sr.profile_id, sr.requested_by_user_id, sr.plan_code, sr.period,
  sr.amount_rub, sr.comment_text, sr.status, sr.admin_note,
  sr.payment_provider, sr.external_payment_id, sr.payment_status, sr.confirmation_url,
  sr.resolved_by_user_id, sr.resolved_at, sr.created_at, sr.updated_at,
  p.name AS profile_name,
  p.contact_email AS profile_contact_email,
  p.contact_phone AS profile_contact_phone,
  p.subscription_status AS profile_subscription_status,
  p.plan_code AS profile_plan_code,
  p.trial_ends_at AS profile_trial_ends_at,
  u.email AS requester_email,
  u.full_name AS requester_name,
  u.phone AS requester_phone
`;

const FROM_JOIN = `
  FROM subscription_requests sr
  JOIN profiles p ON p.id = sr.profile_id
  LEFT JOIN users u ON u.id = sr.requested_by_user_id
`;

export async function create({
  profileId,
  userId,
  planCode,
  period,
  amountRub,
  commentText,
  paymentProvider = 'manual',
  externalPaymentId = null,
  paymentStatus = null,
  confirmationUrl = null,
}) {
  const result = await query(
    `INSERT INTO subscription_requests
       (profile_id, requested_by_user_id, plan_code, period, amount_rub, comment_text, status,
        payment_provider, external_payment_id, payment_status, confirmation_url)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10)
     RETURNING *`,
    [
      profileId,
      userId ?? null,
      planCode,
      period,
      amountRub ?? null,
      commentText || null,
      paymentProvider || 'manual',
      externalPaymentId,
      paymentStatus,
      confirmationUrl,
    ]
  );
  return result.rows[0] || null;
}

export async function findByExternalPaymentId(externalPaymentId) {
  if (!externalPaymentId) return null;
  const result = await query(
    `SELECT ${SELECT_LIST} ${FROM_JOIN} WHERE sr.external_payment_id = $1 LIMIT 1`,
    [String(externalPaymentId)]
  );
  return result.rows[0] || null;
}

export async function updatePaymentFields(id, {
  externalPaymentId,
  paymentStatus,
  confirmationUrl,
  paymentProvider,
}) {
  const result = await query(
    `UPDATE subscription_requests
     SET external_payment_id = COALESCE($2, external_payment_id),
         payment_status = COALESCE($3, payment_status),
         confirmation_url = COALESCE($4, confirmation_url),
         payment_provider = COALESCE($5, payment_provider),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [
      id,
      externalPaymentId ?? null,
      paymentStatus ?? null,
      confirmationUrl ?? null,
      paymentProvider ?? null,
    ]
  );
  return result.rows[0] || null;
}

export async function findById(id) {
  const result = await query(
    `SELECT ${SELECT_LIST} ${FROM_JOIN} WHERE sr.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function findPendingByProfile(profileId) {
  const result = await query(
    `SELECT * FROM subscription_requests
     WHERE profile_id = $1 AND status = 'pending'
     ORDER BY id DESC LIMIT 1`,
    [profileId]
  );
  return result.rows[0] || null;
}

export async function listByProfile(profileId, { limit = 20 } = {}) {
  const result = await query(
    `SELECT ${SELECT_LIST} ${FROM_JOIN}
     WHERE sr.profile_id = $1
     ORDER BY sr.created_at DESC
     LIMIT $2`,
    [profileId, Math.min(100, Math.max(1, Number(limit) || 20))]
  );
  return result.rows;
}

export async function listAll({ status = null, limit = 50 } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) {
    params.push(status);
    where += ` AND sr.status = $${params.length}`;
  }
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)));
  const result = await query(
    `SELECT ${SELECT_LIST} ${FROM_JOIN}
     ${where}
     ORDER BY
       CASE WHEN sr.status = 'pending' THEN 0 ELSE 1 END,
       sr.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function resolve(id, { status, adminNote, resolvedByUserId }) {
  const result = await query(
    `UPDATE subscription_requests
     SET status = $2,
         admin_note = COALESCE($3, admin_note),
         resolved_by_user_id = $4,
         resolved_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, status, adminNote ?? null, resolvedByUserId ?? null]
  );
  return result.rows[0] || null;
}

export async function cancelPending(profileId, userId = null) {
  const result = await query(
    `UPDATE subscription_requests
     SET status = 'cancelled',
         resolved_by_user_id = COALESCE($2, resolved_by_user_id),
         resolved_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE profile_id = $1 AND status = 'pending'
     RETURNING *`,
    [profileId, userId]
  );
  return result.rows;
}
