import { query } from '../config/database.js';

export async function insertAudit({
  profileId,
  actorUserId = null,
  action,
  fromStatus = null,
  toStatus = null,
  fromPlanCode = null,
  toPlanCode = null,
  meta = {},
}) {
  const result = await query(
    `INSERT INTO subscription_audit_log
       (profile_id, actor_user_id, action, from_status, to_status, from_plan_code, to_plan_code, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      profileId,
      actorUserId,
      action,
      fromStatus,
      toStatus,
      fromPlanCode,
      toPlanCode,
      JSON.stringify(meta || {}),
    ]
  );
  return result.rows[0] || null;
}

export async function listByProfile(profileId, { limit = 50 } = {}) {
  const result = await query(
    `SELECT a.*, u.email AS actor_email, u.full_name AS actor_name
     FROM subscription_audit_log a
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.profile_id = $1
     ORDER BY a.created_at DESC
     LIMIT $2`,
    [profileId, Math.min(200, Math.max(1, Number(limit) || 50))]
  );
  return result.rows;
}
