/**
 * Локальный профиль + админ аккаунта без SMTP (почта на localhost не нужна).
 *
 *   cd server
 *   npm run seed-local-profile
 *
 * Переменные (опционально):
 *   LOCAL_PROFILE_NAME=Локальный аккаунт
 *   LOCAL_USER_EMAIL=local@localhost
 *   LOCAL_USER_PASSWORD=local123
 *   LOCAL_USER_NAME=Локальный Админ
 */

import bcrypt from 'bcrypt';
import { query, closePool } from '../src/config/database.js';

const SALT_ROUNDS = 10;
const PROFILE_NAME = (process.env.LOCAL_PROFILE_NAME || 'Локальный аккаунт').trim();
const EMAIL = (process.env.LOCAL_USER_EMAIL || 'local@localhost').trim().toLowerCase();
const PASSWORD = process.env.LOCAL_USER_PASSWORD || 'local123';
const FULL_NAME = (process.env.LOCAL_USER_NAME || 'Локальный Админ').trim();

async function main() {
  const existingUser = await query(
    `SELECT id, email, profile_id, role, is_profile_admin
     FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
    [EMAIL]
  );

  if (existingUser.rows.length > 0) {
    const u = existingUser.rows[0];
    if (u.profile_id != null) {
      const passwordHash = await bcrypt.hash(PASSWORD, SALT_ROUNDS);
      await query(
        `UPDATE users
         SET password_hash = $1,
             is_profile_admin = true,
             account_role = 'admin',
             must_change_password = false,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [passwordHash, u.id]
      );
      console.log('Пользователь уже есть — пароль и права обновлены:');
      console.log('  login:', EMAIL);
      console.log('  password:', PASSWORD);
      console.log('  profile_id:', u.profile_id);
      return;
    }
  }

  let profileId;
  const existingProfile = await query(
    `SELECT id FROM profiles WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) ORDER BY id LIMIT 1`,
    [PROFILE_NAME]
  );
  if (existingProfile.rows[0]?.id) {
    profileId = existingProfile.rows[0].id;
  } else {
    const pr = await query(
      `INSERT INTO profiles (name, contact_full_name, contact_email, contact_phone, tariff)
       VALUES ($1, $2, $3, NULL, NULL)
       RETURNING id`,
      [PROFILE_NAME, FULL_NAME, EMAIL]
    );
    profileId = pr.rows[0].id;
  }

  const passwordHash = await bcrypt.hash(PASSWORD, SALT_ROUNDS);

  if (existingUser.rows.length > 0) {
    await query(
      `UPDATE users SET
         password_hash = $1,
         full_name = $2,
         role = 'user',
         profile_id = $3,
         is_profile_admin = true,
         account_role = 'admin',
         must_change_password = false,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [passwordHash, FULL_NAME, profileId, existingUser.rows[0].id]
    );
  } else {
    await query(
      `INSERT INTO users (
         email, password_hash, full_name, role, profile_id,
         is_profile_admin, account_role, must_change_password
       ) VALUES ($1, $2, $3, 'user', $4, true, 'admin', false)`,
      [EMAIL, passwordHash, FULL_NAME, profileId]
    );
  }

  console.log('Создан локальный профиль и пользователь:');
  console.log('  profile:', PROFILE_NAME, `(id=${profileId})`);
  console.log('  login:', EMAIL);
  console.log('  password:', PASSWORD);
  console.log('Войдите на http://localhost:3000/login');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
