import { query, closePool } from '../../src/config/database.js';
import {
  resolveNavSectionsForAccountRole,
  isNavSectionEnabled,
} from '../../src/utils/userNavSections.js';

const email = process.argv[2] || 'radzikdaniil@mail.ru';

const u = await query(
  `SELECT u.id, u.email, u.profile_id, u.account_role, p.role_nav_sections
   FROM users u
   JOIN profiles p ON p.id = u.profile_id
   WHERE lower(u.email) = lower($1)
   LIMIT 1`,
  [email]
);
const row = u.rows[0];
console.log('USER', { id: row?.id, email: row?.email, role: row?.account_role, profile_id: row?.profile_id });
console.log('ROLE_NAV_RAW', JSON.stringify(row?.role_nav_sections, null, 2));
const resolved = resolveNavSectionsForAccountRole(row?.role_nav_sections, row?.account_role);
console.log('RESOLVED', resolved);
console.log('shipments enabled?', isNavSectionEnabled(resolved, 'shipments'));
console.log('assembly enabled?', isNavSectionEnabled(resolved, 'assembly'));
console.log('orders enabled?', isNavSectionEnabled(resolved, 'orders'));
await closePool();
