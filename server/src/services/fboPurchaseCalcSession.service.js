/**
 * Сессии расчёта закупки FBO: хранение до полного оформления закупок, частичные закупки у разных поставщиков.
 */

import crypto from 'crypto';
import { query, transaction } from '../config/database.js';
import fboSuppliesPurchaseCalcService from './fboSuppliesPurchaseCalc.service.js';
import purchasesService from './purchases.service.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

function normalizeSupplyIds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const out = [];
  for (const raw of list) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

function supplyIdsHash(supplyIds) {
  return crypto.createHash('sha256').update(supplyIds.join(',')).digest('hex');
}

function sortSessionPurchaseRows(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (row.rowType === 'kit' || row.isKitHeader) {
      current = { header: row, components: [] };
      groups.push(current);
      continue;
    }
    if (row.rowType === 'component' && current) {
      current.components.push(row);
      continue;
    }
    current = null;
    groups.push({ header: null, components: [row] });
  }
  groups.sort((ga, gb) => {
    const aDone = ga.header
      ? ga.components.every((r) => r.purchaseComplete)
      : ga.components[0]?.purchaseComplete;
    const bDone = gb.header
      ? gb.components.every((r) => r.purchaseComplete)
      : gb.components[0]?.purchaseComplete;
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aName = ga.header?.productName || ga.components[0]?.productName || '';
    const bName = gb.header?.productName || gb.components[0]?.productName || '';
    return String(aName).localeCompare(String(bName), 'ru');
  });
  const out = [];
  for (const g of groups) {
    if (g.header) out.push(g.header);
    out.push(...g.components);
  }
  return out;
}

function applyRowState(calc, rowStateMaps) {
  const isPurchasable = (row) => row.rowType !== 'kit' && !row.isKitHeader;
  const byKey = rowStateMaps?.byKey || rowStateMaps || new Map();
  const byProductId = rowStateMaps?.byProductId || new Map();
  const productRowCount = new Map();
  for (const row of calc.rows || []) {
    if (!isPurchasable(row) || !row.productId) continue;
    const pid = Number(row.productId);
    productRowCount.set(pid, (productRowCount.get(pid) || 0) + 1);
  }
  const lookupCtx = { byKey, byProductId, productRowCount };

  const rows = sortSessionPurchaseRows(
    (calc.rows || []).map((row) => {
    if (!isPurchasable(row)) {
      return {
        ...row,
        purchasedQty: 0,
        remainingToPurchase: 0,
        lineCostTotal: 0,
        purchaseComplete: true,
      };
    }
    const purchasedQty = resolvePurchasedQty(row, lookupCtx);
    const needQty = Math.max(0, Number(row.toPurchase) || 0);
    const remainingToPurchase = Math.max(0, needQty - purchasedQty);
    const cost = Number(row.cost) || 0;
    const lineCostTotal = Math.round(remainingToPurchase * cost * 100) / 100;
    return {
      ...row,
      purchasedQty,
      remainingToPurchase,
      lineCostTotal,
      purchaseComplete: needQty === 0 || remainingToPurchase === 0,
    };
    })
  );

  const purchasableRows = rows.filter(isPurchasable);
  const totals = purchasableRows.reduce(
    (acc, r) => {
      acc.toPurchaseQty += r.remainingToPurchase || 0;
      acc.purchasedQty += r.purchasedQty || 0;
      acc.needQty += Math.max(0, Number(r.toPurchase) || 0);
      acc.costSum += r.lineCostTotal || 0;
      return acc;
    },
    { toPurchaseQty: 0, purchasedQty: 0, needQty: 0, costSum: 0 }
  );
  totals.costSum = Math.round(totals.costSum * 100) / 100;

  const pendingRows = purchasableRows.filter(
    (r) => (Number(r.toPurchase) || 0) > 0 && (Number(r.remainingToPurchase) || 0) > 0 && r.productId
  );
  const allComplete = pendingRows.length === 0;

  return { ...calc, rows, totals, allComplete, pendingPositions: pendingRows.length };
}

async function loadRowStateMap(sessionId) {
  const r = await query(
    `SELECT row_key, product_id, purchased_qty
     FROM fbo_purchase_calc_row_state
     WHERE session_id = $1`,
    [sessionId]
  );
  const byKey = new Map();
  const byProductId = new Map();
  for (const row of r.rows || []) {
    const purchasedQty = Number(row.purchased_qty) || 0;
    byKey.set(String(row.row_key), {
      purchasedQty,
      productId: row.product_id != null ? Number(row.product_id) : null,
    });
    const pid = row.product_id != null ? Number(row.product_id) : null;
    if (pid != null && pid > 0) {
      byProductId.set(pid, (byProductId.get(pid) || 0) + purchasedQty);
    }
  }
  return { byKey, byProductId };
}

