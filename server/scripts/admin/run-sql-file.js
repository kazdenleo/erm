/**
 * Admin: run arbitrary SQL file against configured PostgreSQL.
 *
 * Запуск из каталога server:
 *   node scripts/admin/run-sql-file.js scripts/admin/foo.sql
 *
 * Из корня репозитория (testCursor/):
 *   node server/scripts/admin/run-sql-file.js server/scripts/admin/foo.sql
 *   node server/scripts/admin/run-sql-file.js scripts/admin/foo.sql
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, closePool, testConnection } from '../../src/config/database.js';
import config from '../../src/config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Каталог server/ (родитель scripts/) — от него задаются относительные пути в документации. */
const serverRoot = path.resolve(__dirname, '..', '..');

/**
 * @param {string} arg путь к .sql от server/ или от cwd, или с префиксом server/
 */
function resolveSqlFilePath(arg) {
  if (path.isAbsolute(arg)) return arg;
  const trimmed = arg.replace(/^[/\\]+/, '');
  const withoutServerPrefix = trimmed.replace(/^server[/\\]/i, '');
  const candidates = [
    path.resolve(serverRoot, trimmed),
    path.resolve(serverRoot, withoutServerPrefix),
    path.resolve(process.cwd(), trimmed),
    path.resolve(process.cwd(), withoutServerPrefix),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  return found ?? candidates[0];
}

function usage() {
  console.log('Usage: node scripts/admin/run-sql-file.js <path-to-sql-file>');
  console.log('  Path relative to server/: scripts/admin/your.sql');
  console.log('  Or from repo root: server/scripts/admin/your.sql');
  process.exit(1);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) usage();

  const sqlPath = resolveSqlFilePath(arg);
  if (!fs.existsSync(sqlPath)) {
    console.error(`[Admin] SQL file not found: ${sqlPath}`);
    console.error(`[Admin] Tried relative to server root: ${serverRoot}`);
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

