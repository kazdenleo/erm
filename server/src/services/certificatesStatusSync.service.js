/**
 * Синхронизация статусов проверки сертификатов с Ozon и Яндекс.Маркетом.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import ozonCertificatesPushService from './ozonCertificatesPush.service.js';
import ymCertificatesPushService from './ymCertificatesPush.service.js';

const OZON_FINAL_STATUSES = ['approved', 'declined', 'rejected'];
const YM_PENDING_STATUSES = ['VALIDATING', 'WAITING_FIXES'];

class CertificatesStatusSyncService {
  /**
   * @param {object} opts
   * @param {boolean} [opts.onlyPending] только сертификаты, ещё не прошедшие проверку
   * @param {number|string} [opts.certificateId] один сертификат
   */
  async syncForProfile(profileId, { organizationId = null, onlyPending = false, certificateId = null } = {}) {
    const params = [profileId];
    let sql = `
      SELECT id, ozon_certificate_id, ozon_status_code, ozon_last_error, ym_document_id, ym_status_code
        FROM certificates
       WHERE profile_id = $1::bigint
         AND (ozon_certificate_id IS NOT NULL OR ym_document_id IS NOT NULL)`;
    if (certificateId != null) {
      params.push(certificateId);
      sql += ` AND id = $${params.length}::bigint`;
    }
    const rows = (await query(sql, params)).rows || [];
    const ozonCerts = onlyPending ? rows.filter((c) => isOzonPending(c.ozon_certificate_id, c.ozon_status_code)) : rows;
    const ymCerts = onlyPending ? rows.filter((c) => isYmPending(c.ym_document_id, c.ym_status_code)) : rows;

    const opts = { profileId, organizationId };
    const [ozon, ym] = await Promise.all([
      ozonCertificatesPushService.syncStatuses(ozonCerts, opts).catch((e) => ({ error: e?.message || String(e) })),
      ymCertificatesPushService.syncStatuses(ymCerts, opts).catch((e) => ({ error: e?.message || String(e) })),
    ]);
    return { ozon, ym };
  }

  /** Ежечасная задача: все профили, у которых есть сертификаты на проверке. */
  async syncAllPending() {
    const r = await query(
      `SELECT DISTINCT profile_id FROM certificates
        WHERE profile_id IS NOT NULL
          AND (
            (ozon_certificate_id IS NOT NULL AND COALESCE(LOWER(ozon_status_code), '') <> ALL($1::text[]))
            OR (ym_document_id IS NOT NULL AND UPPER(COALESCE(ym_status_code, 'VALIDATING')) = ANY($2::text[]))
          )`,
      [OZON_FINAL_STATUSES, YM_PENDING_STATUSES]
    );
    let profiles = 0;
    for (const row of r.rows || []) {
      try {
        const out = await this.syncForProfile(row.profile_id, { onlyPending: true });
        profiles++;
        if (out.ozon?.error || out.ym?.error) {
          logger.warn('[Certificates] status sync errors', { profileId: row.profile_id, ozon: out.ozon?.error, ym: out.ym?.error });
        }
      } catch (e) {
        logger.warn('[Certificates] status sync failed', { profileId: row.profile_id, message: e?.message });
      }
    }
    return { profiles };
  }
}

export function isOzonPending(ozonCertificateId, statusCode) {
  if (!(Number(ozonCertificateId) > 0)) return false;
  return !OZON_FINAL_STATUSES.includes(String(statusCode || '').toLowerCase());
}

export function isYmPending(ymDocumentId, statusCode) {
  if (!(Number(ymDocumentId) > 0)) return false;
  return YM_PENDING_STATUSES.includes(String(statusCode || 'VALIDATING').toUpperCase());
}

export default new CertificatesStatusSyncService();
