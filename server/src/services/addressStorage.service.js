/**
 * Адресное хранение: настройки склада, ячейки, закрепление товаров, остатки по ячейкам,
 * перемещения, план склада и тепловая карта.
 *
 * Остаток «без адреса» вычисляется: product_warehouse_stock.quantity − SUM(product_location_stock).
 * Уменьшение остатка склада снимает излишек с ячеек триггером в БД (миграция 226).
 */

import { query, transaction } from '../config/database.js';

export const LOCATION_TYPES = ['storage', 'picking', 'receiving', 'shipping', 'defect', 'returns'];
export const ADDRESS_MODES = ['fixed', 'dynamic', 'mixed'];
const LAYOUT_ITEM_KINDS = ['rack', 'zone', 'wall', 'door', 'table', 'label'];

const DEFAULT_LEVELS = [
  { key: 'zone', label: 'Зона' },
  { key: 'rack', label: 'Стеллаж' },
  { key: 'shelf', label: 'Полка' },
  { key: 'cell', label: 'Ячейка' },
];

const MAX_GENERATE = 5000;
const MAX_LAYOUT_ITEMS = 2000;

function httpError(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function toPosInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const naturalCollator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

export function compareParts(a = [], b = []) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const c = naturalCollator.compare(String(a[i] ?? ''), String(b[i] ?? ''));
    if (c !== 0) return c;
  }
  return 0;
}

function isPrintableAscii(s) {
  return /^[\x20-\x7E]+$/.test(String(s || ''));
}

/** Штрихкод ячейки: свой, иначе код (если ASCII — Code128 не кодирует кириллицу), иначе L<id>. */
export function effectiveBarcode(loc) {
  if (loc?.barcode) return String(loc.barcode);
  if (isPrintableAscii(loc?.code)) return String(loc.code);
  return `L${loc?.id}`;
}

function mapLocation(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    warehouseId: Number(row.warehouse_id),
    code: row.code,
    parts: Array.isArray(row.parts) ? row.parts : [],
    type: row.location_type,
    barcode: row.barcode || null,
    effectiveBarcode: effectiveBarcode(row),
    routeOrder: Number(row.route_order) || 0,
    capacity: row.capacity != null ? Number(row.capacity) : null,
    isActive: row.is_active !== false,
    note: row.note || null,
  };
}

function normalizeLevels(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const it of list) {
    const label = String(it?.label ?? '').trim().slice(0, 32);
    if (!label) continue;
    const key = String(it?.key ?? '').trim().slice(0, 32) || `level${out.length + 1}`;
    out.push({ key, label });
  }
  if (out.length < 1 || out.length > 6) {
    throw httpError('Шаблон адреса: от 1 до 6 уровней с названиями');
  }
  return out;
}

function mapSettings(row, warehouseId) {
  if (!row) {
    return {
      warehouseId: Number(warehouseId),
      enabled: false,
      mode: 'fixed',
      trackQuantities: false,
      levels: DEFAULT_LEVELS,
      separator: '-',
      labelWidthMm: 58,
      labelHeightMm: 40,
    };
  }
  return {
    warehouseId: Number(row.warehouse_id),
    enabled: row.enabled === true,
    mode: row.mode,
    trackQuantities: row.track_quantities === true,
    levels: Array.isArray(row.levels) && row.levels.length ? row.levels : DEFAULT_LEVELS,
    separator: row.separator || '-',
    labelWidthMm: Number(row.label_width_mm) || 58,
    labelHeightMm: Number(row.label_height_mm) || 40,
  };
}

/** Токены уровня генератора: «A-C», «01-12», «1..5», «A,B,D». */
export function expandLevelValues(spec) {
  const src = String(spec ?? '').trim();
  if (!src) throw httpError('Укажите значения для каждого уровня');
  const out = [];
  for (const tokenRaw of src.split(/[,;\s]+/)) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const m = token.match(/^([^-.]+)(?:-|\.\.)([^-.]+)$/);
    if (!m) {
      out.push(token);
      continue;
    }
    const [, a, b] = m;
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      const from = Number(a);
      const to = Number(b);
      const pad = a.length > 1 && a.startsWith('0') ? a.length : 0;
      const step = from <= to ? 1 : -1;
      for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
        out.push(pad ? String(i).padStart(pad, '0') : String(i));
        if (out.length > MAX_GENERATE) throw httpError(`Слишком много значений (больше ${MAX_GENERATE})`);
      }
      continue;
    }
    if (a.length === 1 && b.length === 1) {
      const from = a.toUpperCase().charCodeAt(0);
      const to = b.toUpperCase().charCodeAt(0);
      const step = from <= to ? 1 : -1;
      for (let c = from; step > 0 ? c <= to : c >= to; c += step) {
        out.push(String.fromCharCode(c));
      }
      continue;
    }
    out.push(token);
  }
  return [...new Set(out)];
}

function validateParts(parts, separator) {
  const clean = parts.map((p) => String(p ?? '').trim());
  if (clean.some((p) => !p)) throw httpError('Все части адреса должны быть заполнены');
  if (clean.some((p) => p.includes(separator))) {
    throw httpError(`Часть адреса не может содержать разделитель «${separator}»`);
  }
  const code = clean.join(separator);
  if (code.length > 64) throw httpError('Адрес ячейки длиннее 64 символов');
  return { parts: clean, code };
}

class AddressStorageService {
  // ---------- Склады и настройки ----------

