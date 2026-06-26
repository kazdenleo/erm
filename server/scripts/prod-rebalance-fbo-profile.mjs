import { query, closePool } from '../src/config/database.js';
import fboSupplyReserveService from '../src/services/fboSupplyReserve.service.js';

const profileId = Number(process.argv[2]) || 6;

console.log(`Старт пересчёта резерва FBO, profile_id=${profileId}...`);
const started = Date.now();

const result = await fboSupplyReserveService.rebalanceReservesForProfile(profileId);

const netR = await query(
  `SELECT GREATEST(0, COALESCE(SUM(${`CASE WHEN type = 'reserve' THEN CASE WHEN quantity_change < 0 THEN -(quantity_change::numeric) ELSE (quantity_change::numeric) END WHEN type = 'unreserve' THEN CASE WHEN quantity_change > 0 THEN -(quantity_change::numeric) ELSE (quantity_change::numeric) END ELSE 0 END`}), 0))::int AS units
   FROM stock_movements sm
   INNER JOIN fbo_supply_items si ON si.id::text = sm.meta->>'fbo_supply_item_id'
   INNER JOIN fbo_supplies s ON s.id = si.fbo_supply_id
   WHERE s.profile_id = $1 AND sm.type IN ('reserve', 'unreserve')`,
  [profileId]
);

console.log('Готово:', result, `за ${Math.round((Date.now() - started) / 1000)}с`);
console.log('Нетто зарезервировано под FBO (шт.):', netR.rows[0]?.units ?? 0);

await closePool();
