/**
 * Отправка поставщику привязана к заказу МП, а не к локальной закупке.
 * Статус отправки хранится в source_orders каждой строки закупки.
 */

import { query } from '../config/database.js';
import { orderMarketplaceToDb } from './orderPurchaseLookup.js';

export function parseSourceOrdersEntries(raw) {
  if (raw == null) return [];
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const marketplace = String(x.marketplace ?? '').trim();
      const orderId = String(x.orderId ?? x.order_id ?? '').trim();
      if (!marketplace || !orderId) return null;
      const qtyRaw = x.quantity ?? x.qty ?? null;
      const quantity =
        qtyRaw != null && String(qtyRaw).trim() !== ''
          ? Math.max(1, Math.floor(Number(qtyRaw)) || 1)
          : null;
      return {
        marketplace,
        orderId,
        quantity,
        supplierSubmittedAt: x.supplierSubmittedAt ?? x.supplier_submitted_at ?? null,
        supplierBasketItemId: x.supplierBasketItemId ?? x.supplier_basket_item_id ?? null,
      };
    })
    .filter(Boolean);
}

/** Сколько единиц даёт запись source_orders (без quantity — 1, для старых данных). */
export function sourceEntryUnitQty(entry) {
  if (entry?.quantity != null && Number.isFinite(Number(entry.quantity))) {
    return Math.max(1, Math.floor(Number(entry.quantity)) || 1);
  }
  return 1;
}

export function sumSourceEntriesUnitQty(entries) {
  return (entries || []).reduce((s, e) => s + sourceEntryUnitQty(e), 0);
}

export function isSourceEntrySupplierSubmitted(entry) {
  const at = entry?.supplierSubmittedAt ?? entry?.supplier_submitted_at;
  return at != null && String(at).trim() !== '';
}

/**
 * Сколько шт. ещё отправить поставщику по строке закупки.
 * С quantity в source_orders — сумма pending; иначе остаток expected − уже отправленные (legacy 1 шт./запись).
 */
export function pendingSupplierSubmitQuantity(line, pendingEntries = null) {
  const entries = parseSourceOrdersEntries(line?.source_orders);
  const pending =
    pendingEntries != null
      ? pendingEntries
      : entries.filter((e) => !isSourceEntrySupplierSubmitted(e));
  if (!pending.length) return 0;
  const expected = Math.max(1, parseInt(line?.expected_quantity, 10) || 1);
  if (pending.length >= entries.length && entries.length > 0) {
    return expected;
  }
  const submitted = entries.filter((e) => isSourceEntrySupplierSubmitted(e));
  const hasExplicitQty =
    pending.some((e) => e.quantity != null) || submitted.some((e) => e.quantity != null);
  if (hasExplicitQty) {
    return Math.min(expected, Math.max(1, sumSourceEntriesUnitQty(pending)));
  }
  const residual = Math.max(0, expected - sumSourceEntriesUnitQty(submitted));
  return Math.min(expected, Math.max(1, residual || pending.length));
}

function marketplaceEntryMatchesVariants(entryMarketplace, variants) {
  const mp = String(entryMarketplace || '').toLowerCase();
  const dbMp = orderMarketplaceToDb(entryMarketplace);
  const set = new Set((variants || []).map((v) => String(v).toLowerCase()));
  return set.has(mp) || set.has(dbMp);
}

export function sourceEntryMatchesOrderScope(entry, scope) {
  if (!entry || !scope) return false;
  const lookupIds = new Set((scope.lookupIds || []).map((id) => String(id).toLowerCase()));
  const oid = String(entry.orderId ?? '').toLowerCase();
  if (!lookupIds.has(oid)) return false;
  return marketplaceEntryMatchesVariants(entry.marketplace, scope.marketplaceVariants || []);
}

export function countPendingSourceEntriesForScope(line, scope) {
  const entries = parseSourceOrdersEntries(line?.source_orders);
  return entries.filter(
    (ent) => sourceEntryMatchesOrderScope(ent, scope) && !isSourceEntrySupplierSubmitted(ent)
  ).length;
}

export function orderScopeHasPendingSupplierLines(lines, scope) {
  const list = Array.isArray(lines) ? lines : [];
  return list.some((line) => quantityForOrderScopeLine(line, scope) > 0);
}

/** Количество для отправки по одной строке закупки в рамках заказа. */
export function quantityForOrderScopeLine(line, scope) {
  const entries = parseSourceOrdersEntries(line?.source_orders);
  const pendingForScope = entries.filter(
    (ent) => sourceEntryMatchesOrderScope(ent, scope) && !isSourceEntrySupplierSubmitted(ent)
  );
  if (!pendingForScope.length) return 0;
  const expected = Math.max(1, parseInt(line?.expected_quantity, 10) || 1);
  const scopeOnly = entries.filter((ent) => sourceEntryMatchesOrderScope(ent, scope));
  if (scopeOnly.length === 1 && entries.length === 1) {
    return expected;
  }
  const hasExplicitQty = pendingForScope.some((e) => e.quantity != null);
  if (hasExplicitQty) {
    return Math.min(expected, Math.max(1, sumSourceEntriesUnitQty(pendingForScope)));
  }
  // Один заказ в строке с несколькими source — остаток expected после чужих submitted.
  if (pendingForScope.length === 1 && scopeOnly.length === 1) {
    const othersSubmitted = entries.filter(
      (e) => !sourceEntryMatchesOrderScope(e, scope) && isSourceEntrySupplierSubmitted(e)
    );
    const residual = Math.max(0, expected - sumSourceEntriesUnitQty(othersSubmitted));
    return Math.min(expected, Math.max(1, residual || 1));
  }
  return Math.min(expected, Math.max(1, sumSourceEntriesUnitQty(pendingForScope)));
}

