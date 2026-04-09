/**
 * Инвентаризация: список документов и атомарное применение пересчёта
 */

import { query, transaction } from '../config/database.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

async function assertProductAllowedInProfile(client, productId, profileId) {
  const pid = normalizeProfileId(profileId);
  if (pid == null) return;
  const res = await client.query(
    `SELECT 1 FROM products p
     LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE p.id = $1
       AND (o.profile_id IS NOT DISTINCT FROM $2::bigint)`,
    [productId, pid]
  );
  if (!res.rows?.length) {
    const err = new Error('Товар недоступен в вашем аккаунте');
    err.statusCode = 403;
    throw err;
  }
}

async function resolveInventoryWarehouseId(client, warehouseId) {
  let wid =
    warehouseId != null && warehouseId !== ''
      ? typeof warehouseId === 'string'
        ? parseInt(warehouseId, 10)
        : Number(warehouseId)
      : null;
  if (wid != null && !Number.isNaN(wid)) {
    const ok = await client.query(
      `SELECT id FROM warehouses WHERE id = $1 AND type = 'warehouse' AND supplier_id IS NULL`,
      [wid]
    );
    if (ok.rows?.length) return wid;
  }
  const d = await client.query(
    `SELECT id FROM warehouses WHERE type = 'warehouse' AND supplier_id IS NULL ORDER BY id ASC LIMIT 1`
  );
  return d.rows?.[0]?.id ?? null;
}

class InventorySessionsService {
  async list({ profileId, limit = 200 } = {}) {
    const lim = Math.min(Math.max(1, parseInt(limit, 10) || 200), 500);
    const pid = normalizeProfileId(profileId);
    const whLabel = `COALESCE(NULLIF(TRIM(w.address), ''), 'Склад #' || w.id::text)`;
    if (pid != null) {
      const res = await query(
        `SELECT s.id, s.created_at, s.lines_count, s.note, s.profile_id, s.warehouse_id,
                s.created_by_user_id,
                u.email AS created_by_email,
                u.full_name AS created_by_full_name,
                ${whLabel} AS warehouse_label
         FROM inventory_sessions s
         LEFT JOIN users u ON u.id = s.created_by_user_id
         LEFT JOIN warehouses w ON w.id = s.warehouse_id
         WHERE s.profile_id = $1
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT $2`,
        [pid, lim]
      );
      return res.rows || [];
    }
    const res = await query(
      `SELECT s.id, s.created_at, s.lines_count, s.note, s.profile_id, s.warehouse_id,
              s.created_by_user_id,
              u.email AS created_by_email,
              u.full_name AS created_by_full_name,
              ${whLabel} AS warehouse_label
       FROM inventory_sessions s
       LEFT JOIN users u ON u.id = s.created_by_user_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.profile_id IS NULL
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT $1`,
      [lim]
    );
    return res.rows || [];
  }

