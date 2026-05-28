/**
 * Инвентаризация: список документов и атомарное применение пересчёта
 */

import { query, transaction } from '../config/database.js';
import stockMovementsRepositoryPG from '../repositories/stock_movements.repository.pg.js';

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
     WHERE p.id = $1
       AND p.profile_id = $2::bigint`,
    [productId, pid]
  );
  if (!res.rows?.length) {
    const err = new Error('Товар недоступен в вашем аккаунте');
    err.statusCode = 403;
    throw err;
  }
}

/** Склад инвентаризации обязателен (без подстановки «первого попавшегося»). */
async function requireInventoryWarehouseId(client, warehouseId) {
  let wid =
    warehouseId != null && warehouseId !== ''
      ? typeof warehouseId === 'string'
        ? parseInt(warehouseId, 10)
        : Number(warehouseId)
      : null;
  if (wid == null || Number.isNaN(wid) || wid < 1) {
    const err = new Error('Укажите склад инвентаризации');
    err.statusCode = 400;
    throw err;
  }
  const ok = await client.query(
    `SELECT id FROM warehouses WHERE id = $1 AND type = 'warehouse' AND supplier_id IS NULL`,
    [wid]
  );
  if (!ok.rows?.length) {
    const err = new Error('Склад не найден или недоступен для инвентаризации');
    err.statusCode = 400;
    throw err;
  }
  return wid;
}

async function getPwsQuantity(client, productId, whId) {
  const pwsRow = await client.query(
    `SELECT quantity FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE`,
    [productId, whId]
  );
  return pwsRow.rows?.[0] ? Number(pwsRow.rows[0].quantity) : 0;
}

async function setPwsQuantity(client, productId, whId, quantity) {
  await client.query(
    `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [productId, whId, quantity]
  );
}

/** Позиции с остатком на складе, не попавшие в пересчёт. */
async function findUnlistedWithStock(client, whId, profileId, listedIds) {
  const pid = normalizeProfileId(profileId);
  const ids = [...listedIds].filter((id) => id != null && !Number.isNaN(Number(id)));
  if (ids.length === 0) {
    const res = await client.query(
      `SELECT pws.product_id, pws.quantity
       FROM product_warehouse_stock pws
       INNER JOIN products p ON p.id = pws.product_id
       WHERE pws.warehouse_id = $1 AND pws.quantity > 0
         AND ($2::bigint IS NULL OR p.profile_id = $2::bigint)`,
      [whId, pid]
    );
    return res.rows || [];
  }
  const res = await client.query(
    `SELECT pws.product_id, pws.quantity
     FROM product_warehouse_stock pws
     INNER JOIN products p ON p.id = pws.product_id
     WHERE pws.warehouse_id = $1 AND pws.quantity > 0
       AND ($2::bigint IS NULL OR p.profile_id = $2::bigint)
       AND NOT (pws.product_id = ANY($3::bigint[]))`,
    [whId, pid, ids]
  );
  return res.rows || [];
}

function parseLineProductId(raw) {
  const v = raw?.productId ?? raw?.product_id;
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) || n < 1 ? null : n;
}

