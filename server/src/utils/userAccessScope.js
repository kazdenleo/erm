/**
 * Область доступа пользователя к организациям и складам.
 *
 * null  — без ограничений (админ аккаунта / нет явных грантов / system admin)
 * number[] — только перечисленные id (может быть пустым = нет доступа)
 */

import { query } from '../config/database.js';

function normalizeAccountRole(v) {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  return s || null;
}

export function isAccountAdminLike(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.isProfileAdmin === true || user.is_profile_admin === true) return true;
  return normalizeAccountRole(user.accountRole ?? user.account_role ?? null) === 'admin';
}

function toIdList(rows, key) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const n = Number(row?.[key]);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Загрузить сырые гранты пользователя (без учёта роли админа).
 * @returns {{ organizationIds: number[], warehouseIds: number[] }}
 */
export async function loadUserAccessGrants(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) {
    return { organizationIds: [], warehouseIds: [] };
  }
  const [orgs, whs] = await Promise.all([
    query(
      `SELECT organization_id FROM user_organizations WHERE user_id = $1 ORDER BY organization_id`,
      [uid]
    ),
    query(
      `SELECT warehouse_id FROM user_warehouses WHERE user_id = $1 ORDER BY warehouse_id`,
      [uid]
    ),
  ]);
  return {
    organizationIds: toIdList(orgs.rows, 'organization_id'),
    warehouseIds: toIdList(whs.rows, 'warehouse_id'),
  };
}

/**
 * Эффективный scope для запросов данных.
 * @returns {{ organizationIds: null|number[], warehouseIds: null|number[] }}
 */
export async function resolveUserAccessScope(user) {
  if (!user || isAccountAdminLike(user)) {
    return { organizationIds: null, warehouseIds: null };
  }
  const uid = user.id;
  if (uid == null) {
    return { organizationIds: null, warehouseIds: null };
  }
  const grants = await loadUserAccessGrants(uid);
  return {
    organizationIds: grants.organizationIds.length > 0 ? grants.organizationIds : null,
    warehouseIds: grants.warehouseIds.length > 0 ? grants.warehouseIds : null,
  };
}

/**
 * Кэширует scope на req.userAccessScope.
 */
export async function getRequestAccessScope(req) {
  if (req.userAccessScope) return req.userAccessScope;
  const scope = await resolveUserAccessScope(req?.user);
  req.userAccessScope = scope;
  return scope;
}

export function isOrganizationAllowed(scope, organizationId) {
  if (!scope || scope.organizationIds == null) return true;
  const id = Number(organizationId);
  if (!Number.isFinite(id)) return false;
  return scope.organizationIds.includes(id);
}

export function isWarehouseAllowed(scope, warehouseId) {
  if (!scope || scope.warehouseIds == null) return true;
  const id = Number(warehouseId);
  if (!Number.isFinite(id)) return false;
  return scope.warehouseIds.includes(id);
}

/**
 * Заменить гранты пользователя. Ids валидируются по profile_id.
 * Пустые массивы очищают ограничения (= полный доступ).
 */
export async function replaceUserAccessGrants(userId, { organizationIds, warehouseIds, profileId }) {
  const uid = Number(userId);
  const pid = profileId != null && profileId !== '' ? Number(profileId) : null;
  if (!Number.isFinite(uid)) {
    throw new Error('Некорректный userId');
  }

  const orgIds = normalizeIdArray(organizationIds);
  const whIds = normalizeIdArray(warehouseIds);

  if (pid != null && Number.isFinite(pid)) {
    if (orgIds.length > 0) {
      const check = await query(
        `SELECT id FROM organizations WHERE profile_id = $1 AND id = ANY($2::bigint[])`,
        [pid, orgIds]
      );
      if (check.rows.length !== orgIds.length) {
        const err = new Error('Указаны организации вне аккаунта');
        err.status = 400;
        throw err;
      }
    }
    if (whIds.length > 0) {
      const check = await query(
        `SELECT id FROM warehouses WHERE profile_id = $1 AND id = ANY($2::bigint[])`,
        [pid, whIds]
      );
      if (check.rows.length !== whIds.length) {
        const err = new Error('Указаны склады вне аккаунта');
        err.status = 400;
        throw err;
      }
    }
  }

  await query('DELETE FROM user_organizations WHERE user_id = $1', [uid]);
  await query('DELETE FROM user_warehouses WHERE user_id = $1', [uid]);

  for (const oid of orgIds) {
    await query(
      `INSERT INTO user_organizations (user_id, organization_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [uid, oid]
    );
  }
  for (const wid of whIds) {
    await query(
      `INSERT INTO user_warehouses (user_id, warehouse_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [uid, wid]
    );
  }

  return { organizationIds: orgIds, warehouseIds: whIds };
}

function normalizeIdArray(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