/** Строки закупки → позиции для API поставщика только по выбранному заказу. */
export function selectLinesForOrderSupplierSubmit(lines, scope, { force = false } = {}) {
  const out = [];
  for (const line of lines || []) {
    const qty = force
      ? Math.max(1, parseInt(line?.expected_quantity, 10) || 1)
      : quantityForOrderScopeLine(line, scope);
    if (qty <= 0) continue;
    out.push({
      ...line,
      expected_quantity: qty,
      purchase_item_id: line.purchase_item_id ?? line.purchaseItemId,
    });
  }
  return out;
}

function serializeSourceEntry(ent, overrides = {}) {
  const merged = { ...ent, ...overrides };
  const out = {
    marketplace: merged.marketplace,
    orderId: merged.orderId,
  };
  if (merged.quantity != null) out.quantity = sourceEntryUnitQty(merged);
  if (merged.supplierSubmittedAt != null && String(merged.supplierSubmittedAt).trim() !== '') {
    out.supplierSubmittedAt = merged.supplierSubmittedAt;
  }
  if (merged.supplierBasketItemId != null && String(merged.supplierBasketItemId).trim() !== '') {
    out.supplierBasketItemId = merged.supplierBasketItemId;
  }
  return out;
}

export async function markOrderSourceOrdersSubmitted(purchaseId, scope, submittedResults = []) {
  const pid = Number(purchaseId);
  if (!Number.isFinite(pid) || pid < 1 || !scope) return;

  const byProduct = new Map();
  for (const sl of submittedResults || []) {
    const productId = Number(sl.productId ?? sl.product_id);
    if (!Number.isFinite(productId) || productId < 1) continue;
    const basketId = sl.basketItemId ?? sl.supplierBasketItemId ?? sl.supplierOrderId ?? null;
    byProduct.set(productId, basketId);
  }

  const items = await query(
    `SELECT id, product_id, source_orders FROM purchase_items WHERE purchase_id = $1`,
    [pid]
  );
  const now = new Date().toISOString();

  for (const row of items.rows || []) {
    const sources = parseSourceOrdersEntries(row.source_orders);
    if (!sources.length) continue;
    const productId = Number(row.product_id);
    const basketId = byProduct.get(productId);
    let changed = false;
    const next = sources.map((ent) => {
      if (sourceEntryMatchesOrderScope(ent, scope) && !isSourceEntrySupplierSubmitted(ent)) {
        changed = true;
        return serializeSourceEntry(ent, {
          supplierSubmittedAt: now,
          ...(basketId != null ? { supplierBasketItemId: basketId } : {}),
        });
      }
      return serializeSourceEntry(ent);
    });
    if (changed) {
      await query(
        `UPDATE purchase_items
         SET source_orders = $2::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, JSON.stringify(next)]
      );
    }
  }
}

/** Пометить source_orders отправленными для строк, ушедших в API (отправка всей закупки). */
export async function markPurchaseLinesSourceOrdersSubmitted(purchaseId, lines = [], submittedResults = []) {
  const pid = Number(purchaseId);
  if (!Number.isFinite(pid) || pid < 1) return;

  const byProduct = new Map();
  for (const sl of submittedResults || []) {
    const productId = Number(sl.productId ?? sl.product_id);
    if (!Number.isFinite(productId) || productId < 1) continue;
    const basketId = sl.basketItemId ?? sl.supplierBasketItemId ?? sl.supplierOrderId ?? null;
    byProduct.set(productId, basketId);
  }

  const lineIds = new Set();
  const productIds = new Set();
  for (const line of lines || []) {
    const itemId = Number(line.purchase_item_id ?? line.purchaseItemId ?? line.id);
    if (Number.isFinite(itemId) && itemId > 0) lineIds.add(itemId);
    const productId = Number(line.product_id ?? line.productId);
    if (Number.isFinite(productId) && productId > 0) productIds.add(productId);
  }

  const items = await query(
    `SELECT id, product_id, source_orders FROM purchase_items WHERE purchase_id = $1`,
    [pid]
  );
  const now = new Date().toISOString();

  for (const row of items.rows || []) {
    const itemId = Number(row.id);
    const productId = Number(row.product_id);
    const match =
      (lineIds.size > 0 && lineIds.has(itemId)) ||
      (productIds.size > 0 && productIds.has(productId)) ||
      (lineIds.size === 0 && productIds.size === 0);
    if (!match) continue;

    const sources = parseSourceOrdersEntries(row.source_orders);
    if (!sources.length) continue;
    const basketId = byProduct.get(productId);
    let changed = false;
    const next = sources.map((ent) => {
      if (isSourceEntrySupplierSubmitted(ent)) return serializeSourceEntry(ent);
      changed = true;
      return serializeSourceEntry(ent, {
        supplierSubmittedAt: now,
        ...(basketId != null ? { supplierBasketItemId: basketId } : {}),
      });
    });
    if (changed) {
      await query(
        `UPDATE purchase_items
         SET source_orders = $2::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, JSON.stringify(next)]
      );
    }
  }
}
