/**
 * Журнал действий сотрудников (скан при сборке/приёмке, ошибки скана).
 * Запись «fire-and-forget»: сбой журнала не должен ломать сборку или приёмку.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import logger from '../utils/logger.js';

export const EMPLOYEE_EVENT = {
  ASSEMBLY_SCAN: 'assembly_scan',
  ASSEMBLY_COLLECTED: 'assembly_collected',
  RECEIPT_SCAN: 'receipt_scan',
};

function positiveIntOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * @param {{ user?: object, profileId?: number, userId?: number, eventType: string, isError?: boolean,
 *   entityType?: string, entityId?: string|number, quantity?: number, meta?: object }} event
 */
export function logEmployeeEvent(event) {
  try {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const userId = positiveIntOrNull(event.userId ?? event.user?.id);
    if (!userId) return;
    const profileId = positiveIntOrNull(event.profileId ?? event.user?.profileId);
    const qty = Math.trunc(Number(event.quantity) || 0);
    query(
      `INSERT INTO employee_activity_events
         (profile_id, user_id, event_type, is_error, entity_type, entity_id, quantity, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        profileId,
        userId,
        String(event.eventType),
        Boolean(event.isError),
        event.entityType != null ? String(event.entityType) : null,
        event.entityId != null && String(event.entityId) !== '' ? String(event.entityId) : null,
        qty,
        event.meta && typeof event.meta === 'object' ? JSON.stringify(event.meta) : null,
      ]
    ).catch((e) => {
      logger.debug(`[EmployeeActivity] insert failed: ${e?.message || e}`);
    });
  } catch (e) {
    logger.debug(`[EmployeeActivity] log failed: ${e?.message || e}`);
  }
}
