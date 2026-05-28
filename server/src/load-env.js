/**
 * Загрузка .env до остальных модулей (PM2, server.js, миграции).
 * Пути фиксированы от расположения файла, не от process.cwd().
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverDir = join(__dirname, '..');
const repoRoot = join(__dirname, '../..');

dotenv.config({ path: join(repoRoot, '.env') });
dotenv.config({ path: join(serverDir, '.env'), override: true });

/**
 * @param {string} name
 * @param {boolean} [defaultValue=false]
 */
export function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultValue;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return defaultValue;
}
