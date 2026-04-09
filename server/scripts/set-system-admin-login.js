/**
 * Один раз выставляет логин и пароль администратора продукта: admin / admin
 * (обновляет существующего admin без профиля или бывший platform-admin@local).
 *
 *   cd server && npm run set-system-admin-login
 */

import bcrypt from 'bcrypt';
import { query, closePool } from '../src/config/database.js';

const SALT = 10;
const LOGIN = 'admin';
const PASSWORD = 'admin';

async function findTargetAdminId() {
  const r1 = await query(
    `SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
    ['platform-admin@local']
  );
  if (r1.rows[0]) return r1.rows[0].id;

  const r2 = await query(
    `SELECT id FROM users WHERE role = 'admin' AND profile_id IS NULL ORDER BY id ASC LIMIT 1`
  );
  if (r2.rows[0]) return r2.rows[0].id;

  const r3 = await query(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`);
  return r3.rows[0]?.id ?? null;
}

async function main() {
  const targetId = await findTargetAdminId();
  if (!targetId) {
    console.error('Не найден пользователь с ролью admin. Сначала: npm run create-platform-admin');
    await closePool();
    process.exit(1);
    return;
  }

  const hash = await bcrypt.hash(PASSWORD, SALT);

  const conflict = await query(
    `SELECT id, email FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) AND id <> $2`,
    [LOGIN, targetId]
  );
  if (conflict.rows[0]) {
    const displaced = `admin-displaced-${conflict.rows[0].id}@local`;
    await query(`UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [
      displaced,
      conflict.rows[0].id,
    ]);
    console.log('Предыдущий владелец логина admin переименован в:', displaced);
  }

  await query(
    `UPDATE users SET
      email = $1,
      password_hash = $2,
      role = 'admin',
      profile_id = NULL,
      is_profile_admin = false,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $3`,
    [LOGIN, hash, targetId]
  );

  console.log('Администратор продукта: логин «' + LOGIN + '», пароль «' + PASSWORD + '»');
  await closePool();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
