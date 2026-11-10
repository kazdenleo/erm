import 'dotenv/config';
import { query } from '../../src/config/database.js';
import fboSuppliesService from '../../src/services/fboSupplies.service.js';

const byStatus = await query(
  `SELECT status, COUNT(*)::int AS n FROM fbo_supplies GROUP BY 1 ORDER BY 2 DESC`
);
console.log('by_status', byStatus.rows);

const open = await query(
  `SELECT id, status, external_shipment_number AS ship, profile_id, updated_at
   FROM fbo_supplies
   WHERE status NOT IN ('closed','return','shipped')
   ORDER BY id DESC`
);
console.log('open', open.rows);

const statuses = ['new', 'collecting', 'packing', 'ready_for_supply'];
for (const profileId of [6, null, 1, 2, 3, 4, 5]) {
  try {
    const list = await fboSuppliesService.list({
      profileId,
      limit: 50,
      statuses,
      skipReserveTotals: true,
    });
    console.log('list_profile', profileId, 'n=', list.length, list.slice(0, 3).map((s) => s.id));
  } catch (e) {
    console.log('list_profile_fail', profileId, e.message);
  }
}

// How does HTTP route resolve profile?
const profiles = await query(
  `SELECT id, name, is_active, fbo_enabled FROM profiles ORDER BY id`
).catch(async () => {
  const cols = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='profiles'`
  );
  console.log('profile_cols', cols.rows.map((r) => r.column_name));
  return query(`SELECT id, name FROM profiles ORDER BY id`);
});
console.log('profiles', profiles.rows);

process.exit(0);
