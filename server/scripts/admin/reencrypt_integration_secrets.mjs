/**
 * Перешифровка секретов в integrations + marketplace_cabinets.
 * Шифрует plaintext-поля; уже enc:v1: оставляет как есть (идемпотентно).
 *
 * Usage (из server/):
 *   node scripts/admin/reencrypt_integration_secrets.mjs
 *   node scripts/admin/reencrypt_integration_secrets.mjs --dry-run
 *
 * Требует SECRETS_ENCRYPTION_KEY (или JWT_SECRET fallback как в runtime).
 */
import { query, closePool } from '../../src/config/database.js';
import {
  encryptConfigSecrets,
  isEncryptedSecret,
  SECRET_CONFIG_KEYS,
} from '../../src/utils/secretsCrypto.js';

const dryRun = process.argv.includes('--dry-run');

function needsEncrypt(config) {
  if (!config || typeof config !== 'object') return false;
  for (const key of SECRET_CONFIG_KEYS) {
    const v = config[key];
    if (v == null || v === '') continue;
    if (!isEncryptedSecret(String(v))) return true;
  }
  return false;
}

function parseConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

async function reencryptTable(table) {
  const { rows } = await query(`SELECT id, config FROM ${table} ORDER BY id`);
  let scanned = 0;
  let updated = 0;
  for (const row of rows) {
    scanned += 1;
    const cfg = parseConfig(row.config);
    if (!needsEncrypt(cfg)) continue;
    const next = encryptConfigSecrets(cfg);
    if (dryRun) {
      console.log(`[dry-run] ${table} id=${row.id} would encrypt`);
      updated += 1;
      continue;
    }
    await query(`UPDATE ${table} SET config = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [
      JSON.stringify(next),
      row.id,
    ]);
    updated += 1;
    console.log(`[ok] ${table} id=${row.id}`);
  }
  return { scanned, updated };
}

async function main() {
  console.log(dryRun ? 'DRY RUN' : 'ENCRYPT');
  const a = await reencryptTable('integrations');
  const b = await reencryptTable('marketplace_cabinets');
  console.log('integrations:', a);
  console.log('marketplace_cabinets:', b);
  await closePool();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await closePool();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
