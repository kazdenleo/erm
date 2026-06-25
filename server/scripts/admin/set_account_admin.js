/**
 * Выдать пользователю права администратора аккаунта (для доступа к Пользователям / Ролям).
 * node scripts/admin/set_account_admin.js <email>
 */
import { query, closePool } from '../../src/config/database.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/admin/set_account_admin.js <email>');
  process.exit(1);
}

async function main() {
  const found = await query(
    `SELECT id, email, role, profile_id, is_profile_admin, account_role FROM users
     WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
    [email]
  );
  const u = found.rows[0];
  if (!u) {
    console.error('Пользователь не найден:', email);
    process.exit(1);
  }
  if (u.role === 'admin') {
    console.error('Это администратор системы (role=admin). Раздел «Пользователи» — у администратора аккаунта.');
    process.exit(1);
  }
  if (u.profile_id == null) {
    console.error('У пользователя нет profile_id. Привяжите к аккаунту.');
    process.exit(1);
  }

  const res = await query(
    `UPDATE users
     SET is_profile_admin = true, account_role = 'admin', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, email, role, profile_id, is_profile_admin, account_role`,
    [u.id]
  );
  console.log('OK:', res.rows[0]);
  console.log('Перелогиньтесь в браузере. Раздел: Настройки → Пользователи → вкладка «Роли».');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
