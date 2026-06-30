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
      return {
        marketplace,
        orderId,
        supplierSubmittedAt: x.supplierSubmittedAt ?? x.supplier_submitted_at ?? null,
        supplierBasketItemId: x.supplierBasketItemId ?? x.supplier_basket_item_id ?? null,
      };
    })
    .filter(Boolean);
}

export function isSourceEntrySupplierSubmitted(entry) {
  const at = entry?.supplierSubmittedAt ?? entry?.supplier_submitted_at;
  return at != null && String(at).trim() !== '';
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
  const pendingCount = countPendingSourceEntriesForScope(line, scope);
  if (pendingCount <= 0) return 0;
  const allEntries = parseSourceOrdersEntries(line?.source_orders);
  const expected = Math.max(1, parseInt(line?.expected_quantity, 10) || 1);
  if (pendingCount === 1 && allEntries.length === 1) {
    return expected;
  }
  return pendingCount;
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
        return {
          marketplace: ent.marketplace,
          orderId: ent.orderId,
          supplierSubmittedAt: now,
          ...(basketId != null ? { supplierBasketItemId: basketId } : {}),
        };
      }
      return ent;
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
