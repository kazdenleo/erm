/**
 * Печатает hex-ключ, производный от JWT_SECRET (scrypt), без печати самого JWT.
 * node scripts/admin/_tmp_restore_secrets_key.mjs
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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

const jwt = String(process.env.JWT_SECRET || '').trim();
if (!jwt) {
  console.error('NO_JWT');
  process.exit(1);
}
const key = crypto.scryptSync(jwt, 'erm-secrets-v1', 32);
process.stdout.write(key.toString('hex'));