function parseLineQuantityAfter(raw) {
  const v = raw?.quantityAfter ?? raw?.quantity_after;
  if (v == null || v === '') return 0;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

async function applyInventoryLine(client, {
  sessionId,
  productId,
  quantityAfter,
  whId,
  profileId,
  reasonBase,
  lineReasonSuffix = null,
}) {
  await assertProductAllowedInProfile(client, productId, profileId);
  const before = await getPwsQuantity(client, productId, whId);

  await client.query(
    `INSERT INTO inventory_session_lines (session_id, product_id, quantity_before, quantity_after)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, productId, before, quantityAfter]
  );

  if (before === quantityAfter) {
    return { applied: false, productId, counted: true };
  }

  await setPwsQuantity(client, productId, whId, quantityAfter);

  const delta = quantityAfter - before;
  const reason = lineReasonSuffix ? `${reasonBase}: ${lineReasonSuffix}` : reasonBase;
  await stockMovementsRepositoryPG.insertSnapshotAfterProduct(client, {
    productId,
    type: 'inventory',
    quantityChange: delta,
    reason,
    meta: { inventory_session_id: sessionId, warehouse_id: whId },
    warehouseId: whId,
    profileId: null,
  });

  return { applied: true, productId, counted: true };
}

async function runInventoryLines(client, {
  sessionId,
  whId,
  profileId,
  linesInput,
  zeroUnlisted,
  reasonBase,
}) {
  const listedIds = new Set();
  let applied = 0;
  const affectedProductIds = new Set();

  for (const raw of linesInput) {
    const productId = parseLineProductId(raw);
    const quantityAfter = parseLineQuantityAfter(raw);
    if (!productId) continue;

    listedIds.add(productId);
    const { applied: lineApplied, productId: pid } = await applyInventoryLine(client, {
      sessionId,
      productId,
      quantityAfter,
      whId,
      profileId,
      reasonBase,
    });
    if (lineApplied) {
      applied++;
    }
    if (pid) {
      affectedProductIds.add(pid);
    }
  }

  // Без хотя бы одной пересчитанной позиции не обнуляем весь склад (защита от пустого/битого lines).
  if (zeroUnlisted && listedIds.size > 0) {
    const unlisted = await findUnlistedWithStock(client, whId, profileId, listedIds);
    for (const row of unlisted) {
      const productId = parseInt(row.product_id, 10);
      if (!productId || Number.isNaN(productId)) continue;
      const { applied: lineApplied, productId: pid } = await applyInventoryLine(client, {
        sessionId,
        productId,
        quantityAfter: 0,
        whId,
        profileId,
        reasonBase,
        lineReasonSuffix: 'не пересчитан — списание до 0',
      });
      if (lineApplied) {
        applied++;
        affectedProductIds.add(pid);
      }
    }
  }

  return { applied, productIds: [...affectedProductIds] };
}

async function afterInventoryTouch(sessionId, productIds) {
  if (!sessionId || !Array.isArray(productIds) || productIds.length === 0) return;
  try {
    const { default: ordersService } = await import('./orders.service.js');
    const { default: fboSupplyReserveService } = await import('./fboSupplyReserve.service.js');
    const { recalculateKitsForComponent } = await import('./kitStock.service.js');
    const { syncProductQuantityFromWarehouseStock } =
      await import('./productWarehouseQuantity.service.js');
    let profId = null;
    try {
      const pr = await query(`SELECT profile_id FROM inventory_sessions WHERE id = $1`, [sessionId]);
      profId = pr.rows?.[0]?.profile_id ?? null;
    } catch {
      profId = null;
    }
    for (const pid of productIds) {
      await syncProductQuantityFromWarehouseStock(pid);
      await ordersService.trimExcessReservesForProduct(pid, {
        reason: `После инвентаризации №${sessionId}`,
        meta: { inventory_session_id: sessionId },
      });
      await ordersService.ensureReservesForProductIfSupplyAvailable(pid);
      await fboSupplyReserveService.onSupplyStockEvent(pid, null, { profileId: profId });
      await recalculateKitsForComponent(pid, {});
    }
  } catch {
    // ignore
  }
}

class InventorySessionsService {
  async list({ profileId, limit = 200 } = {}) {
    const lim = Math.min(Math.max(1, parseInt(limit, 10) || 200), 500);
    const pid = normalizeProfileId(profileId);
    const whLabel = `COALESCE(NULLIF(TRIM(w.address), ''), 'Склад #' || w.id::text)`;
    /* Итог в ₽: Σ (после − до) × себестоимость, только строки с известной cost (как в UI деталей). */
    const netRub = `(
      SELECT SUM((l.quantity_after - l.quantity_before)::numeric * p.cost::numeric)
      FROM inventory_session_lines l
      INNER JOIN products p ON p.id = l.product_id
      WHERE l.session_id = s.id
        AND p.cost IS NOT NULL
    ) AS net_amount_rub`;
    if (pid != null) {
      const res = await query(
        `SELECT s.id, s.created_at, s.lines_count, s.note, s.profile_id, s.warehouse_id,
                s.created_by_user_id,
                u.email AS created_by_email,
                u.full_name AS created_by_full_name,
                ${whLabel} AS warehouse_label,
                ${netRub}
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
              ${whLabel} AS warehouse_label,
              ${netRub}
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
   * @param {{ userId: number|null, profileId: number|string|null, note?: string, warehouseId?: number|string|null, zeroUnlisted?: boolean }} ctx
   */
  async apply(linesInput, {
    userId = null,
    profileId = null,
    note = null,
    warehouseId = null,
    zeroUnlisted = true,
  } = {}) {
    if (!Array.isArray(linesInput) || linesInput.length === 0) {
      const err = new Error('Передайте непустой массив lines');
      err.statusCode = 400;
      throw err;
    }
    const uid = userId != null ? parseInt(userId, 10) : null;
    const pid = normalizeProfileId(profileId);
    const zeroUnlistedFlag = zeroUnlisted !== false;

    const result = await transaction(async (client) => {
      const whId = await requireInventoryWarehouseId(client, warehouseId);

      const ins = await client.query(
        `INSERT INTO inventory_sessions (created_by_user_id, profile_id, lines_count, note, warehouse_id)
         VALUES ($1, $2, 0, $3, $4)
         RETURNING id`,
        [uid && !Number.isNaN(uid) ? uid : null, pid, note || null, whId]
      );
      const sessionId = ins.rows[0].id;
      const reasonBase = `Инвентаризация №${sessionId}`;

      const { applied, productIds } = await runInventoryLines(client, {
        sessionId,
        whId,
        profileId: pid,
        linesInput,
        zeroUnlisted: zeroUnlistedFlag,
        reasonBase,
      });

      const linesRecorded = await client.query(
        `SELECT COUNT(*)::int AS c FROM inventory_session_lines WHERE session_id = $1`,
        [sessionId]
      );
      const linesCount = linesRecorded.rows?.[0]?.c ?? 0;

      if (linesCount === 0) {
        await client.query('DELETE FROM inventory_sessions WHERE id = $1', [sessionId]);
        return {
          sessionId: null,
          linesApplied: 0,
          productIds: [],
          message: 'Нет пересчитанных позиций — документ не создан',
        };
      }

      await client.query(`UPDATE inventory_sessions SET lines_count = $1 WHERE id = $2`, [linesCount, sessionId]);

      if (applied === 0) {
        return {
          sessionId,
          linesApplied: 0,
          productIds,
          message: 'Расхождений нет, пересчитанные позиции зафиксированы',
        };
      }

      return { sessionId, linesApplied: applied, productIds };
    });

    if (result?.sessionId && result.productIds?.length) {
      await afterInventoryTouch(result.sessionId, result.productIds);
    }

    return result;
  }

  /**
   * Редактирование сохранённой инвентаризации: откат старых строк, применение нового списка.
   */
  async updateSession(sessionId, linesInput, { profileId = null, zeroUnlisted = true } = {}) {
    if (!Array.isArray(linesInput) || linesInput.length === 0) {
      const err = new Error('Передайте непустой массив lines');
      err.statusCode = 400;
      throw err;
    }
    const { session, lines: oldLines } = await this.getById(sessionId, { profileId });
    const sid = session.id;
    const whId = session.warehouse_id;
    if (!whId) {
      const err = new Error('У документа не указан склад');
      err.statusCode = 400;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    const zeroUnlistedFlag = zeroUnlisted !== false;

    const revertProductIds = new Set();
    const result = await transaction(async (client) => {
      for (const line of oldLines || []) {
        const productId = parseInt(line.product_id, 10);
        if (!productId || Number.isNaN(productId)) continue;
        if (pid != null) {
          await assertProductAllowedInProfile(client, productId, pid);
        }
        const qb = line.quantity_before != null ? Number(line.quantity_before) : 0;
        await setPwsQuantity(client, productId, whId, qb);
        revertProductIds.add(productId);
      }

      await client.query('DELETE FROM inventory_session_lines WHERE session_id = $1', [sid]);

      const reasonBase = `Инвентаризация №${sid}`;
      const { applied, productIds } = await runInventoryLines(client, {
        sessionId: sid,
        whId,
        profileId: pid,
        linesInput,
        zeroUnlisted: zeroUnlistedFlag,
        reasonBase,
      });

      const linesRecorded = await client.query(
        `SELECT COUNT(*)::int AS c FROM inventory_session_lines WHERE session_id = $1`,
        [sid]
      );
      const linesCount = linesRecorded.rows?.[0]?.c ?? 0;
      await client.query(`UPDATE inventory_sessions SET lines_count = $1 WHERE id = $2`, [linesCount, sid]);

      if (linesCount === 0) {
        return {
          sessionId: sid,
          linesApplied: 0,
          productIds: [...revertProductIds],
          message: 'Нет пересчитанных позиций в документе',
        };
      }

      return {
        sessionId: sid,
        linesApplied: applied,
        productIds: [...new Set([...revertProductIds, ...productIds])],
      };
    });

    if (result?.sessionId && result.productIds?.length) {
      await afterInventoryTouch(result.sessionId, result.productIds);
    }

    return result;
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

    const del = await transaction(async (client) => {
      const touchedIds = [];
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

        const reverseDelta = qb - qa;

        await stockMovementsRepositoryPG.insertSnapshotAfterProduct(client, {
          productId,
          type: 'manual',
          quantityChange: reverseDelta,
          reason,
          meta: { inventory_session_id: sid, deleted: true, warehouse_id: whId },
          warehouseId: whId || null,
          profileId: null,
        });
        touchedIds.push(productId);
      }

      await client.query('DELETE FROM inventory_sessions WHERE id = $1', [sid]);
      return { deleted: true, id: sid, productIds: [...new Set(touchedIds)] };
    });

    if (del?.productIds?.length) {
      try {
        const { default: ordersService } = await import('./orders.service.js');
        const { syncProductQuantityFromWarehouseStock } =
          await import('./productWarehouseQuantity.service.js');
        for (const pid of del.productIds) {
          await syncProductQuantityFromWarehouseStock(pid);
          await ordersService.ensureReservesForProductIfSupplyAvailable(pid);
        }
      } catch {
        // ignore
      }
    }

    return del;
  }
}

export default new InventorySessionsService();
