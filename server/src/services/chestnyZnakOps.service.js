/**
 * Операционный скан КИ в приёмке, FBS, FBO и списании.
 * Остаток склада по-прежнему qty-only; КИ живут в реестре и документах ГИС МТ.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import {
  extractGtinFromCis,
  looksLikeCis,
  normalizeCis,
  normalizeOperations,
  parseIntegrationConfig,
  productLookupCodesFromScan,
} from '../utils/chestnyZnak.js';
import chestnyZnakService from './chestnyZnak.service.js';
import chestnyZnakDocsService from './chestnyZnakDocs.service.js';

function orgIdNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function profileIdNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

class ChestnyZnakOpsService {
  async resolveOrganizationId({ organizationId = null, warehouseId = null } = {}) {
    const wh = Number(warehouseId);
    if (Number.isFinite(wh) && wh > 0) {
      try {
        const r = await query('SELECT organization_id FROM warehouses WHERE id = $1', [wh]);
        const fromWh = orgIdNum(r.rows[0]?.organization_id);
        if (fromWh) return fromWh;
      } catch {
        /* колонки может не быть в тестах без PG */
      }
    }
    return orgIdNum(organizationId);
  }

  async isOperationEnabled(kind, ctx) {
    const profileId = profileIdNum(ctx?.profileId);
    const organizationId = orgIdNum(ctx?.organizationId);
    if (!profileId || !organizationId || !kind) return false;
    try {
      const row = await chestnyZnakService._loadRow({ profileId, organizationId });
      if (!row) return false;
      const ops = normalizeOperations(parseIntegrationConfig(row.config).operations);
      return ops[kind] !== false;
    } catch {
      return false;
    }
  }

  async findProductIdByScanCode(raw, { profileId = null } = {}) {
    const codes = productLookupCodesFromScan(raw);
    const pid = profileIdNum(profileId);
    for (const code of codes) {
      const digits = String(code).replace(/\D+/g, '');
      const params = [code, digits];
      let profileSql = '';
      if (pid) {
        params.push(pid);
        profileSql = ` AND p.profile_id = $${params.length}`;
      }
      const br = await query(
        `SELECT b.product_id
         FROM barcodes b
         JOIN products p ON p.id = b.product_id
         WHERE (
           TRIM(b.barcode) = TRIM($1)
           OR ($2 <> '' AND REGEXP_REPLACE(COALESCE(b.barcode, ''), '\\D', '', 'g') = $2)
         )${profileSql}
         LIMIT 1`,
        params
      );
      if (br.rows[0]?.product_id) return Number(br.rows[0].product_id);

      const skuParams = [code];
      let skuProfile = '';
      if (pid) {
        skuParams.push(pid);
        skuProfile = ` AND profile_id = $${skuParams.length}`;
      }
      const pr = await query(
        `SELECT id FROM products WHERE sku = $1${skuProfile} LIMIT 1`,
        skuParams
      );
      if (pr.rows[0]?.id) return Number(pr.rows[0].id);
    }
    return null;
  }

  async findCis(code, { profileId, organizationId } = {}) {
    const pid = profileIdNum(profileId);
    const org = orgIdNum(organizationId);
    const cis = normalizeCis(code);
    if (!pid || !org || !cis) return null;
    const r = await query(
      `SELECT * FROM chestny_znak_cis
       WHERE profile_id = $1 AND organization_id = $2 AND cis = $3`,
      [pid, org, cis]
    );
    return r.rows[0] || null;
  }

  /**
   * @returns {{ isCis: boolean, bound?: boolean, duplicate?: boolean, gtin?: string|null, item?: object, gis?: object, reason?: string }}
   */
  async tryBindCis({
    code,
    kind,
    sourceType,
    sourceId,
    productId = null,
    warehouseId = null,
    productGroup = null,
    profileId,
    organizationId,
  }) {
    if (!looksLikeCis(code)) return { isCis: false };
    const gtin = extractGtinFromCis(code);
    const normalized = normalizeCis(code);
    const org = orgIdNum(organizationId);
    const pid = profileIdNum(profileId);
    if (!org || !pid) {
      return { isCis: true, bound: false, duplicate: false, gtin, reason: 'no_org' };
    }
    const ctx = { profileId: pid, organizationId: org };
    const enabled = await this.isOperationEnabled(kind, ctx);
    if (!enabled) {
      return { isCis: true, bound: false, duplicate: false, gtin, reason: 'disabled' };
    }

    const prev = await this.findCis(normalized, ctx);
    if (prev) {
      const sameSource =
        String(prev.source_type || '') === String(sourceType || '') &&
        Number(prev.source_id) === Number(sourceId);
      const terminal = prev.status === 'withdrawn' || prev.status === 'transferred';
      if (sameSource || terminal) {
        return { isCis: true, bound: true, duplicate: true, gtin, item: prev };
      }
    }

    const { item, gis } = await chestnyZnakDocsService.scanCis(
      {
        cis: normalized,
        source_type: sourceType,
        source_id: sourceId,
        product_id: productId,
        warehouse_id: warehouseId,
        product_group: productGroup,
      },
      ctx
    );
    return {
      isCis: true,
      bound: true,
      duplicate: false,
      gtin: gtin || item?.gtin || null,
      item,
      gis,
    };
  }

  async listCisForSource({ sourceType, sourceId, profileId, organizationId }) {
    const org = orgIdNum(organizationId);
    const pid = profileIdNum(profileId);
    if (!org || !pid || sourceId == null || sourceId === '') return [];
    const r = await query(
      `SELECT * FROM chestny_znak_cis
       WHERE profile_id = $1 AND organization_id = $2
         AND source_type = $3 AND source_id = $4
         AND status <> 'error'
       ORDER BY id`,
      [pid, org, String(sourceType), Number(sourceId)]
    );
    return r.rows;
  }

  async maybeCreateDocument({
    kind,
    sourceType,
    sourceId,
    cisIds = null,
    profileId,
    organizationId,
    productGroup = null,
  }) {
    const ctx = { profileId, organizationId };
    const enabled = await this.isOperationEnabled(kind, ctx);
    if (!enabled) return null;
    let ids = Array.isArray(cisIds) ? cisIds.map(Number).filter(Boolean) : [];
    if (!ids.length && sourceType && sourceId != null && sourceId !== '') {
      const rows = await this.listCisForSource({ sourceType, sourceId, profileId, organizationId });
      ids = rows.map((row) => Number(row.id));
    }
    if (!ids.length) return null;

    const existing = await query(
      `SELECT id FROM chestny_znak_documents
       WHERE profile_id = $1 AND organization_id = $2 AND doc_kind = $3
         AND source_type IS NOT DISTINCT FROM $4
         AND source_id IS NOT DISTINCT FROM $5
       ORDER BY id DESC
       LIMIT 1`,
      [
        profileId,
        organizationId,
        kind,
        sourceType || null,
        sourceId != null && sourceId !== '' ? Number(sourceId) : null,
      ]
    );
    if (existing.rows[0]) {
      return { skipped: true, document: { id: existing.rows[0].id } };
    }

    try {
      const document = await chestnyZnakDocsService.createDocument(
        {
          kind,
          cis_ids: ids,
          source_type: sourceType,
          source_id: sourceId,
          product_group: productGroup,
        },
        ctx
      );
      return { skipped: false, document };
    } catch (err) {
      logger.warn('[ChestnyZnak] auto document failed', {
        kind,
        sourceType,
        sourceId,
        message: err.message,
      });
      return { skipped: true, error: err.message };
    }
  }

  async assertReceiptCisQty({ receiptId, profileId, organizationId, scanLines }) {
    const enabled = await this.isOperationEnabled('purchase_accept', {
      profileId,
      organizationId,
    });
    if (!enabled) return;

    const cisRows = await this.listCisForSource({
      sourceType: 'purchase_receipt',
      sourceId: receiptId,
      profileId,
      organizationId,
    });
    const cisByProduct = new Map();
    for (const row of cisRows) {
      const pid = Number(row.product_id);
      if (!pid) continue;
      cisByProduct.set(pid, (cisByProduct.get(pid) || 0) + 1);
    }

    const pids = (scanLines || [])
      .map((line) => Number(line.product_id))
      .filter((id) => Number.isFinite(id) && id > 0);
    const marked = new Set();
    if (pids.length) {
      const r = await query(
        `SELECT id, sku, name, chestny_znak_pg FROM products WHERE id = ANY($1::bigint[])`,
        [pids]
      );
      for (const p of r.rows) {
        if (p.chestny_znak_pg) marked.add(Number(p.id));
      }
    }

    const qtyByProduct = new Map();
    for (const line of scanLines || []) {
      const pid = Number(line.product_id);
      const qty = Math.max(0, parseInt(line.scanned_quantity, 10) || 0);
      if (pid && qty > 0) qtyByProduct.set(pid, qty);
    }

    const toCheck = new Set([...marked, ...cisByProduct.keys()]);
    for (const pid of toCheck) {
      const qty = qtyByProduct.get(pid) || 0;
      const cisCount = cisByProduct.get(pid) || 0;
      if (qty === cisCount) continue;
      const skuRow = (scanLines || []).find((line) => Number(line.product_id) === pid);
      const label = skuRow?.sku || skuRow?.product_sku || `#${pid}`;
      const err = new Error(
        `Маркировка: для «${label}» нужно по одному КИ на каждую штуку (принято ${qty} шт., КИ ${cisCount})`
      );
      err.statusCode = 400;
      throw err;
    }
  }

  async createFbsDocumentsForOrders({ marketplace, orderIds, profileId, fallbackOrganizationId } = {}) {
    if (!marketplace || !Array.isArray(orderIds) || !orderIds.length) return;
    const { default: ordersService } = await import('./orders.service.js');
    for (const rawOid of orderIds) {
      const oid = String(rawOid ?? '').trim();
      if (!oid) continue;
      try {
        const order = await ordersService.getByMarketplaceAndOrderId(marketplace, oid, { profileId });
        if (!order?.id) continue;
        const organizationId = await this.resolveOrganizationId({
          warehouseId: order.warehouseId ?? order.warehouse_id,
          organizationId: fallbackOrganizationId,
        });
        if (!organizationId) continue;
        await this.maybeCreateDocument({
          kind: 'fbs_distance',
          sourceType: 'order',
          sourceId: order.id,
          profileId,
          organizationId,
        });
      } catch (err) {
        logger.warn('[ChestnyZnak] FBS document for order failed', {
          orderId: oid,
          message: err.message,
        });
      }
    }
  }
}

export default new ChestnyZnakOpsService();
