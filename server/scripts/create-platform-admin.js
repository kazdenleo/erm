/**
 * Создание администратора продукта (role=admin, без профиля) или повышение существующего пользователя.
 *
 *   cd server && npm run create-platform-admin
 *
 * Параметры (опционально): PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD, PLATFORM_ADMIN_NAME
 */

import bcrypt from 'bcrypt';
import { query, closePool } from '../src/config/database.js';

const SALT_ROUNDS = 10;
const EMAIL = (process.env.PLATFORM_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin').trim();
const PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'admin';
const FULL_NAME = process.env.PLATFORM_ADMIN_NAME || 'Администратор продукта';

async function main() {
  const existing = await query(
    `SELECT id, role, email FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
    [EMAIL]
  );

  const passwordHash = await bcrypt.hash(PASSWORD, SALT_ROUNDS);

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.role === 'admin') {
      console.log('Администратор продукта уже есть:', row.email);
      await closePool();
      process.exit(0);
      return;
    }
    await query(
      `UPDATE users SET
        password_hash = $1,
        role = 'admin',
        profile_id = NULL,
        is_profile_admin = false,
        full_name = CASE WHEN $3::text IS NOT NULL AND TRIM($3::text) <> '' THEN TRIM($3::text) ELSE full_name END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
      [passwordHash, row.id, FULL_NAME]
    );
    console.log('Пользователь повышен до администратора продукта:', row.email);
    await closePool();
    process.exit(0);
    return;
  }

  await query(
    `INSERT INTO users (email, password_hash, full_name, role, profile_id, is_profile_admin)
     VALUES ($1, $2, $3, 'admin', NULL, false)`,
    [EMAIL, passwordHash, FULL_NAME]
  );
  console.log('Создан администратор продукта:', EMAIL);
  await closePool();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
