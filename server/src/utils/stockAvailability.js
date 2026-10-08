/**
 * Дни отсутствия товара (out of stock) для упущенной выручки и прогноза.
 *
 * Свой склад (FBS): журнал stock_movements (balance_after — общий остаток) + ежедневный снимок
 * product_stock_daily (свои склады + поставщики). День «без товара», если остаток весь день был 0.
 * До появления снимков остаток поставщиков неизвестен: если товар продавался в «пустые» дни
 * (≥ 2 таких дня), считаем его отгружаемым со склада поставщика и такие дни не учитываем.
 *
 * FBO: снапшоты складов МП (state = mp_warehouse). Пропуски между снимками до 7 дней
 * заполняются последним известным состоянием.
 */

import { query } from '../config/database.js';
import { listDaysYmd, addDaysYmd, normMpCode } from './analyticsCommon.js';
import { skuJoinForSnapshot, SQL_SNAPSHOT_MP_NORM } from './marketplaceReportLineSql.js';

const NON_BALANCE_TYPES = ['reserve', 'unreserve', 'incoming'];
const DROPSHIP_MIN_SALE_DAYS = 2;
const FBO_MAX_GAP_DAYS = 7;
const FBO_ACTIVE_LOOKBACK_DAYS = 30;
const MIN_SNAPSHOT_SHARE_OF_MEDIAN = 0.4;

const mskStart = (param) => `(${param}::date)::timestamp AT TIME ZONE 'Europe/Moscow'`;

/**
 * @param {{
 *   profileId: number,
 *   productIds: number[],
 *   fromYmd: string,
 *   toYmd: string,
 *   salesByProductDay?: Map<number, Map<string, number>>,
 * }} opts
 * @returns {Promise<Map<number, { oosDays: Set<string>, supplierBacked: boolean, isKit: boolean }>>}
 */