  async getById(sessionId, { profileId } = {}) {
    const sid = parseInt(sessionId, 10);
    if (!sid || Number.isNaN(sid)) {
      const err = new Error('Некорректный ID');
      err.statusCode = 400;
      throw err;
    }
    const head = await query(
      `SELECT s.id, s.created_at, s.lines_count, s.note, s.profile_id, s.warehouse_id,
              s.created_by_user_id,
              u.email AS created_by_email,
              u.full_name AS created_by_full_name,
              COALESCE(NULLIF(TRIM(w.address), ''), 'Склад #' || w.id::text) AS warehouse_label
       FROM inventory_sessions s
       LEFT JOIN users u ON u.id = s.created_by_user_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.id = $1`,
      [sid]
    );
    const session = head.rows?.[0];
    if (!session) {
      const err = new Error('Инвентаризация не найдена');
      err.statusCode = 404;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    if (pid != null) {
      const sidPid = session.profile_id != null ? Number(session.profile_id) : null;
      if (sidPid !== pid) {
        const err = new Error('Инвентаризация не найдена');
        err.statusCode = 404;
        throw err;
      }
    }
    const lines = await query(
      `SELECT l.id, l.product_id, l.quantity_before, l.quantity_after,
              p.sku AS product_sku, p.name AS product_name, p.cost AS product_cost
       FROM inventory_session_lines l
       JOIN products p ON p.id = l.product_id
       WHERE l.session_id = $1
       ORDER BY l.id ASC`,
      [sid]
    );
    return { session, lines: lines.rows || [] };
  }

  /**
   * @param {Array<{ productId: number|string, quantityAfter: number }>} linesInput
   * @param {{ userId: number|null, profileId: number|string|null, note?: string, warehouseId?: number|string|null }} ctx
   */
  async apply(linesInput, { userId = null, profileId = null, note = null, warehouseId = null } = {}) {
    if (!Array.isArray(linesInput) || linesInput.length === 0) {
      const err = new Error('Передайте непустой массив lines');
      err.statusCode = 400;
      throw err;
    }
    const uid = userId != null ? parseInt(userId, 10) : null;
    const pid = normalizeProfileId(profileId);

    return transaction(async (client) => {
      const whId = await resolveInventoryWarehouseId(client, warehouseId);
      if (!whId) {
        const err = new Error('Не найден склад для инвентаризации (нужен склад type=warehouse без поставщика)');
        err.statusCode = 400;
        throw err;
      }

      const ins = await client.query(
        `INSERT INTO inventory_sessions (created_by_user_id, profile_id, lines_count, note, warehouse_id)
         VALUES ($1, $2, 0, $3, $4)
         RETURNING id`,
        [uid && !Number.isNaN(uid) ? uid : null, pid, note || null, whId]
      );
      const sessionId = ins.rows[0].id;
      let applied = 0;
      const reasonBase = `Инвентаризация №${sessionId}`;

      for (const raw of linesInput) {
        const productId = parseInt(raw.productId, 10);
        const quantityAfter = Math.max(0, parseInt(raw.quantityAfter, 10) || 0);
        if (!productId || Number.isNaN(productId)) continue;

        await assertProductAllowedInProfile(client, productId, pid);

        const pwsRow = await client.query(
          `SELECT quantity FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE`,
          [productId, whId]
        );
        const before = pwsRow.rows?.[0] ? Number(pwsRow.rows[0].quantity) : 0;
        if (before === quantityAfter) continue;

        await client.query(
          `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
          [productId, whId, quantityAfter]
        );

        const bal = await client.query('SELECT quantity FROM products WHERE id = $1', [productId]);
        const totalAfter = bal.rows?.[0]?.quantity != null ? Number(bal.rows[0].quantity) : 0;

        await client.query(
          `INSERT INTO inventory_session_lines (session_id, product_id, quantity_before, quantity_after)
           VALUES ($1, $2, $3, $4)`,
          [sessionId, productId, before, quantityAfter]
        );

        const delta = quantityAfter - before;
        await client.query(
          `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta, warehouse_id)
           VALUES ($1, 'inventory', $2, $3, $4, $5, $6)`,
          [
            productId,
            delta,
            totalAfter,
            reasonBase,
            JSON.stringify({ inventory_session_id: sessionId, warehouse_id: whId }),
            whId,
          ]
        );
        applied++;
      }

      await client.query(`UPDATE inventory_sessions SET lines_count = $1 WHERE id = $2`, [applied, sessionId]);

      if (applied === 0) {
        await client.query('DELETE FROM inventory_sessions WHERE id = $1', [sessionId]);
        return { sessionId: null, linesApplied: 0, message: 'Нет расхождений с учётом — документ не создан' };
      }

      return { sessionId, linesApplied: applied };
    });
  }

  /**
   * Удалить документ инвентаризации: откатить изменения остатков на складе документа.
   */
  async deleteSession(sessionId, { profileId } = {}) {
    const { session, lines } = await this.getById(sessionId, { profileId });
    const sid = session.id;
    const whId = session.warehouse_id;
    const pid = normalizeProfileId(profileId);
    const reason = `Аннулирование инвентаризации №${sid}`;

    return transaction(async (client) => {
      for (const line of lines || []) {
        const productId = parseInt(line.product_id, 10);
        const qb = line.quantity_before != null ? Number(line.quantity_before) : 0;
        const qa = line.quantity_after != null ? Number(line.quantity_after) : 0;
        if (!productId || Number.isNaN(productId) || qb === qa) continue;

        if (pid != null) {
          await assertProductAllowedInProfile(client, productId, pid);
        }

        if (whId) {
          await client.query(
            `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
             VALUES ($1, $2, $3)
             ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
            [productId, whId, qb]
          );
        }

        const bal = await client.query('SELECT quantity FROM products WHERE id = $1', [productId]);
        const totalAfter = bal.rows?.[0]?.quantity != null ? Number(bal.rows[0].quantity) : 0;
        const reverseDelta = qb - qa;

        await client.query(
          `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta, warehouse_id)
           VALUES ($1, 'manual', $2, $3, $4, $5, $6)`,
          [
            productId,
            reverseDelta,
            totalAfter,
            reason,
            JSON.stringify({ inventory_session_id: sid, deleted: true, warehouse_id: whId }),
            whId || null,
          ]
        );
      }

      await client.query('DELETE FROM inventory_sessions WHERE id = $1', [sid]);
      return { deleted: true, id: sid };
    });
  }
}

export default new InventorySessionsService();
