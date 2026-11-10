/**
 * Desktop catalog scraper installer for Settings → Application.
 * Files: data/catalog-parser/SborshikKatalogov-setup.exe + meta.json
 * Access: profile name «Автолюбитель» only.
 */

import fs from 'fs';
import { join } from 'path';
import { query } from '../config/database.js';
import { DATA_DIR } from '../utils/storage.js';

const APP_DIR = join(DATA_DIR, 'catalog-parser');
const SETUP_PATH = join(APP_DIR, 'SborshikKatalogov-setup.exe');
const META_PATH = join(APP_DIR, 'meta.json');
const ALLOWED_PROFILE_NAME = 'автолюбитель';

function readMetaFile() {
  try {
    if (!fs.existsSync(META_PATH)) return null;
    const text = fs.readFileSync(META_PATH, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

export function ensureAppDir() {
  if (!fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR, { recursive: true });
  return APP_DIR;
}

export function getSetupPath() {
  return SETUP_PATH;
}

export function setupAvailable() {
  try {
    return fs.existsSync(SETUP_PATH) && fs.statSync(SETUP_PATH).isFile() && fs.statSync(SETUP_PATH).size > 0;
  } catch {
    return false;
  }
}

export async function isCatalogParserAllowed(user) {
  if (!user) return false;
  const profileId = user.profileId ?? user.profile_id ?? null;
  if (profileId == null || profileId === '') return false;
  try {
    const result = await query(`SELECT name FROM profiles WHERE id = $1`, [profileId]);
    const name = String(result.rows[0]?.name || '')
      .trim()
      .toLowerCase();
    return name === ALLOWED_PROFILE_NAME;
  } catch {
    return false;
  }
}

export function getReleaseInfo() {
  const available = setupAvailable();
  const meta = readMetaFile() || {};
  let sizeBytes = null;
  if (available) {
    try {
      sizeBytes = fs.statSync(SETUP_PATH).size;
    } catch {
      sizeBytes = null;
    }
  }
  return {
    available,
    name: 'Сборщик каталогов',
    fileName: meta.fileName || 'SborshikKatalogov-setup.exe',
    version: meta.version != null ? String(meta.version) : null,
    updatedAt: meta.updatedAt || null,
    sizeBytes,
  };
}

/** Write meta after placing the setup exe (publish script / deploy). */
export function writeMeta({ version, updatedAt = new Date().toISOString() } = {}) {
  ensureAppDir();
  const payload = {
    version: version != null ? String(version) : null,
    updatedAt,
    fileName: 'SborshikKatalogov-setup.exe',
  };
  fs.writeFileSync(META_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export default {
  ensureAppDir,
  getSetupPath,
  setupAvailable,
  isCatalogParserAllowed,
  getReleaseInfo,
  writeMeta,
};
