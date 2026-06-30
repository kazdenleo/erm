/**
 * Поиск заказов и id для привязки позиций закупки к заказам маркетплейса.
 */

import { query } from '../config/database.js';

export function orderMarketplaceToDb(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'ym' || m === 'yandexmarket') return 'ym';
  if (m === 'manual') return 'manual';
  return m === 'ozon' ? 'ozon' : 'ozon';
}

export function marketplaceVariantsForLookup(marketplace) {
  return [
    ...new Set(
      [marketplace, orderMarketplaceToDb(marketplace), String(marketplace || '').toLowerCase()]
        .filter(Boolean)
        .map((m) => String(m).toLowerCase())
    ),
  ];
}

async function loadOrderRowsForLookup(profileId, marketplace, orderId) {
  const dbMp = orderMarketplaceToDb(marketplace);
  const oid = String(orderId ?? '').trim();
  if (!dbMp || !oid) return [];

  const head = await query(
    `SELECT o.id, o.marketplace, o.order_id, o.order_group_id
     FROM orders o
     WHERE o.profile_id = $1 AND o.marketplace = $2 AND o.order_id = $3
     LIMIT 1`,
    [profileId, dbMp, oid]
  );
  const row = head.rows?.[0];
  if (!row) return [];

  const gid = row.order_group_id != null ? String(row.order_group_id).trim() : '';
  if (gid) {
    const group = await query(
      `SELECT o.id, o.marketplace, o.order_id, o.order_group_id
       FROM orders o
       WHERE o.profile_id = $1 AND o.order_group_id = $2
       ORDER BY o.id ASC`,
      [profileId, gid]
    );
    return group.rows || [];
  }
  return [row];
}

/** Все id заказа для сопоставления с source_orders (группа, ozon prefix и т.д.). */
export async function orderIdsForPurchaseLookup(profileId, marketplace, orderId) {
  const rows = await loadOrderRowsForLookup(profileId, marketplace, orderId);
  const ids = new Set();
  const addId = (raw) => {
    const s = String(raw ?? '').trim();
    if (!s) return;
    ids.add(s.toLowerCase());
  };
  addId(orderId);
  for (const row of rows) {
    addId(row.order_id);
    const gid = row.order_group_id != null ? String(row.order_group_id).trim() : '';
    if (gid) {
      addId(gid);
      const tilde = gid.indexOf('~');
      if (tilde > 0) addId(gid.slice(0, tilde));
    }
  }
  return [...ids];
}

export async function buildOrderSupplierSubmitScope(profileId, marketplace, orderId) {
  return {
    marketplace,
    orderId: String(orderId ?? '').trim(),
    lookupIds: await orderIdsForPurchaseLookup(profileId, marketplace, orderId),
    marketplaceVariants: marketplaceVariantsForLookup(marketplace),
  };
}