function resolvePurchasedQty(row, { byKey, byProductId, productRowCount }) {
  const direct = byKey.get(String(row.key));
  if (direct) return Math.max(0, Number(direct.purchasedQty) || 0);

  const pid = row.productId != null ? Number(row.productId) : null;
  if (!pid || pid < 1) return 0;

  const legacyKey = `p:${pid}`;
  const legacy = byKey.get(legacyKey);
  if (legacy) return Math.max(0, Number(legacy.purchasedQty) || 0);

  if ((productRowCount.get(pid) || 0) === 1) {
    return Math.max(0, Number(byProductId.get(pid)) || 0);
  }
  return 0;
}

async function assertSessionInProfile(client, sessionId, profileId) {
  const r = await client.query(
    `SELECT id, status, supply_ids FROM fbo_purchase_calc_sessions
     WHERE id = $1 AND profile_id = $2`,
    [sessionId, profileId]
  );
  const row = r.rows?.[0];
  if (!row) {
    const err = new Error('Сессия расчёта не найдена');
    err.statusCode = 404;
    throw err;
  }
  return row;
}

class FboPurchaseCalcSessionService {
  async listOpen({ profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    if (!pid) return [];
    const r = await query(
      `SELECT id, supply_ids, status, created_at, updated_at
       FROM fbo_purchase_calc_sessions
       WHERE profile_id = $1 AND status = 'open'
       ORDER BY updated_at DESC`,
      [pid]
    );
    const base = (r.rows || []).map((row) => ({
      id: Number(row.id),
      supplyIds: row.supply_ids,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const enriched = [];
    for (const session of base) {
      try {
        const supplyIds = normalizeSupplyIds(session.supplyIds);
        const calc = await fboSuppliesPurchaseCalcService.calculate(supplyIds, { profileId: pid });
        const rowStateMaps = await loadRowStateMap(session.id);
        const merged = applyRowState(calc, rowStateMaps);
        enriched.push({
          ...session,
          pendingPositions: merged.pendingPositions ?? 0,
          purchasedQty: merged.totals?.purchasedQty ?? 0,
          toPurchaseQty: merged.totals?.toPurchaseQty ?? 0,
        });
      } catch {
        enriched.push({ ...session, pendingPositions: null, purchasedQty: null, toPurchaseQty: null });
      }
    }
    return enriched;
  }

  /** Найти открытую сессию или создать новую по набору поставок. */
  async openOrCreate(supplyIds, { profileId, userId } = {}) {
    const pid = normalizeProfileId(profileId);
    if (!pid) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const ids = normalizeSupplyIds(supplyIds);
    if (!ids.length) {
      const err = new Error('Укажите хотя бы одну поставку FBO');
      err.statusCode = 400;
      throw err;
    }
    const hash = supplyIdsHash(ids);

    return transaction(async (client) => {
      const existing = await client.query(
        `SELECT id FROM fbo_purchase_calc_sessions
         WHERE profile_id = $1 AND supply_ids_hash = $2 AND status = 'open'
         LIMIT 1`,
        [pid, hash]
      );
      if (existing.rows?.[0]?.id) {
        return { id: Number(existing.rows[0].id), created: false, supplyIds: ids };
      }

      const ins = await client.query(
        `INSERT INTO fbo_purchase_calc_sessions (profile_id, supply_ids, supply_ids_hash)
         VALUES ($1, $2::jsonb, $3)
         RETURNING id`,
        [pid, JSON.stringify(ids), hash]
      );
      return { id: Number(ins.rows[0].id), created: true, supplyIds: ids };
    });
  }

  /** Актуальный расчёт + прогресс закупок по сессии. */
  async getSessionView(sessionId, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    if (!pid) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const sid = parseInt(sessionId, 10);
    if (!sid || Number.isNaN(sid)) {
      const err = new Error('Некорректный ID сессии');
      err.statusCode = 400;
      throw err;
    }

    const head = await query(
      `SELECT id, supply_ids, status, created_at, updated_at, completed_at
       FROM fbo_purchase_calc_sessions
       WHERE id = $1 AND profile_id = $2`,
      [sid, pid]
    );
    const session = head.rows?.[0];
    if (!session) {
      const err = new Error('Сессия расчёта не найдена');
      err.statusCode = 404;
      throw err;
    }

    const supplyIds = normalizeSupplyIds(session.supply_ids);
    const calc = await fboSuppliesPurchaseCalcService.calculate(supplyIds, { profileId: pid });
    const rowStateMaps = await loadRowStateMap(sid);
    const merged = applyRowState(calc, rowStateMaps);

    const linksR = await query(
      `SELECT l.id, l.purchase_id, l.supplier_id, l.items, l.created_at, s.name AS supplier_name
       FROM fbo_purchase_calc_purchase_links l
       LEFT JOIN suppliers s ON s.id = l.supplier_id
       WHERE l.session_id = $1
       ORDER BY l.created_at DESC`,
      [sid]
    );

    if (merged.allComplete && session.status === 'open') {
      await query(
        `UPDATE fbo_purchase_calc_sessions
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'open'`,
        [sid]
      );
      session.status = 'completed';
    }

    return {
      session: {
        id: sid,
        supplyIds,
        status: session.status,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        completedAt: session.completed_at,
      },
      calc: merged,
      purchaseLinks: (linksR.rows || []).map((l) => ({
        id: Number(l.id),
        purchaseId: Number(l.purchase_id),
        supplierId: l.supplier_id != null ? Number(l.supplier_id) : null,
        supplierName: l.supplier_name,
        items: l.items,
        createdAt: l.created_at,
      })),
    };
  }

  /**
   * Создать закупку по выбранным строкам сессии (разные поставщики — отдельные вызовы).
   * items: [{ rowKey, productId, quantity? }] — quantity по умолчанию = remainingToPurchase
   */
  async createPurchaseFromSession(
    sessionId,
    { supplierId, organizationId, warehouseId, items = [], note, userId, profileId } = {}
  ) {
    const pid = normalizeProfileId(profileId);
    if (!pid) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const sid = parseInt(sessionId, 10);
    const supId = parseInt(supplierId, 10);
    if (!sid || Number.isNaN(sid)) {
      const err = new Error('Некорректный ID сессии');
      err.statusCode = 400;
      throw err;
    }
    if (!supId || Number.isNaN(supId)) {
      const err = new Error('Выберите поставщика');
      err.statusCode = 400;
      throw err;
    }
    if (!Array.isArray(items) || items.length === 0) {
      const err = new Error('Выберите хотя бы одну позицию');
      err.statusCode = 400;
      throw err;
    }

    const view = await this.getSessionView(sid, { profileId: pid });
    if (view.session.status !== 'open') {
      const err = new Error('Сессия расчёта уже завершена');
      err.statusCode = 400;
      throw err;
    }

    const rowByKey = new Map((view.calc.rows || []).map((r) => [r.key, r]));
    const purchaseLines = [];
    const linkItems = [];

    for (const it of items) {
      const rowKey = String(it?.rowKey ?? it?.row_key ?? '').trim();
      const productId = parseInt(it?.productId ?? it?.product_id, 10);
      if (!rowKey || !productId || Number.isNaN(productId)) continue;

      const row = rowByKey.get(rowKey);
      if (!row) {
        const err = new Error(`Строка расчёта не найдена: ${rowKey}`);
        err.statusCode = 400;
        throw err;
      }
      if (Number(row.productId) !== productId) {
        const err = new Error(`Несовпадение товара в строке ${rowKey}`);
        err.statusCode = 400;
        throw err;
      }
      const remaining = Math.max(0, Number(row.remainingToPurchase) || 0);
      if (remaining <= 0) {
        const err = new Error(`По позиции «${row.sku || row.productName}» уже оформлена закупка`);
        err.statusCode = 400;
        throw err;
      }
      let qty = it?.quantity != null ? parseInt(it.quantity, 10) : remaining;
      if (!Number.isFinite(qty) || qty < 1) qty = remaining;
      if (qty > remaining) {
        const err = new Error(
          `К закупке по «${row.sku || row.productName}» осталось ${remaining} шт., указано ${qty}`
        );
        err.statusCode = 400;
        throw err;
      }
      purchaseLines.push({ productId, quantity: qty });
      linkItems.push({ rowKey, productId, quantity: qty });
    }

    if (!purchaseLines.length) {
      const err = new Error('Нет валидных позиций для закупки');
      err.statusCode = 400;
      throw err;
    }

    const supplyLabel = (view.session.supplyIds || []).join(', ');
    const purchaseNote =
      note ||
      `FBO расчёт №${sid}, поставки: ${supplyLabel}`;

    const created = await purchasesService.create(
      {
        supplierId: supId,
        organizationId: organizationId != null ? Number(organizationId) : null,
        warehouseId: warehouseId != null ? Number(warehouseId) : null,
        items: purchaseLines,
        note: purchaseNote,
      },
      { userId, profileId: pid, lightIncoming: true }
    );

    const purchaseId = created?.id;

    await transaction(async (client) => {
      await assertSessionInProfile(client, sid, pid);

      for (const li of linkItems) {
        await client.query(
          `INSERT INTO fbo_purchase_calc_row_state (session_id, row_key, product_id, purchased_qty)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (session_id, row_key)
           DO UPDATE SET
             product_id = EXCLUDED.product_id,
             purchased_qty = fbo_purchase_calc_row_state.purchased_qty + EXCLUDED.purchased_qty,
             updated_at = CURRENT_TIMESTAMP`,
          [sid, li.rowKey, li.productId, li.quantity]
        );
      }

      if (purchaseId) {
        await client.query(
          `INSERT INTO fbo_purchase_calc_purchase_links (session_id, purchase_id, supplier_id, items)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [sid, purchaseId, supId, JSON.stringify(linkItems)]
        );
      }

      await client.query(
        `UPDATE fbo_purchase_calc_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [sid]
      );
    });

    const after = await this.getSessionView(sid, { profileId: pid });

    return {
      purchaseId,
      purchase: created,
      session: after.session,
      calc: after.calc,
      purchaseLinks: after.purchaseLinks,
    };
  }
}

export default new FboPurchaseCalcSessionService();
