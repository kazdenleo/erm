/**
 * Сравнивает возможность расшифровать ciphertext без печати секретов/plaintext.
 * Usage:
 *   node scripts/admin/_tmp_probe_secrets_match.mjs <ciphertext>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  const k = line.slice(0, i).trim();
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const cipher = process.argv[2] || '';
if (!cipher.startsWith('enc:v1:')) {
  console.log(JSON.stringify({ ok: false, reason: 'need enc:v1 ciphertext argv' }));
  process.exit(2);
}

const { decryptSecret } = await import('../../src/utils/secretsCrypto.js');
const keyLen = String(process.env.SECRETS_ENCRYPTION_KEY || '').trim().length;
try {
  const plain = decryptSecret(cipher);
  console.log(
    JSON.stringify({
      ok: true,
      keyLen,
      plainLen: plain == null ? null : String(plain).length,
    })
  );
} catch (e) {
  console.log(JSON.stringify({ ok: false, keyLen, error: e.message }));
  process.exit(1);
}
