/**
 * Классификатор ОКПД2 в БД (таблица okpd2_codes).
 * Источник — okpd2.json из github.com/prog815/okpd2 (выгрузка официального файла Росстата);
 * если GitHub недоступен — справочник WB /api/content/v2/directory/okpd/all (нужен токен WB аккаунта).
 * Пустая таблица загружается автоматически при первом поиске.
 */

import { query, transaction } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import { normalizeOkpd2Code } from '../utils/okpd2.js';

export const OKPD2_GITHUB_URL = 'https://raw.githubusercontent.com/prog815/okpd2/main/okpd2.json';
const OKPD2_GITHUB_META_URL = 'https://raw.githubusercontent.com/prog815/okpd2/main/okpd2_meta.json';
const COUNT_CACHE_MS = 5 * 60 * 1000;

export function normalizeSearchText(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function parentOf(code) {
  const i = code.lastIndexOf('.');
  if (i > 0) return code.slice(0, i);
  return null;
}

function toRow(code, name, parentCode = undefined) {
  const c = normalizeOkpd2Code(code);
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!c || c !== String(code).trim() || !n) return null;
  return { code: c, name: n, parentCode: parentCode === undefined ? parentOf(c) : parentCode };
}

/** Строки справочника из okpd2.json ({ c, n, l, p }). */
export function parseGithubOkpd2(list) {
  const rows = [];
  for (const x of Array.isArray(list) ? list : []) {
    const parent = normalizeOkpd2Code(x?.p) === String(x?.p ?? '') ? x.p : null;
    const row = toRow(x?.c, x?.n, parent);
    if (row) rows.push(row);
  }
  return rows;
}

/** Строки справочника из ответа WB ({ okpd2, description }). */
export function parseWbOkpd2(list) {
  const rows = [];
  for (const x of Array.isArray(list) ? list : []) {
    const row = toRow(x?.okpd2, x?.description);
    if (row) rows.push(row);
  }
  return rows;
}

function finalizeRows(rows) {
  const byCode = new Map();
  for (const r of rows) if (!byCode.has(r.code)) byCode.set(r.code, r);
  const parents = new Set([...byCode.values()].map((r) => r.parentCode).filter(Boolean));
  return [...byCode.values()]
    .map((r) => ({ ...r, isLeaf: !parents.has(r.code), searchText: normalizeSearchText(`${r.code} ${r.name}`) }))
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}

