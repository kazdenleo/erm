/**
 * Классификатор ТН ВЭД ЕАЭС в БД (таблица tn_ved_codes).
 * Источник — справочник ФНС https://data.nalog.ru/files/tnved/tnved.zip (TNVED3 — позиции, TNVED4 — 10-значные коды).
 * Пока таблица пуста, поиск и проверка работают по встроенному списку constants/tnVedCodes.js.
 */

import fs from 'fs/promises';
import JSZip from 'jszip';
import { query, transaction } from '../config/database.js';
import logger from '../utils/logger.js';
import {
  TN_VED_CODES,
  isValidTnVedCodeFormat,
  searchTnVedCodes as searchStaticTnVedCodes,
  findTnVedByCode as findStaticTnVedByCode,
} from '../constants/tnVedCodes.js';
import { normalizeTnVedDigits } from '../utils/tnVedAttribute.js';

export const FNS_TNVED_URL = 'https://data.nalog.ru/files/tnved/tnved.zip';

const ACTIVE_SQL = '(valid_from IS NULL OR valid_from <= CURRENT_DATE) AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)';
const COUNT_CACHE_MS = 5 * 60 * 1000;

function parseRuDate(raw) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(raw || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/([^\d\s])\s*\d{1,2}\)\s*$/u, '$1')
    .replace(/[\s:;]+$/u, '')
    .trim();
}

