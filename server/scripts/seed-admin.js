/**
 * Создание первого пользователя с ролью администратора продукта (role=admin).
 * Администратор аккаунта клиента — это role=user + is_profile_admin + profile_id (не этот скрипт).
 * Запуск: node scripts/seed-admin.js
 * Можно задать переменные: ADMIN_EMAIL=admin ADMIN_PASSWORD=admin
 */

import bcrypt from 'bcrypt';
import { query } from '../src/config/database.js';

const SALT_ROUNDS = 10;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

async function seedAdmin() {
  const existing = await query(
    'SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))',
    [ADMIN_EMAIL]
  );
  if (existing.rows.length > 0) {
    console.log('Администратор с таким email уже существует:', ADMIN_EMAIL);
    process.exit(0);
    return;
  }
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);
  await query(
    `INSERT INTO users (email, password_hash, full_name, role, profile_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [ADMIN_EMAIL, passwordHash, 'Администратор', 'admin', null]
  );
  console.log('Создан администратор:', ADMIN_EMAIL);
  console.log('Пароль:', ADMIN_PASSWORD);
  process.exit(0);
}

seedAdmin().catch((err) => {
  console.error(err);
  process.exit(1);
});