async function fetchJson(url, timeoutMs = 60000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

class Okpd2DirectoryService {
  constructor() {
    this._count = null;
    this._countAt = 0;
    this._importing = null;
  }

  async _codesCount() {
    if (this._count != null && Date.now() - this._countAt < COUNT_CACHE_MS) return this._count;
    try {
      const r = await query('SELECT COUNT(*)::int AS n FROM okpd2_codes');
      this._count = r.rows[0]?.n || 0;
    } catch (e) {
      if (e?.code !== '42P01') logger.warn('[OKPD2 directory] count failed', { err: e?.message });
      this._count = 0;
    }
    this._countAt = Date.now();
    return this._count;
  }

  async hasDirectory() {
    return (await this._codesCount()) > 0;
  }

  async _loadSource(opts) {
    try {
      const list = await fetchJson(OKPD2_GITHUB_URL);
      const rows = parseGithubOkpd2(list);
      let version = null;
      try {
        version = (await fetchJson(OKPD2_GITHUB_META_URL, 15000))?.version || null;
      } catch {
        version = null;
      }
      return { rows, source: `rosstat${version ? ` ${version}` : ''}` };
    } catch (e) {
      logger.warn('[OKPD2 directory] GitHub source failed, trying WB', { err: e?.message });
    }
    const data = await integrationsService._wbContentApiGet('/api/content/v2/directory/okpd/all?locale=ru', {
      profileId: opts.profileId ?? null,
      timeoutMs: 120000,
    });
    const list = Array.isArray(data) ? data : data?.data;
    return { rows: parseWbOkpd2(list), source: 'wildberries' };
  }

  /** Полная замена справочника. */
  async importDirectory(opts = {}) {
    const { rows: raw, source } = await this._loadSource(opts);
    const rows = finalizeRows(raw);
    if (rows.length < 5000) throw new Error(`Подозрительно мало кодов ОКПД2: ${rows.length}`);

    await transaction(
      async (client) => {
        await client.query('DELETE FROM okpd2_codes');
        const BATCH = 1000;
        for (let i = 0; i < rows.length; i += BATCH) {
          const chunk = rows.slice(i, i + BATCH);
          const params = [];
          const values = chunk.map((r, j) => {
            const b = j * 5;
            params.push(r.code, r.name, r.parentCode, r.isLeaf, r.searchText);
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
          });
          await client.query(
            `INSERT INTO okpd2_codes (code, name, parent_code, is_leaf, search_text) VALUES ${values.join(', ')}`,
            params
          );
        }
        await client.query(
          `INSERT INTO okpd2_directory_meta (key, value, updated_at)
           VALUES ('source', $1, CURRENT_TIMESTAMP), ('imported_count', $2, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [source, String(rows.length)]
        );
      },
      { statementTimeoutMs: 300000 }
    );
    this._count = rows.length;
    this._countAt = Date.now();
    logger.info('[OKPD2 directory] imported', { source, count: rows.length });
    return { source, count: rows.length };
  }

  /** Загружает справочник, если таблица пуста (один импорт на процесс одновременно). */
  async ensureDirectory(opts = {}) {
    if (await this.hasDirectory()) return true;
    if (!this._importing) {
      this._importing = this.importDirectory(opts).finally(() => {
        this._importing = null;
      });
    }
    try {
      await this._importing;
      return true;
    } catch (e) {
      logger.warn('[OKPD2 directory] auto import failed', { err: e?.message });
      return false;
    }
  }

  _mapRow(r) {
    return { code: r.code, name: r.name, parentCode: r.parent_code || null, isLeaf: r.is_leaf === true };
  }

  /**
   * Поиск: цифры — по началу кода, слова — по наименованию.
   * @param {{ q?: string, limit?: number, profileId?: number|null }} opts
   */
  async search({ q = '', limit = 40, profileId = null } = {}) {
    const max = Math.min(Math.max(Number(limit) || 40, 1), 200);
    const text = normalizeSearchText(q);
    if (!text) return [];
    if (!(await this.ensureDirectory({ profileId }))) {
      const err = new Error('Справочник ОКПД2 не загружен: нет доступа к источнику, попробуйте позже');
      err.statusCode = 503;
      throw err;
    }

    const tokens = text.split(' ').filter(Boolean);
    const digitTokens = tokens.filter((t) => /^[\d.]+$/.test(t));
    const wordTokens = tokens.filter((t) => !/^[\d.]+$/.test(t) && t.length >= 2);
    const digits = digitTokens.join('').replace(/\D/g, '');
    if (digits.length > 9) return [];
    const codePrefix = digits.length >= 2 ? normalizeOkpd2Code(digits) : digits;

    const where = [];
    const params = [];
    if (codePrefix) {
      params.push(`${codePrefix}%`);
      where.push(`code LIKE $${params.length}`);
    }
    const stems = wordTokens.map((w) => (w.length > 5 ? w.slice(0, -2) : w).replace(/[%_\\]/g, (ch) => `\\${ch}`));
    for (const stem of stems) {
      params.push(`%${stem}%`);
      where.push(`search_text LIKE $${params.length}`);
    }
    if (!where.length) return [];

    let orderBy = 'length(code), code';
    if (stems.length) {
      params.push(`%${stems[0]}%`);
      orderBy = `(lower(replace(name, 'ё', 'е')) LIKE $${params.length}) DESC, is_leaf DESC, code`;
    }
    params.push(max);
    const r = await query(
      `SELECT * FROM okpd2_codes WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT $${params.length}`,
      params
    );
    return r.rows.map((row) => this._mapRow(row));
  }

  async getCode(code) {
    const c = normalizeOkpd2Code(code);
    if (!c || !(await this.hasDirectory())) return null;
    const r = await query('SELECT * FROM okpd2_codes WHERE code = $1', [c]);
    return r.rows[0] ? this._mapRow(r.rows[0]) : null;
  }

  /**
   * Проверка кода перед сохранением в категорию. Без загруженного справочника — только формат.
   * @param {string|null|undefined} code — нормализованный код
   * @param {{ allowCode?: string|null }} [opts] — ранее сохранённый код можно сохранить повторно
   */
  async assertKnownCode(code, opts = {}) {
    if (!code) return;
    if (opts.allowCode && normalizeOkpd2Code(opts.allowCode) === code) return;
    if (!(await this.hasDirectory())) return;
    if (!(await this.getCode(code))) {
      const err = new Error(`Код ОКПД2 ${code} не найден в классификаторе — выберите код из справочника`);
      err.statusCode = 400;
      throw err;
    }
  }
}

export default new Okpd2DirectoryService();
