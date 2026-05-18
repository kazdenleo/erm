/**
 * Диагностика контекста организации для пользователя по email.
 * Запуск из server: node scripts/admin/debug-user-organization-context.js user@example.com
 */

import { query } from '../../src/config/database.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/admin/debug-user-organization-context.js <email>');
  process.exit(1);
}

const em = String(email).trim().toLowerCase();

const userRes = await query(
  `SELECT id, email, role, profile_id, is_profile_admin, account_role
   FROM users WHERE LOWER(TRIM(email)) = $1`,
  [em]
);
const user = userRes.rows[0];
if (!user) {
  console.log('Пользователь не найден:', em);
  process.exit(0);
}

console.log('User:', {
  id: user.id,
  email: user.email,
  role: user.role,
  profile_id: user.profile_id,
  is_profile_admin: user.is_profile_admin,
  account_role: user.account_role,
});

if (user.profile_id != null) {
  const orgRes = await query(
    `SELECT id, name, profile_id FROM organizations WHERE profile_id = $1 ORDER BY id`,
    [user.profile_id]
  );
  console.log(`Organizations for profile_id=${user.profile_id}:`, orgRes.rows.length);
  for (const o of orgRes.rows) {
    console.log('  -', o.id, o.name, 'profile_id=', o.profile_id);
  }
  if (orgRes.rows.length === 0) {
    console.log('  (нет организаций — пользователь войдёт, но без контекста организации)');
  }
} else {
  console.log('profile_id пуст — списки тенанта пустые, контекст org из заголовка (если есть).');
}

const orphanOrgs = await query(
  `SELECT o.id, o.name, o.profile_id
   FROM organizations o
   WHERE EXISTS (
     SELECT 1 FROM users u
     WHERE LOWER(TRIM(u.email)) = $1
       AND u.profile_id IS NOT NULL
       AND o.profile_id IS DISTINCT FROM u.profile_id
   )
   LIMIT 5`,
  [em]
);
if (orphanOrgs.rows.length) {
  console.log('Примечание: есть организации в системе с другим profile_id (не ваши):', orphanOrgs.rows);
}

process.exit(0);