function sentenceCase(raw) {
  const s = cleanName(raw);
  if (!s) return '';
  if (s !== s.toUpperCase()) return s;
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function splitLeaf(raw) {
  const s = String(raw || '').trim();
  const m = /^((?:-\s*)+)/u.exec(s);
  const level = m ? (m[1].match(/-/g) || []).length : 0;
  const name = sentenceCase(m ? s.slice(m[1].length) : s);
  return { level, name: name.charAt(0).toUpperCase() + name.slice(1) };
}

export function normalizeSearchText(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Актуальная редакция: действующая сегодня, иначе ближайшая будущая. */
function pickCurrentRow(rows, today) {
  let current = null;
  let future = null;
  for (const r of rows) {
    if (r.validTo && r.validTo < today) continue;
    if (!r.validFrom || r.validFrom <= today) {
      if (!current || String(r.validFrom || '') > String(current.validFrom || '')) current = r;
    } else if (!future || r.validFrom < future.validFrom) {
      future = r;
    }
  }
  return current || future;
}

function decodeCp866(buf) {
  return new TextDecoder('ibm866').decode(buf);
}

function parseLines(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines.shift() || '';
  return { header, rows: lines.map((l) => l.split('|')) };
}

/**
 * Разбор архива ФНС TNVED.ZIP.
 * @param {Buffer|Uint8Array} zipBuffer
 * @returns {Promise<{ version: string, codes: Array<object> }>}
 */
export async function parseFnsTnVedArchive(zipBuffer, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const fileByName = (name) => {
    const key = Object.keys(zip.files).find((k) => k.split('/').pop().toLowerCase() === name.toLowerCase());
    return key ? zip.files[key] : null;
  };
  const f3 = fileByName('TNVED3.TXT');
  const f4 = fileByName('TNVED4.TXT');
  if (!f3 || !f4) throw new Error('В архиве ФНС нет файлов TNVED3/TNVED4');

  const t3 = parseLines(decodeCp866(await f3.async('uint8array')));
  const t4 = parseLines(decodeCp866(await f4.async('uint8array')));

  const positions = new Map();
  for (const cols of t3.rows) {
    const [gr, pos, name, from, to] = cols;
    if (!/^\d{2}$/.test(gr) || !/^\d{2}$/.test(pos)) continue;
    const key = gr + pos;
    if (!positions.has(key)) positions.set(key, []);
    positions.get(key).push({ name, validFrom: parseRuDate(from), validTo: parseRuDate(to) });
  }

  const leaves = new Map();
  for (const cols of t4.rows) {
    const [gr, pos, sub, name, from, to] = cols;
    if (!/^\d{2}$/.test(gr) || !/^\d{2}$/.test(pos) || !/^\d{6}$/.test(sub)) continue;
    const code = gr + pos + sub;
    if (!leaves.has(code)) leaves.set(code, []);
    leaves.get(code).push({ name, validFrom: parseRuDate(from), validTo: parseRuDate(to) });
  }

  const codes = [];
  for (const [code, rows] of leaves) {
    const row = pickCurrentRow(rows, today);
    if (!row) continue;
    const { level, name } = splitLeaf(row.name);
    if (!name) continue;
    const positionCode = code.slice(0, 4);
    const posRow = pickCurrentRow(positions.get(positionCode) || [], today);
    const positionName = posRow ? sentenceCase(posRow.name) : null;
    codes.push({
      code,
      name,
      level,
      positionCode,
      positionName,
      validFrom: row.validFrom,
      validTo: row.validTo,
      searchText: normalizeSearchText(`${code} ${name} ${positionName || ''}`),
    });
  }
  codes.sort((a, b) => a.code.localeCompare(b.code));
  return { version: t4.header.split('|').slice(0, 2).join('|'), codes };
}

class TnVedDirectoryService {
  constructor() {
    this._count = null;
    this._countAt = 0;
  }

  async _codesCount() {
    if (this._count != null && Date.now() - this._countAt < COUNT_CACHE_MS) return this._count;
    try {
      const r = await query('SELECT COUNT(*)::int AS n FROM tn_ved_codes');
      this._count = r.rows[0]?.n || 0;
    } catch (e) {
      if (e?.code !== '42P01') logger.warn('[TN VED directory] count failed', { err: e?.message });
      this._count = 0;
    }
    this._countAt = Date.now();
    return this._count;
  }

  async hasDirectory() {
    return (await this._codesCount()) > 0;
  }

  async downloadArchive(url = FNS_TNVED_URL) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`ФНС вернула ${res.status} при скачивании ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Импорт архива ФНС в tn_ved_codes (полная замена).
   * @param {{ file?: string, url?: string }} [opts]
   */
  async importFromFns(opts = {}) {
    const buf = opts.file ? await fs.readFile(opts.file) : await this.downloadArchive(opts.url);
    const { version, codes } = await parseFnsTnVedArchive(buf);
    if (codes.length < 1000) throw new Error(`Подозрительно мало кодов в архиве: ${codes.length}`);

    await transaction(
      async (client) => {
        await client.query('DELETE FROM tn_ved_codes');
        const BATCH = 1000;
        for (let i = 0; i < codes.length; i += BATCH) {
          const chunk = codes.slice(i, i + BATCH);
          const params = [];
          const values = chunk.map((c, j) => {
            const b = j * 8;
            params.push(c.code, c.name, c.level, c.positionCode, c.positionName, c.validFrom, c.validTo, c.searchText);
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
          });
          await client.query(
            `INSERT INTO tn_ved_codes (code, name, level, position_code, position_name, valid_from, valid_to, search_text)
             VALUES ${values.join(', ')}`,
            params
          );
        }
        await client.query(
          `INSERT INTO tn_ved_directory_meta (key, value, updated_at)
           VALUES ('fns_version', $1, CURRENT_TIMESTAMP), ('imported_count', $2, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [version, String(codes.length)]
        );
      },
      { statementTimeoutMs: 300000 }
    );
    this._count = codes.length;
    this._countAt = Date.now();
    logger.info('[TN VED directory] imported', { version, count: codes.length });
    return { version, count: codes.length };
  }

  async getMeta() {
    try {
      const r = await query('SELECT key, value, updated_at FROM tn_ved_directory_meta');
      const meta = {};
      for (const row of r.rows) meta[row.key] = { value: row.value, updatedAt: row.updated_at };
      return { count: await this._codesCount(), meta };
    } catch {
      return { count: 0, meta: {} };
    }
  }

  _mapRow(r) {
    return {
      code: r.code,
      name: r.name,
      positionCode: r.position_code,
      positionName: r.position_name || null,
      level: r.level,
      active: r.active !== false,
      validFrom: r.valid_from || null,
      validTo: r.valid_to || null,
    };
  }

  /**
   * Поиск кодов: цифры — по началу кода, слова — по наименованию субпозиции и товарной позиции.
   * @param {{ q?: string, limit?: number }} opts
   */
  async search({ q = '', limit = 40 } = {}) {
    const max = Math.min(Math.max(Number(limit) || 40, 1), 200);
    if (!(await this.hasDirectory())) {
      return searchStaticTnVedCodes(q, max).map((row) => ({ ...row, source: 'static' }));
    }

    const text = normalizeSearchText(q);
    if (!text) {
      const popular = TN_VED_CODES.map((x) => x.code);
      const r = await query(
        `SELECT *, TRUE AS active FROM tn_ved_codes WHERE code = ANY($1::text[]) AND ${ACTIVE_SQL} ORDER BY code LIMIT $2`,
        [popular, max]
      );
      return r.rows.map((row) => this._mapRow(row));
    }

    const tokens = text.split(' ').filter(Boolean);
    const digitTokens = tokens.filter((t) => /^[\d.]+$/.test(t)).map((t) => t.replace(/\D/g, '')).filter(Boolean);
    const wordTokens = tokens.filter((t) => !/^[\d.]+$/.test(t) && t.length >= 2);
    const codePrefix = digitTokens.join('');
    if (codePrefix.length > 10) return [];

    const where = [ACTIVE_SQL];
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
    if (!codePrefix && !stems.length) return [];

    let orderBy = 'code';
    if (stems.length) {
      params.push(`%${stems[0]}%`);
      orderBy = `(lower(replace(name, 'ё', 'е')) LIKE $${params.length}) DESC, code`;
    }
    params.push(max);
    const r = await query(
      `SELECT *, TRUE AS active FROM tn_ved_codes WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT $${params.length}`,
      params
    );
    return r.rows.map((row) => this._mapRow(row));
  }

  /** Код из классификатора (включая недействующие на сегодня). */
  async getCode(code) {
    const digits = normalizeTnVedDigits(code);
    if (!digits) return null;
    if (!(await this.hasDirectory())) {
      const row = findStaticTnVedByCode(digits);
      return row ? { ...row, active: true, source: 'static' } : null;
    }
    const r = await query(
      `SELECT *, (${ACTIVE_SQL}) AS active FROM tn_ved_codes WHERE code = $1`,
      [digits]
    );
    return r.rows[0] ? this._mapRow(r.rows[0]) : null;
  }

  /**
   * Проверка кода перед сохранением. Без загруженного классификатора — только формат (10 цифр).
   * @param {string|null|undefined} code — уже нормализованный 10-значный код
   * @param {{ allowCode?: string|null }} [opts] — ранее сохранённый код можно сохранить повторно
   */
  async assertActiveCode(code, opts = {}) {
    if (code == null || code === '') return;
    if (!isValidTnVedCodeFormat(code)) {
      const err = new Error('Код ТН ВЭД — 10 цифр: выберите из списка или введите код полностью');
      err.statusCode = 400;
      throw err;
    }
    if (opts.allowCode && normalizeTnVedDigits(opts.allowCode) === code) return;
    if (!(await this.hasDirectory())) return;
    const row = await this.getCode(code);
    if (!row) {
      const err = new Error(`Код ТН ВЭД ${code} не найден в классификаторе ТН ВЭД ЕАЭС`);
      err.statusCode = 400;
      throw err;
    }
    if (!row.active) {
      const err = new Error(`Код ТН ВЭД ${code} не действует (исключён из классификатора)`);
      err.statusCode = 400;
      throw err;
    }
  }
}

export default new TnVedDirectoryService();
