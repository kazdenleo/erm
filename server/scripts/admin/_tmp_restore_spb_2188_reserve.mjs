import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';
import { query } from '../../src/config/database.js';
import { NET_RESERVED_MOVEMENT_ROW_CASE_SQL } from '../../src/constants/netReservedStockSql.js';

async function main() {
  console.log('rebalance kit 397…');
  await fboSupplyReserveService.rebalanceReservesForProduct(397, {
    profileId: 6,
    skipMarketplaceSync: true,
  });
  console.log('done');

  const r = await query(
    `SELECT meta->>'fbo_supply_id' AS supply_id,
            meta->>'fbo_supply_item_id' AS item_id,
            product_id,
            GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
     FROM stock_movements
     WHERE meta->>'fbo_supply_id' = ANY($1::text[])
       AND type IN ('reserve', 'unreserve')
       AND product_id = ANY($2::bigint[])
     GROUP BY 1, 2, 3
     HAVING GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0)) > 0
     ORDER BY 1, 3`,
    [['197', '199', '201', '202', '203', '204'], [519, 520]]
  );
  console.log('NETS_AFTER', JSON.stringify(r.rows, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
