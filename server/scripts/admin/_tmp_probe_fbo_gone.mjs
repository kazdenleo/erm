import 'dotenv/config';
import { query } from '../../src/config/database.js';

const byStatus = await query(
  `SELECT status, COUNT(*)::int AS n,
          MAX(updated_at) AS last_upd,
          MAX(created_at) AS last_created
   FROM fbo_supplies
   GROUP BY status
   ORDER BY n DESC`
);
console.log('by_status', byStatus.rows);

const recent = await query(
  `SELECT id, status, marketplace, external_shipment_number AS ship,
          profile_id, updated_at, created_at, ready_at
   FROM fbo_supplies
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 30`
);
console.log('recent_upd', recent.rows);

const openish = await query(
  `SELECT id, status, external_shipment_number AS ship, updated_at
   FROM fbo_supplies
   WHERE status NOT IN ('closed','return','shipped')
   ORDER BY id DESC
   LIMIT 40`
);
console.log('openish_count', openish.rows.length, openish.rows);

const total = await query(`SELECT COUNT(*)::int AS n FROM fbo_supplies`);
console.log('total', total.rows[0]);

// Any status values not in expected set?
const weird = await query(
  `SELECT status, COUNT(*)::int AS n
   FROM fbo_supplies
   WHERE status IS NULL
      OR status NOT IN (
        'new','draft','collecting','packing','ready','shipped','closed','return',
        'acceptance','awaiting','cancelled','in_transit','accepted'
      )
   GROUP BY 1`
);
console.log('weird_status', weird.rows);

// Check if table empty or truncated somehow
const minmax = await query(
  `SELECT MIN(id)::int AS min_id, MAX(id)::int AS max_id,
          COUNT(*)::int AS n,
          COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '1 day')::int AS upd_1d,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')::int AS cre_1d
   FROM fbo_supplies`
);
console.log('minmax', minmax.rows[0]);

process.exit(0);
