/**
 * Доп. сверка: профиль «Зеленоглазое», стратегии, WB vs Ozon/YM.
 */
import { query, closePool } from '../../src/config/database.js';

async function main() {
  const cols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'pricing_strategies' ORDER BY ordinal_position`
  );
  console.log('pricing_strategies columns:', cols.rows.map((r) => r.column_name));

  const strategies = await query(`SELECT * FROM pricing_strategies ORDER BY id LIMIT 20`);
  console.log('strategies count', strategies.rows.length);
  for (const s of strategies.rows) console.log(JSON.stringify(s));

  const taxi = await query(
    `SELECT p.id, p.sku, p.cost, pmp.marketplace, pmp.min_price, pmp.selling_price,
            ROUND(((pmp.selling_price - pmp.min_price) / NULLIF(pmp.min_price,0) * 100)::numeric, 1) AS sell_over_min_pct
     FROM products p
     JOIN organizations o ON o.id = p.organization_id
     JOIN product_marketplace_prices pmp ON pmp.product_id = p.id
     WHERE o.id = 1 AND p.cost > 0 AND pmp.min_price > 0
     ORDER BY pmp.updated_at DESC NULLS LAST
     LIMIT 18`
  );
  console.log('\n=== org1 Зеленоглазое sample ===');
  for (const r of taxi.rows) console.log(JSON.stringify(r));

  const dist = await query(
    `SELECT o.id AS org_id, pmp.marketplace,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE pmp.selling_price IS NOT NULL AND ABS(pmp.selling_price - pmp.min_price) < 0.51)::int AS sell_eq_min,
            COUNT(*) FILTER (WHERE pmp.selling_price IS NOT NULL AND pmp.selling_price > pmp.min_price + 0.5)::int AS sell_above_min,
            COUNT(*) FILTER (WHERE pmp.selling_price IS NOT NULL AND pmp.selling_price + 0.01 < pmp.min_price)::int AS sell_below_min,
            COUNT(*) FILTER (WHERE pmp.selling_price IS NOT NULL AND p.cost IS NOT NULL AND pmp.selling_price + 0.01 < p.cost)::int AS sell_below_cost
     FROM product_marketplace_prices pmp
     JOIN products p ON p.id = pmp.product_id
     JOIN organizations o ON o.id = p.organization_id
     WHERE pmp.min_price IS NOT NULL AND pmp.min_price > 0
     GROUP BY o.id, pmp.marketplace
     ORDER BY o.id, pmp.marketplace`
  );
  console.log('\n=== distribution sell vs min ===');
  for (const r of dist.rows) console.log(JSON.stringify(r));

  const recentPush = await query(
    `SELECT id, created_at, status, meta
     FROM runtime_notifications
     WHERE type ILIKE '%price%' OR type ILIKE '%push%'
     ORDER BY id DESC LIMIT 5`
  ).catch(() => ({ rows: [] }));
  console.log('\n=== recent price-ish notifications ===');
  for (const r of recentPush.rows) console.log(JSON.stringify(r));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