  async listWarehouses({ profileId = null, warehouseIds = null } = {}) {
    const params = [];
    const where = [`LOWER(COALESCE(w.type::text, '')) = 'warehouse'`, `w.supplier_id IS NULL`];
    if (profileId != null) {
      params.push(profileId);
      where.push(`w.profile_id = $${params.length}`);
    }
    if (Array.isArray(warehouseIds)) {
      params.push(warehouseIds);
      where.push(`w.id = ANY($${params.length}::bigint[])`);
    }
    const r = await query(
      `SELECT w.id, w.name, w.address, w.organization_id, s.*,
              (SELECT COUNT(*)::int FROM storage_locations l WHERE l.warehouse_id = w.id) AS locations_count
       FROM warehouses w
       LEFT JOIN warehouse_address_settings s ON s.warehouse_id = w.id
       WHERE ${where.join(' AND ')}
       ORDER BY w.id`,
      params
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      name: row.name || row.address || `Склад #${row.id}`,
      organizationId: row.organization_id != null ? Number(row.organization_id) : null,
      locationsCount: row.locations_count,
      settings: mapSettings(row.warehouse_id != null ? row : null, row.id),
    }));
  }

  async getSettings(warehouseId) {
    const r = await query(`SELECT * FROM warehouse_address_settings WHERE warehouse_id = $1`, [warehouseId]);
    return mapSettings(r.rows[0], warehouseId);
  }

  async saveSettings(warehouseId, body = {}) {
    const cur = await this.getSettings(warehouseId);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const next = {
      enabled: has('enabled') ? body.enabled === true : cur.enabled,
      mode: has('mode') ? String(body.mode) : cur.mode,
      trackQuantities: has('trackQuantities') ? body.trackQuantities === true : cur.trackQuantities,
      levels: has('levels') ? normalizeLevels(body.levels) : cur.levels,
      separator: has('separator') ? String(body.separator ?? '') : cur.separator,
      labelWidthMm: has('labelWidthMm') ? toPosInt(body.labelWidthMm) : cur.labelWidthMm,
      labelHeightMm: has('labelHeightMm') ? toPosInt(body.labelHeightMm) : cur.labelHeightMm,
    };
    if (!ADDRESS_MODES.includes(next.mode)) throw httpError('Неизвестный режим хранения');
    if (!next.separator || next.separator.length > 3 || /[\p{L}\p{N}\s]/u.test(next.separator)) {
      throw httpError('Разделитель — 1–3 символа, не буквы, цифры и пробелы');
    }
    for (const [k, v] of [['ширина', next.labelWidthMm], ['высота', next.labelHeightMm]]) {
      if (!v || v < 15 || v > 200) throw httpError(`Этикетка: ${k} от 15 до 200 мм`);
    }
    if (has('levels') || has('separator')) {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM storage_locations
         WHERE warehouse_id = $1 AND cardinality(parts) <> $2`,
        [warehouseId, next.levels.length]
      );
      if (r.rows[0].n > 0 && next.levels.length !== cur.levels.length) {
        throw httpError(
          'Число уровней адреса нельзя изменить, пока есть ячейки другого формата. Удалите их или оставьте прежнее число уровней.',
          409
        );
      }
    }
    await query(
      `INSERT INTO warehouse_address_settings
         (warehouse_id, enabled, mode, track_quantities, levels, separator, label_width_mm, label_height_mm, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, CURRENT_TIMESTAMP)
       ON CONFLICT (warehouse_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         mode = EXCLUDED.mode,
         track_quantities = EXCLUDED.track_quantities,
         levels = EXCLUDED.levels,
         separator = EXCLUDED.separator,
         label_width_mm = EXCLUDED.label_width_mm,
         label_height_mm = EXCLUDED.label_height_mm,
         updated_at = CURRENT_TIMESTAMP`,
      [
        warehouseId,
        next.enabled,
        next.mode,
        next.trackQuantities,
        JSON.stringify(next.levels),
        next.separator,
        next.labelWidthMm,
        next.labelHeightMm,
      ]
    );
    if (has('separator') && next.separator !== cur.separator) {
      await query(
        `UPDATE storage_locations SET code = array_to_string(parts, $2), updated_at = CURRENT_TIMESTAMP
         WHERE warehouse_id = $1`,
        [warehouseId, next.separator]
      );
    }
    return this.getSettings(warehouseId);
  }

  // ---------- Ячейки ----------

  async listLocations(warehouseId) {
    const r = await query(
      `SELECT l.*,
              COALESCE(st.qty, 0)::int AS stock_qty,
              COALESCE(prod.items, '[]'::json) AS products
       FROM storage_locations l
       LEFT JOIN LATERAL (
         SELECT SUM(quantity)::int AS qty FROM product_location_stock WHERE location_id = l.id
       ) st ON TRUE
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'productId', x.product_id,
                  'name', p.name,
                  'sku', p.sku,
                  'assigned', x.assigned,
                  'quantity', x.qty,
                  'barcodes', (
                    SELECT COALESCE(json_agg(bc ORDER BY bc), '[]'::json)
                    FROM (
                      SELECT bc.barcode AS bc FROM barcodes bc WHERE bc.product_id = x.product_id
                      UNION
                      SELECT NULLIF(TRIM(p.box_barcode), '')
                      WHERE NULLIF(TRIM(COALESCE(p.box_barcode, '')), '') IS NOT NULL
                    ) t
                  )
                ) ORDER BY x.assigned DESC, p.name) AS items
         FROM (
           SELECT product_id, BOOL_OR(assigned) AS assigned, SUM(qty)::int AS qty
           FROM (
             SELECT product_id, TRUE AS assigned, 0 AS qty
             FROM product_storage_assignments WHERE location_id = l.id
             UNION ALL
             SELECT product_id, FALSE, quantity
             FROM product_location_stock WHERE location_id = l.id
           ) u
           GROUP BY product_id
         ) x
         JOIN products p ON p.id = x.product_id
       ) prod ON TRUE
       WHERE l.warehouse_id = $1`,
      [warehouseId]
    );
    const rows = r.rows.map((row) => ({
      ...mapLocation(row),
      stockQty: row.stock_qty,
      products: row.products || [],
    }));
    rows.sort((a, b) => a.routeOrder - b.routeOrder || compareParts(a.parts, b.parts));
    return rows;
  }

  async getLocation(warehouseId, locationId) {
    const r = await query(`SELECT * FROM storage_locations WHERE id = $1 AND warehouse_id = $2`, [
      locationId,
      warehouseId,
    ]);
    if (!r.rows[0]) throw httpError('Ячейка не найдена', 404);
    return mapLocation(r.rows[0]);
  }

  async createLocation(warehouseId, body = {}) {
    const settings = await this.getSettings(warehouseId);
    const rawParts = Array.isArray(body.parts)
      ? body.parts
      : String(body.code ?? '').split(settings.separator);
    if (rawParts.length !== settings.levels.length) {
      throw httpError(`Адрес должен состоять из ${settings.levels.length} частей`);
    }
    const { parts, code } = validateParts(rawParts, settings.separator);
    const type = LOCATION_TYPES.includes(body.type) ? body.type : 'storage';
    const maxR = await query(
      `SELECT COALESCE(MAX(route_order), 0)::int AS m FROM storage_locations WHERE warehouse_id = $1`,
      [warehouseId]
    );
    const routeOrder = toIntOrNull(body.routeOrder) ?? maxR.rows[0].m + 10;
    try {
      const r = await query(
        `INSERT INTO storage_locations
           (warehouse_id, code, parts, location_type, barcode, route_order, capacity, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          warehouseId,
          code,
          parts,
          type,
          body.barcode ? String(body.barcode).trim().slice(0, 64) : null,
          routeOrder,
          toIntOrNull(body.capacity),
          body.note ? String(body.note).slice(0, 500) : null,
        ]
      );
      return mapLocation(r.rows[0]);
    } catch (e) {
      if (e?.code === '23505') throw httpError(`Ячейка ${code} уже есть`, 409);
      throw e;
    }
  }

  /** Генерация декартова произведения значений уровней. dryRun — только предпросмотр. */
  async generateLocations(warehouseId, body = {}) {
    const settings = await this.getSettings(warehouseId);
    const specs = Array.isArray(body.levels) ? body.levels : [];
    if (specs.length !== settings.levels.length) {
      throw httpError(`Нужно задать значения для ${settings.levels.length} уровней`);
    }
    const lists = specs.map((s) => expandLevelValues(typeof s === 'string' ? s : s?.values));
    const total = lists.reduce((acc, l) => acc * l.length, 1);
    if (total > MAX_GENERATE) throw httpError(`За раз можно создать не больше ${MAX_GENERATE} ячеек (получилось ${total})`);

    let combos = [[]];
    for (const list of lists) {
      const next = [];
      for (const prefix of combos) for (const v of list) next.push([...prefix, v]);
      combos = next;
    }
    const items = combos.map((parts) => validateParts(parts, settings.separator));
    if (body.dryRun) {
      return { total, sample: items.slice(0, 12).map((i) => i.code) };
    }
    const type = LOCATION_TYPES.includes(body.type) ? body.type : 'storage';
    const capacity = toIntOrNull(body.capacity);
    const maxR = await query(
      `SELECT COALESCE(MAX(route_order), 0)::int AS m FROM storage_locations WHERE warehouse_id = $1`,
      [warehouseId]
    );
    const base = maxR.rows[0].m;
    const r = await query(
      `INSERT INTO storage_locations (warehouse_id, code, parts, location_type, route_order, capacity)
       SELECT $1::bigint, t.code, string_to_array(t.parts_joined, E'\\x1f'), $4::varchar, $5::int + t.ord * 10, $6::int
       FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(code, parts_joined, ord)
       ON CONFLICT (warehouse_id, code) DO NOTHING
       RETURNING id`,
      [
        warehouseId,
        items.map((i) => i.code),
        items.map((i) => i.parts.join('\x1f')),
        type,
        base,
        capacity,
      ]
    );
    return { total, created: r.rowCount, skipped: total - r.rowCount };
  }

  async updateLocation(warehouseId, locationId, body = {}) {
    const cur = await this.getLocation(warehouseId, locationId);
    const settings = await this.getSettings(warehouseId);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    let parts = cur.parts;
    let code = cur.code;
    if (has('parts') || has('code')) {
      const raw = Array.isArray(body.parts) ? body.parts : String(body.code ?? '').split(settings.separator);
      if (raw.length !== settings.levels.length) {
        throw httpError(`Адрес должен состоять из ${settings.levels.length} частей`);
      }
      ({ parts, code } = validateParts(raw, settings.separator));
    }
    const type = has('type') ? body.type : cur.type;
    if (!LOCATION_TYPES.includes(type)) throw httpError('Неизвестный тип ячейки');
    try {
      const r = await query(
        `UPDATE storage_locations SET
           code = $3, parts = $4, location_type = $5, barcode = $6, route_order = $7,
           capacity = $8, is_active = $9, note = $10, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND warehouse_id = $2
         RETURNING *`,
        [
          locationId,
          warehouseId,
          code,
          parts,
          type,
          has('barcode') ? (body.barcode ? String(body.barcode).trim().slice(0, 64) : null) : cur.barcode,
          has('routeOrder') ? toIntOrNull(body.routeOrder) ?? 0 : cur.routeOrder,
          has('capacity') ? toIntOrNull(body.capacity) : cur.capacity,
          has('isActive') ? body.isActive !== false : cur.isActive,
          has('note') ? (body.note ? String(body.note).slice(0, 500) : null) : cur.note,
        ]
      );
      return mapLocation(r.rows[0]);
    } catch (e) {
      if (e?.code === '23505') throw httpError(`Ячейка с таким адресом или штрихкодом уже есть`, 409);
      throw e;
    }
  }

  async bulkUpdateLocations(warehouseId, ids, patch = {}) {
    const list = (Array.isArray(ids) ? ids : []).map(toPosInt).filter(Boolean);
    if (!list.length) return { updated: 0 };
    const sets = [];
    const params = [warehouseId, list];
    if (patch.type !== undefined) {
      if (!LOCATION_TYPES.includes(patch.type)) throw httpError('Неизвестный тип ячейки');
      params.push(patch.type);
      sets.push(`location_type = $${params.length}`);
    }
    if (patch.capacity !== undefined) {
      params.push(toIntOrNull(patch.capacity));
      sets.push(`capacity = $${params.length}`);
    }
    if (patch.isActive !== undefined) {
      params.push(patch.isActive !== false);
      sets.push(`is_active = $${params.length}`);
    }
    if (!sets.length) return { updated: 0 };
    const r = await query(
      `UPDATE storage_locations SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE warehouse_id = $1 AND id = ANY($2::bigint[])`,
      params
    );
    return { updated: r.rowCount };
  }

  async deleteLocations(warehouseId, ids, { force = false } = {}) {
    const list = (Array.isArray(ids) ? ids : []).map(toPosInt).filter(Boolean);
    if (!list.length) return { deleted: 0 };
    if (!force) {
      const r = await query(
        `SELECT l.code FROM storage_locations l
         WHERE l.warehouse_id = $1 AND l.id = ANY($2::bigint[])
           AND EXISTS (SELECT 1 FROM product_location_stock s WHERE s.location_id = l.id)
         LIMIT 5`,
        [warehouseId, list]
      );
      if (r.rows.length) {
        const e = httpError(
          `В ячейках есть товар (${r.rows.map((x) => x.code).join(', ')}). При удалении он перейдёт в «Без адреса».`,
          409
        );
        e.details = { code: 'LOCATION_HAS_STOCK' };
        throw e;
      }
    }
    const r = await query(
      `DELETE FROM storage_locations WHERE warehouse_id = $1 AND id = ANY($2::bigint[])`,
      [warehouseId, list]
    );
    return { deleted: r.rowCount };
  }

  /** Перенумеровать маршрут: по адресу или «змейкой» (каждый второй стеллаж в обратном порядке). */
  async renumberRoute(warehouseId, { strategy = 'code' } = {}) {
    const r = await query(`SELECT id, parts FROM storage_locations WHERE warehouse_id = $1`, [warehouseId]);
    const rows = r.rows.map((x) => ({ id: Number(x.id), parts: x.parts || [] }));
    rows.sort((a, b) => compareParts(a.parts, b.parts));
    let ordered = rows;
    if (strategy === 'serpentine') {
      const groups = [];
      for (const row of rows) {
        const key = row.parts.slice(0, Math.max(1, row.parts.length - 2)).join('\x1f');
        const last = groups[groups.length - 1];
        if (last && last.key === key) last.rows.push(row);
        else groups.push({ key, rows: [row] });
      }
      ordered = groups.flatMap((g, i) => (i % 2 === 1 ? [...g.rows].reverse() : g.rows));
    }
    if (!ordered.length) return { updated: 0 };
    await query(
      `UPDATE storage_locations l SET route_order = t.ord * 10, updated_at = CURRENT_TIMESTAMP
       FROM unnest($2::bigint[]) WITH ORDINALITY AS t(id, ord)
       WHERE l.id = t.id AND l.warehouse_id = $1`,
      [warehouseId, ordered.map((x) => x.id)]
    );
    return { updated: ordered.length };
  }

  async resolveLocationByScan(warehouseId, raw) {
    const code = String(raw ?? '').trim();
    if (!code) return null;
    const m = code.match(/^L(\d+)$/i);
    const r = await query(
      `SELECT * FROM storage_locations
       WHERE warehouse_id = $1
         AND (barcode = $2 OR UPPER(code) = UPPER($2) OR ($3::bigint IS NOT NULL AND id = $3::bigint))
       ORDER BY COALESCE(barcode = $2, false) DESC
       LIMIT 1`,
      [warehouseId, code, m ? Number(m[1]) : null]
    );
    return mapLocation(r.rows[0]);
  }

  // ---------- Товары ----------

  async assertProductInProfile(productId, profileId) {
    const r = await query(`SELECT id, profile_id, product_type FROM products WHERE id = $1`, [productId]);
    const p = r.rows[0];
    if (!p) throw httpError('Товар не найден', 404);
    if (profileId != null && p.profile_id != null && String(p.profile_id) !== String(profileId)) {
      throw httpError('Товар не найден', 404);
    }
    return p;
  }

  async searchProducts(warehouseId, { q = '', profileId = null, limit = 20 } = {}) {
    const term = String(q ?? '').trim();
    if (!term) return [];
    const params = [warehouseId, `%${term}%`, term, Math.min(50, Math.max(1, Number(limit) || 20))];
    let profileSql = '';
    if (profileId != null) {
      params.push(profileId);
      profileSql = `AND p.profile_id = $${params.length}`;
    }
    const r = await query(
      `SELECT p.id, p.name, p.sku,
              COALESCE(pws.quantity, 0)::int AS wh_qty,
              a.location_id, sl.code AS location_code
       FROM products p
       LEFT JOIN product_warehouse_stock pws ON pws.product_id = p.id AND pws.warehouse_id = $1
       LEFT JOIN product_storage_assignments a ON a.product_id = p.id AND a.warehouse_id = $1
       LEFT JOIN storage_locations sl ON sl.id = a.location_id
       WHERE COALESCE(p.is_archived, false) = false
         AND (p.name ILIKE $2 OR p.sku ILIKE $2 OR p.id::text = $3
              OR EXISTS (SELECT 1 FROM barcodes bc WHERE bc.product_id = p.id AND bc.barcode = $3))
         ${profileSql}
       ORDER BY (p.sku ILIKE $3) DESC, p.name
       LIMIT $4`,
      params
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      sku: row.sku,
      warehouseQty: row.wh_qty,
      assignedLocationId: row.location_id != null ? Number(row.location_id) : null,
      assignedLocationCode: row.location_code || null,
    }));
  }

  async assignProduct(warehouseId, productId, locationId, { profileId = null } = {}) {
    const p = await this.assertProductInProfile(productId, profileId);
    if (locationId == null || locationId === '') {
      await query(`DELETE FROM product_storage_assignments WHERE product_id = $1 AND warehouse_id = $2`, [
        productId,
        warehouseId,
      ]);
      return null;
    }
    const loc = await this.getLocation(warehouseId, locationId);
    await query(
      `INSERT INTO product_storage_assignments (product_id, warehouse_id, location_id, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET
         location_id = EXCLUDED.location_id, updated_at = CURRENT_TIMESTAMP`,
      [productId, warehouseId, loc.id]
    );
    return loc;
  }

  /** Импорт закрепления из текста: «артикул<TAB|;|,>адрес» по строке. */
  async importAssignments(warehouseId, text, { profileId = null } = {}) {
    const lines = String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return { assigned: 0, errors: [] };
    if (lines.length > 10000) throw httpError('Не больше 10 000 строк за раз');
    const pairs = [];
    const errors = [];
    for (const [i, line] of lines.entries()) {
      const m = line.match(/^(.+?)[\t;,]+\s*(.+)$/);
      if (!m) {
        errors.push(`Строка ${i + 1}: нужен формат «артикул;адрес»`);
        continue;
      }
      pairs.push({ line: i + 1, sku: m[1].trim(), code: m[2].trim() });
    }
    const skus = [...new Set(pairs.map((p) => p.sku.toLowerCase()))];
    const codes = [...new Set(pairs.map((p) => p.code.toUpperCase()))];
    const params = [skus];
    let profileSql = '';
    if (profileId != null) {
      params.push(profileId);
      profileSql = `AND profile_id = $2`;
    }
    const [prodR, locR] = await Promise.all([
      query(
        `SELECT id, LOWER(sku) AS k FROM products
         WHERE LOWER(sku) = ANY($1::text[]) ${profileSql}`,
        params
      ),
      query(
        `SELECT id, UPPER(code) AS k FROM storage_locations WHERE warehouse_id = $1 AND UPPER(code) = ANY($2::text[])`,
        [warehouseId, codes]
      ),
    ]);
    const prodBy = new Map(prodR.rows.map((r) => [r.k, Number(r.id)]));
    const locBy = new Map(locR.rows.map((r) => [r.k, Number(r.id)]));
    const pids = [];
    const lids = [];
    for (const p of pairs) {
      const pid = prodBy.get(p.sku.toLowerCase());
      const lid = locBy.get(p.code.toUpperCase());
      if (!pid) errors.push(`Строка ${p.line}: товар «${p.sku}» не найден`);
      else if (!lid) errors.push(`Строка ${p.line}: ячейка «${p.code}» не найдена`);
      else {
        pids.push(pid);
        lids.push(lid);
      }
    }
    if (pids.length) {
      await query(
        `INSERT INTO product_storage_assignments (product_id, warehouse_id, location_id, updated_at)
         SELECT DISTINCT ON (t.pid) t.pid, $1::bigint, t.lid, CURRENT_TIMESTAMP
         FROM unnest($2::bigint[], $3::bigint[]) WITH ORDINALITY AS t(pid, lid, ord)
         ORDER BY t.pid, t.ord DESC
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET
           location_id = EXCLUDED.location_id, updated_at = CURRENT_TIMESTAMP`,
        [warehouseId, pids, lids]
      );
    }
    return { assigned: new Set(pids).size, errors: errors.slice(0, 200), errorsTotal: errors.length };
  }

  /** Где лежит товар: по всем складам с включённым адресным хранением. */
  async getProductLocations(productId, { profileId = null, warehouseIds = null } = {}) {
    await this.assertProductInProfile(productId, profileId);
    const warehouses = (await this.listWarehouses({ profileId, warehouseIds })).filter((w) => w.settings.enabled);
    if (!warehouses.length) return { warehouses: [] };
    const wids = warehouses.map((w) => w.id);
    const [pwsR, asgR, stR] = await Promise.all([
      query(
        `SELECT warehouse_id, quantity FROM product_warehouse_stock
         WHERE product_id = $1 AND warehouse_id = ANY($2::bigint[])`,
        [productId, wids]
      ),
      query(
        `SELECT a.warehouse_id, l.* FROM product_storage_assignments a
         JOIN storage_locations l ON l.id = a.location_id
         WHERE a.product_id = $1 AND a.warehouse_id = ANY($2::bigint[])`,
        [productId, wids]
      ),
      query(
        `SELECT s.quantity, l.* FROM product_location_stock s
         JOIN storage_locations l ON l.id = s.location_id
         WHERE s.product_id = $1 AND s.warehouse_id = ANY($2::bigint[])
         ORDER BY l.route_order, l.code`,
        [productId, wids]
      ),
    ]);
    const qtyBy = new Map(pwsR.rows.map((r) => [Number(r.warehouse_id), Number(r.quantity) || 0]));
    const asgBy = new Map(asgR.rows.map((r) => [Number(r.warehouse_id), mapLocation(r)]));
    return {
      warehouses: warehouses.map((w) => {
        const stocks = stR.rows
          .filter((r) => Number(r.warehouse_id) === w.id)
          .map((r) => ({ location: mapLocation(r), quantity: Number(r.quantity) }));
        const placed = stocks.reduce((s, x) => s + x.quantity, 0);
        const total = qtyBy.get(w.id) || 0;
        return {
          warehouseId: w.id,
          warehouseName: w.name,
          settings: w.settings,
          warehouseQty: total,
          assigned: asgBy.get(w.id) || null,
          stocks,
          unplaced: Math.max(0, total - placed),
        };
      }),
    };
  }

  /**
   * Адреса для списка товаров (сборка, сбор FBO). Порядок: закреплённая, затем ячейки с остатком по маршруту.
   * @returns {Record<number, Array<{warehouseId, locationId, code, routeOrder, assigned, quantity}>>}
   */
  async lookupProducts(productIds, { profileId = null, warehouseIds = null } = {}) {
    const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(toPosInt).filter(Boolean))].slice(0, 5000);
    if (!ids.length) return {};
    const warehouses = (await this.listWarehouses({ profileId, warehouseIds })).filter((w) => w.settings.enabled);
    if (!warehouses.length) return {};
    const wids = warehouses.map((w) => w.id);
    const r = await query(
      `SELECT u.product_id, u.warehouse_id, l.id AS location_id, l.code, l.route_order,
              BOOL_OR(u.assigned) AS assigned, SUM(u.qty)::int AS quantity
       FROM (
         SELECT product_id, warehouse_id, location_id, TRUE AS assigned, 0 AS qty
         FROM product_storage_assignments
         WHERE product_id = ANY($1::bigint[]) AND warehouse_id = ANY($2::bigint[])
         UNION ALL
         SELECT product_id, warehouse_id, location_id, FALSE, quantity
         FROM product_location_stock
         WHERE product_id = ANY($1::bigint[]) AND warehouse_id = ANY($2::bigint[])
       ) u
       JOIN storage_locations l ON l.id = u.location_id
       GROUP BY u.product_id, u.warehouse_id, l.id, l.code, l.route_order
       ORDER BY u.product_id, BOOL_OR(u.assigned) DESC, l.route_order, l.code`,
      [ids, wids]
    );
    const out = {};
    for (const row of r.rows) {
      const pid = Number(row.product_id);
      (out[pid] ||= []).push({
        warehouseId: Number(row.warehouse_id),
        locationId: Number(row.location_id),
        code: row.code,
        routeOrder: Number(row.route_order) || 0,
        assigned: row.assigned === true,
        quantity: Number(row.quantity) || 0,
      });
    }
    return out;
  }

  // ---------- Остатки по ячейкам и перемещения ----------

  async moveStock(warehouseId, body = {}, { userId = null, profileId = null } = {}) {
    const productId = toPosInt(body.productId);
    const quantity = toPosInt(body.quantity);
    if (!productId) throw httpError('Укажите товар');
    if (!quantity) throw httpError('Количество должно быть целым числом больше нуля');
    await this.assertProductInProfile(productId, profileId);
    const fromId = toPosInt(body.fromLocationId);
    let toId = toPosInt(body.toLocationId);
    if (!toId && body.toAssigned === true) {
      const a = await query(
        `SELECT location_id FROM product_storage_assignments WHERE product_id = $1 AND warehouse_id = $2`,
        [productId, warehouseId]
      );
      toId = a.rows[0] ? Number(a.rows[0].location_id) : null;
      if (!toId) throw httpError('У товара нет закреплённой ячейки на этом складе');
    }
    if (fromId && toId && fromId === toId) throw httpError('Ячейки «откуда» и «куда» совпадают');
    if (!fromId && !toId) throw httpError('Укажите ячейку «откуда» или «куда»');

    return transaction(async (client) => {
      const pws = await client.query(
        `SELECT quantity FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE`,
        [productId, warehouseId]
      );
      const whQty = Number(pws.rows[0]?.quantity) || 0;
      const locs = await client.query(
        `SELECT id, code, capacity FROM storage_locations WHERE warehouse_id = $1 AND id = ANY($2::bigint[])`,
        [warehouseId, [fromId, toId].filter(Boolean)]
      );
      const locBy = new Map(locs.rows.map((r) => [Number(r.id), r]));
      if (fromId && !locBy.has(fromId)) throw httpError('Ячейка «откуда» не найдена', 404);
      if (toId && !locBy.has(toId)) throw httpError('Ячейка «куда» не найдена', 404);

      if (fromId) {
        const src = await client.query(
          `SELECT quantity FROM product_location_stock WHERE product_id = $1 AND location_id = $2 FOR UPDATE`,
          [productId, fromId]
        );
        const have = Number(src.rows[0]?.quantity) || 0;
        if (have < quantity) {
          throw httpError(`В ячейке ${locBy.get(fromId).code} только ${have} шт`, 409);
        }
      } else {
        const placed = await client.query(
          `SELECT COALESCE(SUM(quantity), 0)::int AS s FROM product_location_stock
           WHERE product_id = $1 AND warehouse_id = $2`,
          [productId, warehouseId]
        );
        const unplaced = whQty - placed.rows[0].s;
        if (unplaced < quantity) {
          throw httpError(`Без адреса только ${Math.max(0, unplaced)} шт`, 409);
        }
      }

      if (toId && !body.force) {
        const cap = locBy.get(toId).capacity;
        if (cap != null) {
          const inCell = await client.query(
            `SELECT COALESCE(SUM(quantity), 0)::int AS s FROM product_location_stock WHERE location_id = $1`,
            [toId]
          );
          if (inCell.rows[0].s + quantity > Number(cap)) {
            const e = httpError(
              `Ячейка ${locBy.get(toId).code} переполнится: вместимость ${cap}, будет ${inCell.rows[0].s + quantity}`,
              409
            );
            e.details = { code: 'LOCATION_OVER_CAPACITY' };
            throw e;
          }
        }
      }

      if (fromId) {
        await client.query(
          `UPDATE product_location_stock SET quantity = quantity - $3, updated_at = CURRENT_TIMESTAMP
           WHERE product_id = $1 AND location_id = $2`,
          [productId, fromId, quantity]
        );
        await client.query(
          `DELETE FROM product_location_stock WHERE product_id = $1 AND location_id = $2 AND quantity <= 0`,
          [productId, fromId]
        );
      }
      if (toId) {
        await client.query(
          `INSERT INTO product_location_stock (product_id, location_id, warehouse_id, quantity)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (product_id, location_id) DO UPDATE SET
             quantity = product_location_stock.quantity + EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
          [productId, toId, warehouseId, quantity]
        );
      }
      await client.query(
        `INSERT INTO storage_location_movements
           (product_id, warehouse_id, from_location_id, to_location_id, quantity, kind, user_id, note)
         VALUES ($1, $2, $3, $4, $5, 'move', $6, $7)`,
        [
          productId,
          warehouseId,
          fromId,
          toId,
          quantity,
          userId,
          body.note ? String(body.note).slice(0, 300) : null,
        ]
      );
      return {
        productId,
        quantity,
        from: fromId ? locBy.get(fromId).code : null,
        to: toId ? locBy.get(toId).code : null,
      };
    });
  }

  /**
   * После прихода на склад: если включён учёт по ячейкам и у товара есть закреплённая ячейка —
   * сразу положить принятое количество туда (из «без адреса»). Без закрепления — не трогаем.
   * Переполнение вместимости: не размещаем, товар остаётся без адреса.
   * @returns {{ placed: boolean, code?: string, locationId?: number, reason?: string }}
   */
  async placeInboundToAssigned(warehouseId, productId, quantity, { userId = null, note = null, client = null } = {}) {
    const wid = toPosInt(warehouseId);
    const pid = toPosInt(productId);
    const qty = toPosInt(quantity);
    if (!wid || !pid || !qty) return { placed: false, reason: 'bad_args' };

    const run = async (db) => {
      const settings = await this.getSettings(wid);
      if (!settings.enabled || !settings.trackQuantities) return { placed: false, reason: 'disabled' };

      const p = await db.query(`SELECT id FROM products WHERE id = $1`, [pid]);
      if (!p.rows[0]) return { placed: false, reason: 'not_found' };

      const a = await db.query(
        `SELECT a.location_id, l.code, l.capacity, l.is_active
         FROM product_storage_assignments a
         JOIN storage_locations l ON l.id = a.location_id
         WHERE a.product_id = $1 AND a.warehouse_id = $2`,
        [pid, wid]
      );
      if (!a.rows[0] || a.rows[0].is_active === false) return { placed: false, reason: 'no_assignment' };
      const locationId = Number(a.rows[0].location_id);
      const code = String(a.rows[0].code);
      const capacity = a.rows[0].capacity != null ? Number(a.rows[0].capacity) : null;

      const pws = await db.query(
        `SELECT quantity FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE`,
        [pid, wid]
      );
      const whQty = Number(pws.rows[0]?.quantity) || 0;
      const placedR = await db.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS s FROM product_location_stock
         WHERE product_id = $1 AND warehouse_id = $2`,
        [pid, wid]
      );
      const unplaced = whQty - Number(placedR.rows[0].s);
      if (unplaced < qty) return { placed: false, reason: 'no_unplaced', unplaced: Math.max(0, unplaced) };

      if (capacity != null) {
        const inCell = await db.query(
          `SELECT COALESCE(SUM(quantity), 0)::int AS s FROM product_location_stock WHERE location_id = $1`,
          [locationId]
        );
        if (Number(inCell.rows[0].s) + qty > capacity) {
          return { placed: false, reason: 'over_capacity', code, locationId };
        }
      }

      await db.query(
        `INSERT INTO product_location_stock (product_id, location_id, warehouse_id, quantity)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_id, location_id) DO UPDATE SET
           quantity = product_location_stock.quantity + EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
        [pid, locationId, wid, qty]
      );
      await db.query(
        `INSERT INTO storage_location_movements
           (product_id, warehouse_id, from_location_id, to_location_id, quantity, kind, user_id, note)
         VALUES ($1, $2, NULL, $3, $4, 'move', $5, $6)`,
        [pid, wid, locationId, qty, userId, note ? String(note).slice(0, 300) : 'Приход в закреплённую ячейку']
      );
      return { placed: true, code, locationId };
    };

    if (client) return run(client);
    return transaction(run);
  }

  /** Разместить весь остаток «без адреса» в закреплённые ячейки (первичный переход на учёт по ячейкам). */
  async placeUnplacedToAssigned(warehouseId, { userId = null } = {}) {
    return transaction(async (client) => {
      const r = await client.query(
        `SELECT pws.product_id, a.location_id,
                (pws.quantity - COALESCE(s.placed, 0))::int AS unplaced
         FROM product_warehouse_stock pws
         JOIN product_storage_assignments a
           ON a.product_id = pws.product_id AND a.warehouse_id = pws.warehouse_id
         LEFT JOIN (
           SELECT product_id, SUM(quantity)::int AS placed
           FROM product_location_stock WHERE warehouse_id = $1 GROUP BY product_id
         ) s ON s.product_id = pws.product_id
         WHERE pws.warehouse_id = $1 AND pws.quantity > COALESCE(s.placed, 0)
         FOR UPDATE OF pws`,
        [warehouseId]
      );
      if (!r.rows.length) return { products: 0, quantity: 0 };
      const pids = r.rows.map((x) => Number(x.product_id));
      const lids = r.rows.map((x) => Number(x.location_id));
      const qtys = r.rows.map((x) => Number(x.unplaced));
      await client.query(
        `INSERT INTO product_location_stock (product_id, location_id, warehouse_id, quantity)
         SELECT t.pid, t.lid, $1::bigint, t.q FROM unnest($2::bigint[], $3::bigint[], $4::int[]) AS t(pid, lid, q)
         ON CONFLICT (product_id, location_id) DO UPDATE SET
           quantity = product_location_stock.quantity + EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
        [warehouseId, pids, lids, qtys]
      );
      await client.query(
        `INSERT INTO storage_location_movements
           (product_id, warehouse_id, from_location_id, to_location_id, quantity, kind, user_id, note)
         SELECT t.pid, $1::bigint, NULL::bigint, t.lid, t.q, 'move', $5::bigint, 'Размещение в закреплённые ячейки'
         FROM unnest($2::bigint[], $3::bigint[], $4::int[]) AS t(pid, lid, q)`,
        [warehouseId, pids, lids, qtys, userId]
      );
      return { products: pids.length, quantity: qtys.reduce((s, q) => s + q, 0) };
    });
  }

  /** unplaced — есть остаток без адреса; unassigned — есть остаток, но нет закреплённой ячейки. */
  async listPending(warehouseId, { kind = 'unplaced', limit = 500 } = {}) {
    const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
    const cond =
      kind === 'unassigned'
        ? `a.location_id IS NULL AND pws.quantity > 0`
        : `pws.quantity > COALESCE(s.placed, 0)`;
    const r = await query(
      `SELECT p.id, p.name, p.sku, pws.quantity::int AS wh_qty,
              COALESCE(s.placed, 0)::int AS placed,
              a.location_id, l.code AS location_code
       FROM product_warehouse_stock pws
       JOIN products p ON p.id = pws.product_id
       LEFT JOIN (
         SELECT product_id, SUM(quantity)::int AS placed
         FROM product_location_stock WHERE warehouse_id = $1 GROUP BY product_id
       ) s ON s.product_id = pws.product_id
       LEFT JOIN product_storage_assignments a ON a.product_id = pws.product_id AND a.warehouse_id = $1
       LEFT JOIN storage_locations l ON l.id = a.location_id
       WHERE pws.warehouse_id = $1 AND ${cond}
       ORDER BY (pws.quantity - COALESCE(s.placed, 0)) DESC, p.name
       LIMIT $2`,
      [warehouseId, lim]
    );
    return r.rows.map((row) => ({
      productId: Number(row.id),
      name: row.name,
      sku: row.sku,
      warehouseQty: row.wh_qty,
      placed: row.placed,
      unplaced: Math.max(0, row.wh_qty - row.placed),
      assignedLocationId: row.location_id != null ? Number(row.location_id) : null,
      assignedLocationCode: row.location_code || null,
    }));
  }

  async listMovements(warehouseId, { limit = 200, productId = null } = {}) {
    const params = [warehouseId, Math.min(1000, Math.max(1, Number(limit) || 200))];
    let extra = '';
    if (toPosInt(productId)) {
      params.push(toPosInt(productId));
      extra = `AND m.product_id = $${params.length}`;
    }
    const r = await query(
      `SELECT m.*, p.name AS product_name, p.sku AS product_sku,
              lf.code AS from_code, lt.code AS to_code,
              COALESCE(NULLIF(TRIM(u.full_name), ''), u.email) AS user_name
       FROM storage_location_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN storage_locations lf ON lf.id = m.from_location_id
       LEFT JOIN storage_locations lt ON lt.id = m.to_location_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.warehouse_id = $1 ${extra}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $2`,
      params
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at,
      productId: Number(row.product_id),
      productName: row.product_name,
      productSku: row.product_sku,
      fromCode: row.from_code || null,
      toCode: row.to_code || null,
      quantity: Number(row.quantity),
      kind: row.kind,
      userName: row.user_name || null,
      note: row.note || null,
    }));
  }

  /** Скан на экране перемещений: ячейка или товар. */
  async resolveScan(warehouseId, raw, { profileId = null } = {}) {
    const loc = await this.resolveLocationByScan(warehouseId, raw);
    if (loc) {
      const items = await query(
        `SELECT s.product_id, s.quantity, p.name, p.sku FROM product_location_stock s
         JOIN products p ON p.id = s.product_id WHERE s.location_id = $1 ORDER BY p.name`,
        [loc.id]
      );
      return {
        type: 'location',
        location: loc,
        items: items.rows.map((r) => ({
          productId: Number(r.product_id),
          name: r.name,
          sku: r.sku,
          quantity: Number(r.quantity),
        })),
      };
    }
    const { default: productsService } = await import('./products.service.js');
    const product = await productsService.getByBarcode(String(raw ?? '').trim()).catch(() => null);
    if (!product?.id) return null;
    if (profileId != null && product.profile_id != null && String(product.profile_id) !== String(profileId)) {
      return null;
    }
    const where = await this.getProductLocations(product.id, { profileId });
    const wh = where.warehouses.find((w) => w.warehouseId === Number(warehouseId)) || null;
    return {
      type: 'product',
      product: { id: Number(product.id), name: product.name, sku: product.sku },
      warehouse: wh,
    };
  }

  // ---------- Тепловая карта и план ----------

  async getHeatmap(warehouseId, { days = 30 } = {}) {
    const d = Math.min(365, Math.max(1, Number(days) || 30));
    const r = await query(
      `WITH cell_products AS (
         SELECT location_id, product_id FROM product_storage_assignments WHERE warehouse_id = $1
         UNION
         SELECT location_id, product_id FROM product_location_stock WHERE warehouse_id = $1
       ),
       sales AS (
         SELECT product_id, SUM(-quantity_change)::int AS shipped, MAX(created_at) AS last_at
         FROM stock_movements
         WHERE warehouse_id = $1 AND type = 'shipment' AND quantity_change < 0
           AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
         GROUP BY product_id
       ),
       last_any AS (
         SELECT product_id, MAX(created_at) AS last_at
         FROM stock_movements WHERE warehouse_id = $1 GROUP BY product_id
       )
       SELECT l.id,
              COALESCE((SELECT SUM(quantity) FROM product_location_stock s WHERE s.location_id = l.id), 0)::int AS qty,
              COUNT(cp.product_id)::int AS products,
              COALESCE(SUM(sa.shipped), 0)::int AS shipped,
              MAX(la.last_at) AS last_movement_at
       FROM storage_locations l
       LEFT JOIN cell_products cp ON cp.location_id = l.id
       LEFT JOIN sales sa ON sa.product_id = cp.product_id
       LEFT JOIN last_any la ON la.product_id = cp.product_id
       WHERE l.warehouse_id = $1
       GROUP BY l.id`,
      [warehouseId, d]
    );
    const now = Date.now();
    return {
      days: d,
      cells: r.rows.map((row) => ({
        locationId: Number(row.id),
        quantity: row.qty,
        products: row.products,
        shipped: row.shipped,
        idleDays: row.last_movement_at
          ? Math.floor((now - new Date(row.last_movement_at).getTime()) / 86400000)
          : null,
      })),
    };
  }

  async getLayout(warehouseId) {
    const r = await query(`SELECT * FROM warehouse_layouts WHERE warehouse_id = $1`, [warehouseId]);
    const row = r.rows[0];
    return {
      warehouseId: Number(warehouseId),
      width: row ? Number(row.width) : 40,
      height: row ? Number(row.height) : 24,
      items: row && Array.isArray(row.items) ? row.items : [],
      updatedAt: row?.updated_at || null,
    };
  }

  async saveLayout(warehouseId, body = {}) {
    const width = toPosInt(body.width) || 40;
    const height = toPosInt(body.height) || 24;
    if (width > 300 || height > 300) throw httpError('План: не больше 300×300 клеток');
    const raw = Array.isArray(body.items) ? body.items : [];
    if (raw.length > MAX_LAYOUT_ITEMS) throw httpError(`План: не больше ${MAX_LAYOUT_ITEMS} элементов`);
    // Повёрнутые элементы двигаются не по сетке, поэтому координаты храним с точностью до сотых.
    const num = (v, min, max, def) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return def;
      return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
    };
    const angle = (v) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
    };
    const items = raw.map((it, i) => {
      const kind = LAYOUT_ITEM_KINDS.includes(it?.kind) ? it.kind : 'rack';
      return {
        id: String(it?.id ?? `i${i}`).slice(0, 40),
        kind,
        x: num(it?.x, 0, width - 0.5, 0),
        y: num(it?.y, 0, height - 0.5, 0),
        w: num(it?.w, 0.5, width, 2),
        h: num(it?.h, 0.5, height, 1),
        rot: angle(it?.rot),
        label: String(it?.label ?? '').slice(0, 64),
        rackKey: kind === 'rack' ? String(it?.rackKey ?? '').slice(0, 64) : '',
      };
    });
    await query(
      `INSERT INTO warehouse_layouts (warehouse_id, width, height, items, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (warehouse_id) DO UPDATE SET
         width = EXCLUDED.width, height = EXCLUDED.height, items = EXCLUDED.items,
         updated_at = CURRENT_TIMESTAMP`,
      [warehouseId, width, height, JSON.stringify(items)]
    );
    return this.getLayout(warehouseId);
  }
}

export default new AddressStorageService();