export async function loadOwnStockOosDays({ profileId, productIds, fromYmd, toYmd, salesByProductDay = null }) {
  const ids = [...new Set((productIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const result = new Map();
  if (!ids.length) return result;
  const days = listDaysYmd(fromYmd, toYmd);

  const [openRes, moveRes, curRes, dailyRes, kitRes, histRes] = await Promise.all([
    query(
      `SELECT DISTINCT ON (product_id) product_id, balance_after
         FROM stock_movements
        WHERE product_id = ANY($1::bigint[])
          AND created_at < ${mskStart('$2')}
          AND balance_after IS NOT NULL
          AND type <> ALL($3::text[])
        ORDER BY product_id, created_at DESC, id DESC`,
      [ids, fromYmd, NON_BALANCE_TYPES]
    ),
    query(
      `SELECT product_id,
              to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS d,
              MAX(balance_after)::int AS mx,
              (array_agg(balance_after ORDER BY created_at DESC, id DESC))[1]::int AS last_bal,
              (array_agg(balance_after - quantity_change ORDER BY created_at, id))[1]::int AS first_open
         FROM stock_movements
        WHERE product_id = ANY($1::bigint[])
          AND created_at >= ${mskStart('$2')}
          AND created_at < ${mskStart('$3')} + INTERVAL '1 day'
          AND balance_after IS NOT NULL
          AND type <> ALL($4::text[])
        GROUP BY 1, 2`,
      [ids, fromYmd, toYmd, NON_BALANCE_TYPES]
    ),
    query(
      `SELECT pws.product_id, SUM(GREATEST(pws.quantity, 0))::int AS q
         FROM product_warehouse_stock pws
         JOIN warehouses w ON w.id = pws.warehouse_id AND w.type <> 'supplier'
        WHERE pws.product_id = ANY($1::bigint[])
        GROUP BY 1`,
      [ids]
    ),
    query(
      `SELECT product_id, to_char(day, 'YYYY-MM-DD') AS d, own_qty, supplier_qty
         FROM product_stock_daily
        WHERE profile_id = $1 AND day >= $2::date AND day <= $3::date
          AND product_id = ANY($4::bigint[])`,
      [profileId, fromYmd, toYmd, ids]
    ),
    query('SELECT DISTINCT kit_product_id FROM kit_components WHERE kit_product_id = ANY($1::bigint[])', [ids]),
    query(
      `SELECT to_char(MIN(created_at) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS d
         FROM stock_movements WHERE product_id = ANY($1::bigint[])`,
      [ids]
    ),
  ]);

  const historyStart = histRes.rows?.[0]?.d || null;
  const opening = new Map((openRes.rows || []).map((r) => [Number(r.product_id), Number(r.balance_after) || 0]));
  const current = new Map((curRes.rows || []).map((r) => [Number(r.product_id), Number(r.q) || 0]));
  const kits = new Set((kitRes.rows || []).map((r) => Number(r.kit_product_id)));

  const moves = new Map();
  for (const r of moveRes.rows || []) {
    const pid = Number(r.product_id);
    if (!moves.has(pid)) moves.set(pid, new Map());
    moves.get(pid).set(r.d, { mx: Number(r.mx) || 0, last: Number(r.last_bal) || 0, firstOpen: Number(r.first_open) || 0 });
  }
  const daily = new Map();
  for (const r of dailyRes.rows || []) {
    const pid = Number(r.product_id);
    if (!daily.has(pid)) daily.set(pid, new Map());
    daily.get(pid).set(r.d, (Number(r.own_qty) || 0) + (Number(r.supplier_qty) || 0));
  }

  for (const pid of ids) {
    const info = { oosDays: new Set(), supplierBacked: false, isKit: kits.has(pid) };
    result.set(pid, info);
    if (info.isKit) continue;

    const pm = moves.get(pid);
    const pd = daily.get(pid);
    let bal = opening.has(pid) ? opening.get(pid) : null;
    if (bal == null && pm) {
      const firstDay = days.find((d) => pm.has(d));
      bal = firstDay ? pm.get(firstDay).firstOpen : null;
    }
    if (bal == null) bal = current.get(pid) ?? 0;

    const historyOos = [];
    for (const d of days) {
      const m = pm?.get(d);
      const dayMax = m ? Math.max(bal, m.mx) : bal;
      if (m) bal = m.last;
      const snap = pd?.get(d);
      if (snap != null) {
        if (snap <= 0 && dayMax <= 0) info.oosDays.add(d);
        continue;
      }
      if (historyStart && d < historyStart) continue;
      if (dayMax <= 0) {
        info.oosDays.add(d);
        historyOos.push(d);
      }
    }

    const sales = salesByProductDay?.get(pid);
    if (sales && historyOos.length) {
      const soldOnEmpty = historyOos.filter((d) => (sales.get(d) || 0) > 0).length;
      if (soldOnEmpty >= DROPSHIP_MIN_SALE_DAYS) {
        info.supplierBacked = true;
        for (const d of historyOos) info.oosDays.delete(d);
      }
    }
  }
  return result;
}

/**
 * Остатки на складах МП по дням.
 * @returns {Promise<{
 *   snapshotDays: Map<string, Set<string>>,
 *   byKey: Map<string, Map<string, number>>,
 *   latest: Map<string, { day: string, qtyByProduct: Map<number, number> }>,
 * }>} byKey: `${mp}|${productId}` → день → остаток (с заполнением пропусков)
 */
export async function loadFboDailyStock({
  profileId,
  fromYmd,
  toYmd,
  mpValues = null,
  lookbackDays = FBO_ACTIVE_LOOKBACK_DAYS,
}) {
  const lookFrom = addDaysYmd(fromYmd, -Math.max(0, lookbackDays));
  const params = [profileId, lookFrom, toYmd];
  let mpClause = '';
  if (mpValues?.length) {
    params.push(mpValues);
    mpClause = `AND s.norm_mp = ANY($${params.length}::text[])`;
  }
  // Сначала сопоставляем уникальные артикулы с товарами (тяжёлый JOIN с OR), затем строки — по равенству.
  const r = await query(
    `WITH snaps AS (
       SELECT s.id, s.norm_mp, s.d
         FROM (
           SELECT id, ${SQL_SNAPSHOT_MP_NORM} AS norm_mp,
                  to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS d
             FROM marketplace_inventory_snapshots
            WHERE profile_id = $1
              AND created_at >= ${mskStart('$2')}
              AND created_at < ${mskStart('$3')} + INTERVAL '1 day'
         ) s
        WHERE 1=1 ${mpClause}
     ),
     lines AS (
       SELECT s.id AS snapshot_id, s.norm_mp, s.d, l.external_sku, l.wb_vendor_code, GREATEST(l.quantity, 0) AS qty
         FROM snaps s
         JOIN marketplace_inventory_snapshot_lines l ON l.snapshot_id = s.id AND l.state = 'mp_warehouse'
     ),
     keys AS (
       SELECT DISTINCT norm_mp, external_sku, wb_vendor_code FROM lines
     ),
     keymap AS (
       SELECT DISTINCT l.norm_mp, l.external_sku, l.wb_vendor_code, p.id AS product_id
         FROM keys l
         CROSS JOIN LATERAL (SELECT l.norm_mp AS norm_mp) s
         ${skuJoinForSnapshot()}
     ),
     per_snap AS (
       SELECT ln.snapshot_id, ln.norm_mp, ln.d, km.product_id, SUM(ln.qty)::int AS qty
         FROM lines ln
         JOIN keymap km
           ON km.norm_mp = ln.norm_mp
          AND km.external_sku IS NOT DISTINCT FROM ln.external_sku
          AND km.wb_vendor_code IS NOT DISTINCT FROM ln.wb_vendor_code
        GROUP BY 1, 2, 3, 4
     )
     SELECT snapshot_id, norm_mp, d, product_id, qty FROM per_snap
     UNION ALL
     SELECT s.id, s.norm_mp, s.d, NULL::bigint,
            COALESCE((SELECT SUM(ln.qty) FROM lines ln WHERE ln.snapshot_id = s.id), 0)::int
       FROM snaps s`,
    params
  );

  // Неполные снимки (сбой выгрузки: 0 строк или резкий провал остатка) не считаем «товара нет».
  const snapTotals = new Map();
  for (const row of r.rows || []) {
    if (row.product_id != null) continue;
    snapTotals.set(String(row.snapshot_id), { mp: normMpCode(row.norm_mp), total: Number(row.qty) || 0 });
  }
  const medianByMp = new Map();
  for (const mp of new Set([...snapTotals.values()].map((s) => s.mp))) {
    const vals = [...snapTotals.values()].filter((s) => s.mp === mp && s.total > 0).map((s) => s.total).sort((a, b) => a - b);
    medianByMp.set(mp, vals.length ? vals[Math.floor(vals.length / 2)] : 0);
  }
  const validSnap = (id) => {
    const s = snapTotals.get(String(id));
    if (!s || s.total <= 0) return false;
    return s.total >= (medianByMp.get(s.mp) || 0) * MIN_SNAPSHOT_SHARE_OF_MEDIAN;
  };

  const snapshotDays = new Map();
  const raw = new Map();
  for (const row of r.rows || []) {
    if (!validSnap(row.snapshot_id)) continue;
    const mp = normMpCode(row.norm_mp);
    if (!snapshotDays.has(mp)) snapshotDays.set(mp, new Set());
    snapshotDays.get(mp).add(row.d);
    if (row.product_id == null) continue;
    const key = `${mp}|${Number(row.product_id)}`;
    if (!raw.has(key)) raw.set(key, new Map());
    const perDay = raw.get(key);
    perDay.set(row.d, Math.max(perDay.get(row.d) || 0, Number(row.qty) || 0));
  }

  const allDays = listDaysYmd(lookFrom, toYmd);
  const byKey = new Map();
  for (const [key, perDay] of raw.entries()) {
    const mp = key.split('|')[0];
    const known = snapshotDays.get(mp) || new Set();
    const filled = new Map();
    let lastQty = null;
    let lastDayIdx = -1;
    allDays.forEach((d, idx) => {
      if (known.has(d)) {
        lastQty = perDay.get(d) ?? 0;
        lastDayIdx = idx;
        filled.set(d, lastQty);
      } else if (lastQty != null && idx - lastDayIdx <= FBO_MAX_GAP_DAYS) {
        filled.set(d, lastQty);
      }
    });
    byKey.set(key, filled);
  }

  const latest = new Map();
  for (const [mp, set] of snapshotDays.entries()) {
    const day = [...set].sort().pop();
    const qtyByProduct = new Map();
    for (const [key, perDay] of raw.entries()) {
      if (!key.startsWith(`${mp}|`)) continue;
      qtyByProduct.set(Number(key.split('|')[1]), perDay.get(day) ?? 0);
    }
    latest.set(mp, { day, qtyByProduct });
  }

  return { snapshotDays, byKey, latest, lookFrom };
}
