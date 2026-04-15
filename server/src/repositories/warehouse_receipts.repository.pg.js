/**
 * Warehouse Receipts Repository (PostgreSQL)
 * Приёмки товаров на склад
 */

import { query, transaction } from '../config/database.js';

class WarehouseReceiptsRepositoryPG {
  async create({ supplierId = null, organizationId = null, documentType = 'receipt' }) {
    let receipt;
    try {
      const docType = documentType === 'return' ? 'return' : (documentType === 'customer_return' ? 'customer_return' : 'receipt');
      const res = await query(
        `INSERT INTO warehouse_receipts (supplier_id, organization_id, document_type) VALUES ($1, $2, $3) RETURNING *`,
        [supplierId, organizationId || null, docType]
      );
      receipt = res.rows[0];
    } catch (err) {
      if (err.message && /column.*does not exist|organization_id|document_type/i.test(err.message)) {
        const res = await query(
          `INSERT INTO warehouse_receipts (supplier_id) VALUES ($1) RETURNING *`,
          [supplierId]
        );
        receipt = res.rows[0];
        if (receipt) {
          receipt.document_type = documentType === 'return' ? 'return' : (documentType === 'customer_return' ? 'customer_return' : 'receipt');
          receipt.organization_id = organizationId || null;
        }
      } else {
        throw err;
      }
    }
    if (receipt) {
      const num = receipt.id;
      const prefix = receipt.document_type === 'return' ? 'ВН' : (receipt.document_type === 'customer_return' ? 'ВК' : 'ПТ');
      const receiptNumber = `${prefix}-${String(num).padStart(6, '0')}`;
      await query(
        `UPDATE warehouse_receipts SET receipt_number = $1 WHERE id = $2`,
        [receiptNumber, receipt.id]
      );
      receipt.receipt_number = receiptNumber;
    }
    return receipt;
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
                o.name AS organization_name
         FROM warehouse_receipts r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN organizations o ON o.id = r.organization_id
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
      `SELECT l.id, l.product_id, l.quantity, l.cost, l.created_at,
              p.sku AS product_sku, p.name AS product_name
       FROM warehouse_receipt_lines l
       JOIN products p ON p.id = l.product_id
       WHERE l.receipt_id = $1
       ORDER BY l.id`,
      [receiptId]
    );
    return r.rows || [];
  }

  async findAll({ limit = 100, offset = 0, profileId = null } = {}) {
    /* Цена в документе или из карточки товара (старые строки с NULL cost всё же показывают сумму). */
    const amountRub = `(
      SELECT SUM(l.quantity::numeric * COALESCE(l.cost, p.cost)::numeric)
      FROM warehouse_receipt_lines l
      INNER JOIN products p ON p.id = l.product_id
      WHERE l.receipt_id = r.id
        AND COALESCE(l.cost, p.cost) IS NOT NULL
    ) AS total_amount_rub`;
    const pid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : null;
    const useProfile = Number.isFinite(pid) && pid > 0;
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

    try {
      const params = [];
      if (useProfile) params.push(pid);
      const limIdx = params.length + 1;
      const offIdx = params.length + 2;
      params.push(limit, offset);
      const r = await query(
        `SELECT r.id, r.created_at, r.receipt_number, r.supplier_id, r.organization_id, r.document_type,
                s.name AS supplier_name, s.code AS supplier_code,
                o.name AS organization_name,
                (SELECT COUNT(*)::int FROM warehouse_receipt_lines WHERE receipt_id = r.id) AS lines_count,
                COALESCE(
                  (SELECT SUM(l.quantity) FROM warehouse_receipt_lines l WHERE l.receipt_id = r.id),
                  0
                )::int AS total_quantity,
                ${amountRub}
         FROM warehouse_receipts r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN organizations o ON o.id = r.organization_id
         WHERE 1=1 ${profileWhere}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`,
        params
      );
      return r.rows || [];
    } catch (err) {
      if (err.message && /column.*does not exist|organization_id|document_type/i.test(err.message)) {
        const params = [];
        if (useProfile) params.push(pid);
        const limIdx = params.length + 1;
        const offIdx = params.length + 2;
        params.push(limit, offset);
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
           LIMIT $${limIdx} OFFSET $${offIdx}`,
          params
        );
        return (r.rows || []).map(row => ({ ...row, organization_id: null, document_type: 'receipt', organization_name: null }));
      }
      throw err;
    }
  }

  async count({ profileId = null } = {}) {
    const pid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : null;
    const useProfile = Number.isFinite(pid) && pid > 0;
    const profileWhere = useProfile
      ? ` WHERE (
          (r.organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM organizations o2 WHERE o2.id = r.organization_id AND o2.profile_id = $1::bigint))
          OR (r.organization_id IS NULL AND EXISTS (
            SELECT 1 FROM warehouse_receipt_lines l2
            JOIN products p2 ON p2.id = l2.product_id
            WHERE l2.receipt_id = r.id AND p2.profile_id = $1::bigint
            LIMIT 1
          ))
        )`
      : '';
    try {
      const params = useProfile ? [pid] : [];
      const r = await query(`SELECT COUNT(*) AS total FROM warehouse_receipts r${profileWhere}`, params);
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
}

export default new WarehouseReceiptsRepositoryPG();
