/**
 * Admin: run arbitrary SQL file against configured PostgreSQL.
 * Usage: node scripts/admin/run-sql-file.js scripts/admin/reset_stock_keep_purchases_4_5.sql
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, closePool, testConnection } from '../../src/config/database.js';
import config from '../../src/config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function usage() {
  console.log('Usage: node scripts/admin/run-sql-file.js <path-to-sql-file>');
  process.exit(1);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) usage();

  const sqlPath = path.isAbsolute(arg) ? arg : path.resolve(__dirname, '../../', arg);
  if (!fs.existsSync(sqlPath)) {
    console.error(`[Admin] SQL file not found: ${sqlPath}`);
    process.exit(1);
  }

  console.log(`[Admin] DB: ${config.database.connectionString}`);
  console.log(`[Admin] Running SQL file: ${sqlPath}`);

  const ok = await testConnection();
  if (!ok) {
    console.error('[Admin] DB connection failed. Aborting.');
    process.exit(2);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  await query(sql);

  console.log('[Admin] ✓ SQL executed successfully');
}

main()
  .catch((e) => {
    console.error('[Admin] ✗ SQL execution failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

