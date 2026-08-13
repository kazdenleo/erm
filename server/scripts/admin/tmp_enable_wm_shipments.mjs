/**
 * Включить раздел «Отгрузки» для роли warehouse_manager в profile.
 * Usage: node scripts/admin/tmp_enable_wm_shipments.mjs [profileId]
 */
import { query, closePool } from '../../src/config/database.js';

const profileId = Number(process.argv[2] || 6);

const r = await query(`SELECT id, role_nav_sections FROM profiles WHERE id = $1`, [profileId]);
const row = r.rows[0];
if (!row) {
  console.error('Profile not found', profileId);
  process.exitCode = 1;
  await closePool();
  process.exit(1);
}

const raw = row.role_nav_sections;
const all = typeof raw === 'string' ? JSON.parse(raw) : { ...(raw || {}) };
const wm = { ...(all.warehouse_manager || {}) };
const before = wm.shipments;
delete wm.shipments;
all.warehouse_manager = wm;

await query(`UPDATE profiles SET role_nav_sections = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [
  JSON.stringify(all),
  profileId,
]);
console.log('OK profile', profileId, 'shipments was', before, '→ removed (enabled)');
await closePool();
