/**
 * Warehouse Receipts Repository (PostgreSQL)
 * Приёмки товаров на склад
 */

import { query, transaction } from '../config/database.js';

function normalizeReceiptDocumentType(documentType) {
  const t = String(documentType || '').trim().toLowerCase();
  if (
    t === 'return' ||
    t === 'customer_return' ||
    t === 'receipt' ||
    t === 'writeoff' ||
    t === 'transfer'
  ) {
    return t;
  }
  return null;
}

function receiptNumberPrefix(documentType) {
  if (documentType === 'return') return 'ВН';
  if (documentType === 'customer_return') return 'ВК';
  if (documentType === 'writeoff') return 'СП';
  if (documentType === 'transfer') return 'ПМ';
  return 'ПТ';
}

function normalizeDocTypeForInsert(documentType) {
  const t = String(documentType || 'receipt').trim().toLowerCase();
  if (t === 'return' || t === 'customer_return' || t === 'writeoff' || t === 'transfer') return t;
  return 'receipt';
}

function warehouseLabelSql(alias) {
  return `NULLIF(TRIM(COALESCE(${alias}.address, ${alias}.wb_warehouse_name, '')), '')`;
}

function transferToWarehouseNameSql({ useWhToJoin = true } = {}) {
  const whToPart = useWhToJoin
    ? `${warehouseLabelSql('wh_to')},`
    : '';
  return `COALESCE(
      ${whToPart}
      (
        SELECT NULLIF(TRIM(COALESCE(wh.address, wh.wb_warehouse_name, '')), '')
        FROM stock_movements sm
        LEFT JOIN warehouses wh ON wh.id = NULLIF(sm.meta->>'to_warehouse_id', '')::bigint
        WHERE (sm.meta->>'receipt_id')::bigint = r.id
          AND NULLIF(sm.meta->>'to_warehouse_id', '') IS NOT NULL
        ORDER BY sm.id DESC
        LIMIT 1
      )
    ) AS to_warehouse_name`;
}

function receiptWarehouseLabelSqlExpr({ useWhFromJoin = true } = {}) {
  const whFromPart = useWhFromJoin
    ? `${warehouseLabelSql('wh_from')},`
    : '';
  return `COALESCE(
      ${whFromPart}
      (
        SELECT NULLIF(TRIM(COALESCE(wh.address, wh.wb_warehouse_name, '')), '')
        FROM warehouses wh
        WHERE wh.id = r.warehouse_id
      ),
      (
        SELECT NULLIF(TRIM(COALESCE(wh.address, wh.wb_warehouse_name, '')), '')
        FROM purchase_receipts pr
        JOIN purchases pur ON pur.id = pr.purchase_id
        LEFT JOIN warehouses wh ON wh.id = pur.warehouse_id
        WHERE pr.warehouse_receipt_id = r.id
        ORDER BY pr.id DESC
        LIMIT 1
      ),
      (
        SELECT NULLIF(TRIM(COALESCE(wh.address, wh.wb_warehouse_name, '')), '')
        FROM stock_movements sm
        LEFT JOIN warehouses wh ON wh.id = COALESCE(
          NULLIF(sm.meta->>'from_warehouse_id', '')::bigint,
          sm.warehouse_id
        )
        WHERE (sm.meta->>'receipt_id')::bigint = r.id
          AND sm.warehouse_id IS NOT NULL
        ORDER BY sm.id DESC
        LIMIT 1
      )
    ) AS warehouse_name`;
}

