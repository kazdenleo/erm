import { query, closePool } from '../../src/config/database.js';

const email = process.argv[2] || 'kazakov-denis@list.ru';

async function main() {
  let res = await query(
    `SELECT u.id, u.email, u.role, u.profile_id, u.is_profile_admin, u.account_role,
            p.name AS profile_name, p.role_nav_sections
     FROM users u
     LEFT JOIN profiles p ON p.id = u.profile_id
     WHERE LOWER(TRIM(u.email)) = LOWER(TRIM($1))
     LIMIT 1`,
    [email]
  );
  if (!res.rows[0]) {
    res = await query(
      `SELECT u.id, u.email, u.role, u.profile_id, u.is_profile_admin, u.account_role,
              p.name AS profile_name
       FROM users u
       LEFT JOIN profiles p ON p.id = u.profile_id
       WHERE u.email ILIKE $1
       ORDER BY u.email
       LIMIT 10`,
      [`%${email.split('@')[0]}%`]
    );
    if (res.rows.length > 0) {
      console.log('Exact user not found. Similar:');
      for (const row of res.rows) printUser(row);
      return;
    }
    const all = await query(
      `SELECT u.id, u.email, u.role, u.profile_id, u.is_profile_admin, u.account_role
       FROM users u ORDER BY u.id LIMIT 30`
    );
    console.log('User not found:', email);
    console.log('All users in DB (' + all.rows.length + '):');
    for (const row of all.rows) {
      console.log(`  ${row.id} ${row.email} role=${row.role} profile=${row.profile_id} admin=${row.is_profile_admin} ar=${row.account_role}`);
    }
    return;
  }
  const u = res.rows[0];
  if (!u) {
    console.log('User not found:', email);
    return;
  }
  printUser(u);
}

function printUser(u) {
  const accountRole = String(u.account_role ?? '').trim().toLowerCase();
  const isTenantAdmin =
    u.role !== 'admin' &&
    u.profile_id != null &&
    (u.is_profile_admin === true || accountRole === 'admin');

  console.log(JSON.stringify({
    id: u.id,
    email: u.email,
    role: u.role,
    profile_id: u.profile_id,
    profile_name: u.profile_name,
    is_profile_admin: u.is_profile_admin,
    account_role: u.account_role,
    is_tenant_account_admin: isTenantAdmin,
    role_nav_sections: u.role_nav_sections,
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
