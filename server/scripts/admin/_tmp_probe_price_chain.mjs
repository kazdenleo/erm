/**
 * Сверка цепочки цен на проде: org auto_push + выборка SKU.
 * node scripts/admin/_tmp_probe_price_chain.mjs
 */
import { query, closePool } from '../../src/config/database.js';

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const orgs = await query(
    `SELECT id, name, profile_id,
            COALESCE(auto_push_marketplace_prices, false) AS auto_push
     FROM organizations
     ORDER BY id`
  );
  console.log('=== organizations.auto_push_marketplace_prices ===');
  for (const o of orgs.rows || []) {
    console.log(
      `org ${o.id} profile=${o.profile_id} auto_push=${o.auto_push} name=${JSON.stringify(o.name)}`
    );
  }

  const envSync = process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
  const pushEnabled = process.env.MARKETPLACE_MIN_PRICE_PUSH_ENABLED;
  console.log('\n=== env ===');
  console.log({
    MARKETPLACE_SYNC_PRICE_TO_MIN: envSync ?? '(default true)',
    MARKETPLACE_MIN_PRICE_PUSH_ENABLED: pushEnabled ?? '(unset)',
  });

  const strategies = await query(
    `SELECT id, profile_id, name, is_active, mode, params
     FROM pricing_strategies
     ORDER BY profile_id NULLS LAST, id
     LIMIT 30`
  ).catch((e) => {
    console.log('pricing_strategies:', e.message);
    return { rows: [] };
  });
  console.log('\n=== pricing_strategies (sample) ===');
  for (const s of strategies.rows || []) {
    console.log({
      id: s.id,
      profile_id: s.profile_id,
      name: s.name,
      active: s.is_active,
      mode: s.mode,
      params: s.params,
    });
  }

  const withStrategy = await query(
    `SELECT COUNT(*)::int AS n FROM products WHERE pricing_strategy_id IS NOT NULL`
  );
  const manualSell = await query(
    `SELECT COUNT(*)::int AS n
     FROM product_marketplace_prices
     WHERE COALESCE(selling_price_manual, false) = true`
  ).catch(() => ({ rows: [{ n: null }] }));

  console.log('\n=== coverage ===');
  console.log({
    productsWithStrategy: withStrategy.rows?.[0]?.n,
    marketplacePricesManualSelling: manualSell.rows?.[0]?.n,
  });

  const sample = await query(
    `SELECT p.id, p.sku, p.name, p.cost, p.pricing_strategy_id, p.organization_id,
            o.name AS org_name, o.auto_push_marketplace_prices AS auto_push,
            ps.name AS strategy_name, ps.mode AS strategy_mode,
            pmp.marketplace,
            pmp.min_price, pmp.min_price_fbs, pmp.min_price_fbo,
            pmp.selling_price, COALESCE(pmp.selling_price_manual, false) AS selling_manual,
            pmp.price_before_discount, pmp.updated_at AS mp_updated_at
     FROM products p
     LEFT JOIN organizations o ON o.id = p.organization_id
     LEFT JOIN pricing_strategies ps ON ps.id = p.pricing_strategy_id
     JOIN product_marketplace_prices pmp ON pmp.product_id = p.id
     WHERE p.cost IS NOT NULL AND p.cost > 0
       AND pmp.min_price IS NOT NULL AND pmp.min_price > 0
       AND COALESCE(o.auto_push_marketplace_prices, false) = true
     ORDER BY pmp.updated_at DESC NULLS LAST
     LIMIT 24`
  );

  console.log('\n=== sample SKUs (auto_push orgs, recent mp prices) ===');
  const issues = [];
  for (const r of sample.rows || []) {
    const cost = num(r.cost);
    const min = num(r.min_price);
    const sell = num(r.selling_price);
    const before = num(r.price_before_discount);
    const row = {
      id: r.id,
      sku: r.sku,
      mp: r.marketplace,
      cost,
      min,
      sell,
      before,
      sellManual: r.selling_manual,
      strategy: r.strategy_name || null,
      mode: r.strategy_mode || null,
      org: r.org_name,
      mpUpdated: r.mp_updated_at,
    };
    const flags = [];
    if (sell != null && min != null && sell + 0.009 < min) flags.push('SELL_BELOW_MIN');
    if (sell != null && cost != null && sell + 0.009 < cost) flags.push('SELL_BELOW_COST');
    if (sell == null && min != null) flags.push('NO_SELLING');
    if (
      !r.selling_manual &&
      !r.pricing_strategy_id &&
      sell != null &&
      min != null &&
      Math.abs(sell - min) < 0.51
    ) {
      flags.push('SELL_EQ_MIN_NO_STRATEGY');
    }
    if (before != null && sell != null && before + 0.009 < sell) flags.push('BEFORE_LT_SELL');
    row.flags = flags;
    if (flags.length) issues.push(row);
    console.log(JSON.stringify(row));
  }

  console.log('\n=== issues in sample ===');
  console.log(JSON.stringify(issues, null, 2));

  const noPushOrgs = (orgs.rows || []).filter((o) => !o.auto_push);
  const pushOrgs = (orgs.rows || []).filter((o) => o.auto_push);
  console.log('\n=== summary ===');
  console.log({
    orgsAutoPushOn: pushOrgs.length,
    orgsAutoPushOff: noPushOrgs.length,
    sampleRows: sample.rows?.length || 0,
    issueRows: issues.length,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