class WarehouseReceiptsRepositoryPG {
  async create({
    supplierId = null,
    organizationId = null,
    documentType = 'receipt',
    warehouseId = null,
    toWarehouseId = null,
    writeoffReason = null,
  }) {
    const docType = normalizeDocTypeForInsert(documentType);
    let receipt;
    try {
      const res = await query(
        `INSERT INTO warehouse_receipts (supplier_id, organization_id, document_type, warehouse_id, to_warehouse_id, writeoff_reason)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          supplierId,
          organizationId || null,
          docType,
          warehouseId || null,
          toWarehouseId || null,
          writeoffReason || null,
        ]
      );
      receipt = res.rows[0];
    } catch (err) {
      if (err.message && /column.*does not exist|organization_id|document_type|warehouse_id|to_warehouse_id|writeoff_reason/i.test(err.message)) {
        try {
          const res = await query(
            `INSERT INTO warehouse_receipts (supplier_id, organization_id, document_type, warehouse_id, writeoff_reason)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [supplierId, organizationId || null, docType, warehouseId || null, writeoffReason || null]
          );
          receipt = res.rows[0];
        } catch (err2) {
          if (err2.message && /column.*does not exist|organization_id|document_type|warehouse_id|writeoff_reason/i.test(err2.message)) {
            const res = await query(
              `INSERT INTO warehouse_receipts (supplier_id, organization_id, document_type) VALUES ($1, $2, $3) RETURNING *`,
              [supplierId, organizationId || null, docType]
            );
            receipt = res.rows[0];
          } else {
            throw err2;
          }
        }
        if (receipt) {
          receipt.document_type = docType;
          receipt.organization_id = organizationId || null;
          receipt.warehouse_id = warehouseId || null;
          receipt.to_warehouse_id = toWarehouseId || null;
          receipt.writeoff_reason = writeoffReason || null;
        }
      } else {
        throw err;
      }
    }
    if (receipt) {
      await this._syncReceiptScopeFields(receipt.id, {
        organizationId,
        warehouseId,
        toWarehouseId,
        writeoffReason,
        documentType: docType,
      });
      const num = receipt.id;
      const prefix = receiptNumberPrefix(receipt.document_type);
      const receiptNumber = `${prefix}-${String(num).padStart(6, '0')}`;
      await query(
        `UPDATE warehouse_receipts SET receipt_number = $1 WHERE id = $2`,
        [receiptNumber, receipt.id]
      );
      receipt.receipt_number = receiptNumber;
    }
    return receipt;
  }

  async _syncReceiptScopeFields(
    receiptId,
    { organizationId = null, warehouseId = null, toWarehouseId = null, writeoffReason = null, documentType = null } = {}
  ) {
    const id = typeof receiptId === 'string' ? parseInt(receiptId, 10) : receiptId;
    if (!Number.isFinite(id) || id < 1) return;
    try {
      await query(
        `UPDATE warehouse_receipts
         SET organization_id = COALESCE(organization_id, $2),
             warehouse_id = COALESCE(warehouse_id, $3),
             to_warehouse_id = COALESCE(to_warehouse_id, $4),
             writeoff_reason = COALESCE(writeoff_reason, $5),
             document_type = COALESCE(NULLIF(document_type, ''), $6)
         WHERE id = $1`,
        [
          id,
          organizationId || null,
          warehouseId || null,
          toWarehouseId || null,
          writeoffReason || null,
          documentType || null,
        ]
      );
    } catch (err) {
      if (err.message && /to_warehouse_id/i.test(err.message)) {
        await query(
          `UPDATE warehouse_receipts
           SET organization_id = COALESCE(organization_id, $2),
               warehouse_id = COALESCE(warehouse_id, $3),
               writeoff_reason = COALESCE(writeoff_reason, $4),
               document_type = COALESCE(NULLIF(document_type, ''), $5)
           WHERE id = $1`,
          [id, organizationId || null, warehouseId || null, writeoffReason || null, documentType || null]
        );
      } else if (err.message && /column.*does not exist/i.test(err.message)) {
        /* ignore — старая схема */
      } else {
        throw err;
      }
    }
  }

  async addLine({ receiptId, productId, quantity, cost = null }) {
    const res = await query(
      `INSERT INTO warehouse_receipt_lines (receipt_id, product_id, quantity, cost)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [receiptId, productId, quantity, cost]
    );
    return res.rows[0];
  }

  async findById(id) {
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    try {
      const r = await query(
        `SELECT r.*, s.name AS supplier_name, s.code AS supplier_code,
                COALESCE(
                  o.name,
                  (
                    SELECT o2.name
                    FROM stock_movements sm
                    JOIN organizations o2 ON o2.id = NULLIF(sm.meta->>'organization_id', '')::bigint
                    WHERE (sm.meta->>'receipt_id')::bigint = r.id
                      AND NULLIF(sm.meta->>'organization_id', '') IS NOT NULL
                    ORDER BY sm.id DESC
                    LIMIT 1
                  )
                ) AS organization_name,
                ${receiptWarehouseLabelSqlExpr({ useWhFromJoin: true })},
                ${transferToWarehouseNameSql({ useWhToJoin: true })}
         FROM warehouse_receipts r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN organizations o ON o.id = r.organization_id
         LEFT JOIN warehouses wh_from ON wh_from.id = r.warehouse_id
         LEFT JOIN warehouses wh_to ON wh_to.id = r.to_warehouse_id
         WHERE r.id = $1`,
        [numId]
      );
      return r.rows[0] || null;
    } catch (err) {
      if (err.message && /column.*does not exist|organization_id|document_type/i.test(err.message)) {
        const r = await query(
          `SELECT r.*, s.name AS supplier_name, s.code AS supplier_code
           FROM warehouse_receipts r
           LEFT JOIN suppliers s ON s.id = r.supplier_id
           WHERE r.id = $1`,
          [numId]
        );
        const row = r.rows[0];
        if (row) {
          row.organization_id = null;
          row.document_type = 'receipt';
          row.organization_name = null;
        }
        return row || null;
      }
      throw err;
    }
  }

  async getLines(receiptId) {
    const r = await query(
      `SELECT * FROM warehouse_receipt_lines WHERE receipt_id = $1 ORDER BY id`,
      [receiptId]
    );
    return r.rows || [];
  }

  async getLinesWithProducts(receiptId) {
    const r = await query(
      `SELECT l.id, l.product_id, l.quantity,
              COALESCE(l.cost, p.cost) AS cost,
              l.created_at,
              p.sku AS product_sku, p.name AS product_name
       FROM warehouse_receipt_lines l
       JOIN products p ON p.id = l.product_id
       WHERE l.receipt_id = $1
       ORDER BY l.id`,
      [receiptId]
    );
    return r.rows || [];
  }

  async findAll({
    limit = 100,
    offset = 0,
    profileId = null,
    documentType = null,
    organizationId = null,
    warehouseId = null,
  } = {}) {
    /* Цена в документе или из карточки товара (старые строки с NULL cost всё же показывают сумму). */
    const amountRub = `(
      SELECT SUM(l.quantity::numeric * COALESCE(l.cost, p.cost)::numeric)
      FROM warehouse_receipt_lines l
      INNER JOIN products p ON p.id = l.product_id
      WHERE l.receipt_id = r.id
        AND COALESCE(l.cost, p.cost) IS NOT NULL
    ) AS total_amount_rub`;
    const receiptWarehouseLabelSql = receiptWarehouseLabelSqlExpr({ useWhFromJoin: true });
    const toWarehouseNameSql = transferToWarehouseNameSql({ useWhToJoin: true });
    const purchaseReceiptIdSql = `(
      SELECT pr.id
      FROM purchase_receipts pr
      WHERE pr.warehouse_receipt_id = r.id
      ORDER BY pr.id DESC
      LIMIT 1
    ) AS purchase_receipt_id`;
    const pid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : null;
    const useProfile = Number.isFinite(pid) && pid > 0;
    const docType = normalizeReceiptDocumentType(documentType);
    const orgId =
      organizationId != null && organizationId !== ''
        ? typeof organizationId === 'string'
          ? parseInt(organizationId, 10)
          : Number(organizationId)
        : null;
    const whId =
      warehouseId != null && warehouseId !== ''
        ? typeof warehouseId === 'string'
          ? parseInt(warehouseId, 10)
          : Number(warehouseId)
        : null;
    const useOrg = Number.isFinite(orgId) && orgId > 0;
    const useWh = Number.isFinite(whId) && whId > 0;
    const baseListParams = [];
    if (useProfile) baseListParams.push(pid);
    if (docType) baseListParams.push(docType);
    if (useOrg) baseListParams.push(orgId);
    if (useWh) baseListParams.push(whId);
    const organizationNameSql = `COALESCE(
      o.name,
      (
        SELECT o2.name
        FROM stock_movements sm
        JOIN organizations o2 ON o2.id = NULLIF(sm.meta->>'organization_id', '')::bigint
        WHERE (sm.meta->>'receipt_id')::bigint = r.id
          AND NULLIF(sm.meta->>'organization_id', '') IS NOT NULL
        ORDER BY sm.id DESC
        LIMIT 1
      ),
      (
        SELECT o2.name
        FROM warehouses wh
        JOIN organizations o2 ON o2.id = wh.organization_id
        WHERE wh.id = r.warehouse_id
        LIMIT 1
      )
    ) AS organization_name`;
    const profileWhere = useProfile
      ? ` AND (
          (r.organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM organizations o2 WHERE o2.id = r.organization_id AND o2.profile_id = $1::bigint))
          OR (r.organization_id IS NULL AND EXISTS (
            SELECT 1 FROM warehouse_receipt_lines l2
            JOIN products p2 ON p2.id = l2.product_id
            WHERE l2.receipt_id = r.id AND p2.profile_id = $1::bigint
            LIMIT 1
          ))
        )`
      : '';
    let paramIdx = useProfile ? 2 : 1;
    const docWhere = docType ? ` AND r.document_type = $${useProfile ? 2 : 1}` : '';
    if (docType) paramIdx = useProfile ? 3 : 2;
    const orgWhere = useOrg ? ` AND r.organization_id = $${paramIdx++}` : '';
    const whWhere = useWh ? ` AND r.warehouse_id = $${paramIdx++}` : '';

    try {
      const limIdx = baseListParams.length + 1;
      const offIdx = baseListParams.length + 2;
      const params = [...baseListParams, limit, offset];
      const r = await query(
        `SELECT r.id, r.created_at, r.receipt_number, r.supplier_id, r.organization_id, r.document_type,
                r.warehouse_id, r.to_warehouse_id, r.writeoff_reason,
                s.name AS supplier_name, s.code AS supplier_code,
                ${organizationNameSql},
                (SELECT COUNT(*)::int FROM warehouse_receipt_lines WHERE receipt_id = r.id) AS lines_count,
                COALESCE(
                  (SELECT SUM(l.quantity) FROM warehouse_receipt_lines l WHERE l.receipt_id = r.id),
                  0
                )::int AS total_quantity,
                ${receiptWarehouseLabelSql},
                ${toWarehouseNameSql},
                ${purchaseReceiptIdSql},
                ${amountRub}
         FROM warehouse_receipts r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN organizations o ON o.id = r.organization_id
         LEFT JOIN warehouses wh_from ON wh_from.id = r.warehouse_id
         LEFT JOIN warehouses wh_to ON wh_to.id = r.to_warehouse_id
         WHERE 1=1 ${profileWhere} ${docWhere} ${orgWhere} ${whWhere}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`,
        params
      );
      return r.rows || [];
    } catch (err) {
      const msg = String(err?.message || '');
      const missingToWarehouse = /to_warehouse_id/i.test(msg);
      if (missingToWarehouse || /column.*does not exist|organization_id|document_type/i.test(msg)) {
        const retryParams = [...baseListParams, limit, offset];
        const receiptWarehouseLabelSqlRetry = receiptWarehouseLabelSqlExpr({ useWhFromJoin: true });
        const toWarehouseNameSqlRetry = transferToWarehouseNameSql({ useWhToJoin: false });
        const limIdx = baseListParams.length + 1;
        const offIdx = baseListParams.length + 2;
        try {
          const r = await query(
            `SELECT r.id, r.created_at, r.receipt_number, r.supplier_id, r.organization_id, r.document_type,
                    r.warehouse_id, r.writeoff_reason,
                    s.name AS supplier_name, s.code AS supplier_code,
                    ${organizationNameSql},
                    (SELECT COUNT(*)::int FROM warehouse_receipt_lines WHERE receipt_id = r.id) AS lines_count,
                    COALESCE(
                      (SELECT SUM(l.quantity) FROM warehouse_receipt_lines l WHERE l.receipt_id = r.id),
                      0
                    )::int AS total_quantity,
                    ${receiptWarehouseLabelSqlRetry},
                    ${toWarehouseNameSqlRetry},
                    ${purchaseReceiptIdSql},
                    ${amountRub}
             FROM warehouse_receipts r
             LEFT JOIN suppliers s ON s.id = r.supplier_id
             LEFT JOIN organizations o ON o.id = r.organization_id
             LEFT JOIN warehouses wh_from ON wh_from.id = r.warehouse_id
             WHERE 1=1 ${profileWhere} ${docWhere} ${orgWhere} ${whWhere}
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT $${limIdx} OFFSET $${offIdx}`,
            retryParams
          );
          return r.rows || [];
        } catch (retryErr) {
          if (!/column.*does not exist|organization_id|document_type/i.test(String(retryErr?.message || ''))) {
            throw retryErr;
          }
        }
        const legacyParams = [];
        if (useProfile) legacyParams.push(pid);
        const limIdxLegacy = legacyParams.length + 1;
        const offIdxLegacy = legacyParams.length + 2;
        legacyParams.push(limit, offset);
        const legacyProfileWhere = useProfile
          ? ` AND EXISTS (
              SELECT 1 FROM warehouse_receipt_lines l2
              JOIN products p2 ON p2.id = l2.product_id
              WHERE l2.receipt_id = r.id AND p2.profile_id = $1::bigint
            )`
          : '';
        const r = await query(
          `SELECT r.id, r.created_at, r.receipt_number, r.supplier_id,
                  s.name AS supplier_name, s.code AS supplier_code,
                  (SELECT COUNT(*)::int FROM warehouse_receipt_lines WHERE receipt_id = r.id) AS lines_count,
                  COALESCE(
                    (SELECT SUM(l.quantity) FROM warehouse_receipt_lines l WHERE l.receipt_id = r.id),
                    0
                  )::int AS total_quantity,
                  ${amountRub}
           FROM warehouse_receipts r
           LEFT JOIN suppliers s ON s.id = r.supplier_id
           WHERE 1=1 ${legacyProfileWhere}
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT $${limIdxLegacy} OFFSET $${offIdxLegacy}`,
          legacyParams
        );
        return (r.rows || []).map((row) => ({
          ...row,
          organization_id: null,
          document_type: 'receipt',
          organization_name: null,
        }));
      }
      throw err;
    }
  }

  async count({
    profileId = null,
    documentType = null,
    organizationId = null,
    warehouseId = null,
  } = {}) {
    const pid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : null;
    const useProfile = Number.isFinite(pid) && pid > 0;
    const docType = normalizeReceiptDocumentType(documentType);
    const orgId =
      organizationId != null && organizationId !== ''
        ? typeof organizationId === 'string'
          ? parseInt(organizationId, 10)
          : Number(organizationId)
        : null;
    const whId =
      warehouseId != null && warehouseId !== ''
        ? typeof warehouseId === 'string'
          ? parseInt(warehouseId, 10)
          : Number(warehouseId)
        : null;
    const useOrg = Number.isFinite(orgId) && orgId > 0;
    const useWh = Number.isFinite(whId) && whId > 0;
    const params = [];
    if (useProfile) params.push(pid);
    if (docType) params.push(docType);
    if (useOrg) params.push(orgId);
    if (useWh) params.push(whId);
    const profileWhere = useProfile
      ? ` AND (
          (r.organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM organizations o2 WHERE o2.id = r.organization_id AND o2.profile_id = $1::bigint))
          OR (r.organization_id IS NULL AND EXISTS (
            SELECT 1 FROM warehouse_receipt_lines l2
            JOIN products p2 ON p2.id = l2.product_id
            WHERE l2.receipt_id = r.id AND p2.profile_id = $1::bigint
            LIMIT 1
          ))
        )`
      : '';
    let paramIdx = useProfile ? 2 : 1;
    const docWhere = docType ? ` AND r.document_type = $${useProfile ? 2 : 1}` : '';
    if (docType) paramIdx = useProfile ? 3 : 2;
    const orgWhere = useOrg ? ` AND r.organization_id = $${paramIdx++}` : '';
    const whWhere = useWh ? ` AND r.warehouse_id = $${paramIdx++}` : '';
    try {
      const r = await query(
        `SELECT COUNT(*) AS total FROM warehouse_receipts r WHERE 1=1 ${profileWhere} ${docWhere} ${orgWhere} ${whWhere}`,
        params
      );
      return parseInt(r.rows[0]?.total || '0', 10);
    } catch (err) {
      if (err.message && /column.*does not exist|organization_id|document_type/i.test(err.message)) {
        const legacyWhere = useProfile
          ? ` WHERE EXISTS (
              SELECT 1 FROM warehouse_receipt_lines l2
              JOIN products p2 ON p2.id = l2.product_id
              WHERE l2.receipt_id = r.id AND p2.profile_id = $1::bigint
            )`
          : '';
        const params = useProfile ? [pid] : [];
        const r = await query(`SELECT COUNT(*) AS total FROM warehouse_receipts r${legacyWhere}`, params);
        return parseInt(r.rows[0]?.total || '0', 10);
      }
      throw err;
    }
  }

  async delete(id) {
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    const res = await query('DELETE FROM warehouse_receipts WHERE id = $1 RETURNING id', [numId]);
    return res.rows.length > 0;
  }

  async updateHeader(id, {
    supplierId = null,
    organizationId = null,
    warehouseId = null,
    toWarehouseId = null,
    documentType = null,
  } = {}) {
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    if (!numId || Number.isNaN(numId)) return null;
    const docType = documentType ? normalizeDocTypeForInsert(documentType) : null;
    try {
      const res = await query(
        `UPDATE warehouse_receipts
         SET supplier_id = $2,
             organization_id = $3,
             warehouse_id = COALESCE($4, warehouse_id),
             to_warehouse_id = COALESCE($5, to_warehouse_id),
             document_type = COALESCE($6, document_type)
         WHERE id = $1
         RETURNING *`,
        [numId, supplierId, organizationId, warehouseId || null, toWarehouseId || null, docType]
      );
      return res.rows[0] || null;
    } catch (err) {
      if (err.message && /to_warehouse_id/i.test(err.message)) {
        const res = await query(
          `UPDATE warehouse_receipts
           SET supplier_id = $2,
               organization_id = $3,
               warehouse_id = COALESCE($4, warehouse_id),
               document_type = COALESCE($5, document_type)
           WHERE id = $1
           RETURNING *`,
          [numId, supplierId, organizationId, warehouseId || null, docType]
        );
        return res.rows[0] || null;
      }
      if (err.message && /column.*does not exist|organization_id|warehouse_id|document_type/i.test(err.message)) {
        const res = await query(
          `UPDATE warehouse_receipts SET supplier_id = $2 WHERE id = $1 RETURNING *`,
          [numId, supplierId]
        );
        const row = res.rows[0];
        if (row) {
          row.organization_id = organizationId;
          row.warehouse_id = warehouseId || row.warehouse_id;
          row.to_warehouse_id = toWarehouseId || row.to_warehouse_id;
          if (docType) row.document_type = docType;
        }
        return row || null;
      }
      throw err;
    }
  }

  async deleteLines(receiptId) {
    const rid = typeof receiptId === 'string' ? parseInt(receiptId, 10) : receiptId;
    await query(`DELETE FROM warehouse_receipt_lines WHERE receipt_id = $1`, [rid]);
  }
}

export default new WarehouseReceiptsRepositoryPG();
