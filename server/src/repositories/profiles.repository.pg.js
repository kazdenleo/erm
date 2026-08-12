/**
 * Profiles Repository (PostgreSQL)
 */

import { query } from '../config/database.js';
import { parseRoleNavSections } from '../utils/userNavSections.js';
import { normalizeProfileTimezone } from '../utils/profileTimezone.js';
import { normalizePartsApiKeys } from '../config/partsapi.config.js';
import { normalizePartsIndexKeys } from '../config/partsindex.config.js';

/**
 * Таблицы с profile_id (shared DB). Оценка размера аккаунта =
 * доля строк профиля × pg_total_relation_size(таблица).
 */
const PROFILE_SCOPED_TABLES = Object.freeze([
  'brands',
  'category_label_templates',
  'employee_tasks',
  'fbo_purchase_calc_sessions',
  'fbo_supplies',
  'integrations',
  'inventory_sessions',
  'marketplace_fbo_report_lines',
  'marketplace_fbo_report_syncs',
  'marketplace_fbs_report_lines',
  'marketplace_fbs_report_syncs',
  'marketplace_inventory_snapshots',
  'marketplace_price_changes',
  'marketplace_questions',
  'marketplace_return_claims',
  'marketplace_reviews',
  'order_fulfillment_lines',
  'orders',
  'organizations',
  'ozon_ads_sku_stats',
  'pricing_strategies',
  'products',
  'purchases',
  'question_answer_templates',
  'review_auto_reply_rules',
  'review_reply_templates',
  'stock_movements',
  'supplier_returns',
  'suppliers',
  'support_inquiries',
  'user_categories',
  'users',
  'warehouse_suppliers',
  'warehouses',
  'wb_fbo_forecast_snapshots',
]);

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Недопустимое имя таблицы: ${name}`);
  }
  return `"${name}"`;
}

class ProfilesRepositoryPG {
  async findAll() {
    const result = await query(
      'SELECT * FROM profiles ORDER BY name'
    );
    return result.rows;
  }

  /** Аккаунты с включённой интеграцией поставщиков (для фоновой синхронизации остатков). */
  async findSupplierSyncEnabled() {
    const result = await query(
      `SELECT * FROM profiles
       WHERE COALESCE(supplier_sync_enabled, true) = true
       ORDER BY id`
    );
    return result.rows;
  }

  /**
   * Оценка объёма данных по аккаунтам (байты): доля строк × размер таблицы.
   * @param {number|null} [onlyProfileId] — если задан, считает только этот профиль
   * @returns {Promise<Map<number, number>>}
   */
  async getStorageBytesByProfile(onlyProfileId = null) {
    const filterId = onlyProfileId != null && onlyProfileId !== '' ? Number(onlyProfileId) : null;
    const params = filterId != null && Number.isFinite(filterId) ? [filterId] : [];
    const profileFilter = params.length ? 'AND t.profile_id = $1' : '';

    const parts = PROFILE_SCOPED_TABLES.map((table) => {
      const q = quoteIdent(table);
      return `
        SELECT
          profile_id::bigint AS profile_id,
          CASE
            WHEN total_cnt <= 0 THEN 0::float8
            ELSE (cnt::float8 / total_cnt) * rel_size
          END AS bytes
        FROM (
          SELECT
            t.profile_id,
            COUNT(*)::bigint AS cnt,
            (SELECT COUNT(*)::bigint FROM ${q}) AS total_cnt,
            pg_total_relation_size('${table}'::regclass) AS rel_size
          FROM ${q} t
          WHERE t.profile_id IS NOT NULL
            ${profileFilter}
          GROUP BY t.profile_id
        ) s
      `;
    });

    const result = await query(
      `
      SELECT profile_id, ROUND(COALESCE(SUM(bytes), 0))::bigint AS storage_bytes
      FROM (
        ${parts.join('\nUNION ALL\n')}
      ) u
      GROUP BY profile_id
    `,
      params
    );

    const map = new Map();
    for (const row of result.rows) {
      map.set(Number(row.profile_id), Number(row.storage_bytes) || 0);
    }
    return map;
  }

  /**
   * Список профилей с количеством пользователей, организаций, товаров и объёмом данных
   */
  async findAllWithStats() {
    const result = await query(`
      SELECT
        p.*,
        (SELECT COUNT(*)::int FROM users u WHERE u.profile_id = p.id AND u.role <> 'admin') AS users_count,
        (
          SELECT COUNT(*)::int
          FROM organizations o
          WHERE o.profile_id = p.id
            OR (
              o.profile_id IS NULL
              AND (SELECT COUNT(*)::int FROM profiles) = 1
              AND p.id = (SELECT id FROM profiles ORDER BY id LIMIT 1)
            )
        ) AS organizations_count,
        (
          SELECT COUNT(*)::int
          FROM products pr
          WHERE pr.profile_id = p.id
            AND COALESCE(pr.is_archived, false) = false
        ) AS products_count
      FROM profiles p
      ORDER BY p.name
    `);
    const storageMap = await this.getStorageBytesByProfile();
    return result.rows.map((row) => ({
      ...row,
      storage_bytes: storageMap.get(Number(row.id)) || 0,
    }));
  }

  /** Счётчики для карточки аккаунта (кабинет системного админа) */
  async getCabinetStats(profileId) {
    const id = Number(profileId);
    const stats = await query(
      `SELECT
        (SELECT COUNT(*)::int FROM users WHERE profile_id = $1 AND role <> 'admin') AS users_count,
        (
          SELECT COUNT(*)::int
          FROM organizations o
          WHERE o.profile_id = $1
            OR (
              o.profile_id IS NULL
              AND (SELECT COUNT(*)::int FROM profiles) = 1
              AND $1::bigint = (SELECT id FROM profiles ORDER BY id LIMIT 1)
            )
        ) AS organizations_count,
        (
          SELECT COUNT(*)::int
          FROM products pr
          WHERE pr.profile_id = $1
            AND COALESCE(pr.is_archived, false) = false
        ) AS products_count`,
      [id]
    );
    const storageMap = await this.getStorageBytesByProfile(id);
    const row = stats.rows[0] || {};
    return {
      ...row,
      storage_bytes: storageMap.get(id) || 0,
    };
  }

  async findById(id) {
    const result = await query(
      'SELECT * FROM profiles WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async create(data) {
    const d = typeof data === 'object' ? data : { name: data };
    const name = d.name ?? d;
    const result = await query(
      `INSERT INTO profiles (name, contact_full_name, contact_email, contact_phone, tariff)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        name,
        d.contact_full_name ?? d.contactFullName ?? null,
        d.contact_email ?? d.contactEmail ?? null,
        d.contact_phone ?? d.contactPhone ?? null,
        d.tariff ?? null,
      ]
    );
    return result.rows[0];
  }

  async update(id, data) {
    const updates = typeof data === 'object' ? data : { name: data };
    const fields = [];
    const params = [];
    let i = 1;

    const set = (col, val) => {
      fields.push(`${col} = $${i++}`);
      params.push(val);
    };

    if (updates.name !== undefined) set('name', updates.name);
    if (updates.contact_full_name !== undefined || updates.contactFullName !== undefined) {
      const v = updates.contact_full_name ?? updates.contactFullName;
      set('contact_full_name', v === '' ? null : v);
    }
    if (updates.contact_email !== undefined || updates.contactEmail !== undefined) {
      const v = updates.contact_email ?? updates.contactEmail;
      set('contact_email', v === '' ? null : v);
    }
    if (updates.contact_phone !== undefined || updates.contactPhone !== undefined) {
      const v = updates.contact_phone ?? updates.contactPhone;
      set('contact_phone', v === '' ? null : v);
    }
    if (updates.tariff !== undefined) {
      set('tariff', updates.tariff === '' ? null : updates.tariff);
    }
    if (updates.allow_private_orders !== undefined || updates.allowPrivateOrders !== undefined) {
      const v = updates.allow_private_orders ?? updates.allowPrivateOrders;
      set('allow_private_orders', v === true || v === '1' || v === 'true');
    }
    if (
      updates.require_reserved_stock_for_assembly !== undefined ||
      updates.requireReservedStockForAssembly !== undefined
    ) {
      const v = updates.require_reserved_stock_for_assembly ?? updates.requireReservedStockForAssembly;
      set('require_reserved_stock_for_assembly', v === true || v === '1' || v === 'true');
    }
    if (
      updates.auto_send_to_assembly_on_reserve !== undefined ||
      updates.autoSendToAssemblyOnReserve !== undefined
    ) {
      const v = updates.auto_send_to_assembly_on_reserve ?? updates.autoSendToAssemblyOnReserve;
      set('auto_send_to_assembly_on_reserve', v === true || v === '1' || v === 'true');
    }
    if (updates.supplier_sync_enabled !== undefined || updates.supplierSyncEnabled !== undefined) {
      const v = updates.supplier_sync_enabled ?? updates.supplierSyncEnabled;
      set('supplier_sync_enabled', v === true || v === '1' || v === 'true');
    }
    if (
      updates.product_enrichment_enabled !== undefined ||
      updates.productEnrichmentEnabled !== undefined
    ) {
      const v = updates.product_enrichment_enabled ?? updates.productEnrichmentEnabled;
      set('product_enrichment_enabled', v === true || v === '1' || v === 'true');
    }
    if (
      updates.allow_manual_warehouse_stock_edit !== undefined ||
      updates.allowManualWarehouseStockEdit !== undefined
    ) {
      const v = updates.allow_manual_warehouse_stock_edit ?? updates.allowManualWarehouseStockEdit;
      set('allow_manual_warehouse_stock_edit', v === true || v === '1' || v === 'true');
    }
    if (
      updates.allow_stock_history_reset !== undefined ||
      updates.allowStockHistoryReset !== undefined
    ) {
      const v = updates.allow_stock_history_reset ?? updates.allowStockHistoryReset;
      set('allow_stock_history_reset', v === true || v === '1' || v === 'true');
    }
    if (
      updates.procurement_status_enabled !== undefined ||
      updates.procurementStatusEnabled !== undefined
    ) {
      const v = updates.procurement_status_enabled ?? updates.procurementStatusEnabled;
      set('procurement_status_enabled', v === true || v === '1' || v === 'true');
    }
    if (updates.kits_enabled !== undefined || updates.kitsEnabled !== undefined) {
      const v = updates.kits_enabled ?? updates.kitsEnabled;
      set('kits_enabled', v === true || v === '1' || v === 'true');
    }
    if (
      updates.pricing_strategies_enabled !== undefined ||
      updates.pricingStrategiesEnabled !== undefined
    ) {
      const v = updates.pricing_strategies_enabled ?? updates.pricingStrategiesEnabled;
      set('pricing_strategies_enabled', v === true || v === '1' || v === 'true');
    }
    if (updates.production_enabled !== undefined || updates.productionEnabled !== undefined) {
      const v = updates.production_enabled ?? updates.productionEnabled;
      set('production_enabled', v === true || v === '1' || v === 'true');
    }
    if (
      updates.allow_product_supplier_binding !== undefined ||
      updates.allowProductSupplierBinding !== undefined
    ) {
      const v = updates.allow_product_supplier_binding ?? updates.allowProductSupplierBinding;
      set('allow_product_supplier_binding', v === true || v === '1' || v === 'true');
    }
    if (updates.display_length_unit !== undefined || updates.displayLengthUnit !== undefined) {
      const v = String(updates.display_length_unit ?? updates.displayLengthUnit ?? 'mm')
        .trim()
        .toLowerCase();
      set('display_length_unit', v === 'cm' ? 'cm' : 'mm');
    }
    if (updates.display_weight_unit !== undefined || updates.displayWeightUnit !== undefined) {
      const v = String(updates.display_weight_unit ?? updates.displayWeightUnit ?? 'g')
        .trim()
        .toLowerCase();
      set('display_weight_unit', v === 'kg' ? 'kg' : 'g');
    }
    if (updates.timezone !== undefined || updates.timeZone !== undefined) {
      set('timezone', normalizeProfileTimezone(updates.timezone ?? updates.timeZone));
    }
    if (
      updates.manual_orders_warehouse_id !== undefined ||
      updates.manualOrdersWarehouseId !== undefined
    ) {
      const raw = updates.manual_orders_warehouse_id ?? updates.manualOrdersWarehouseId;
      if (raw == null || raw === '') {
        set('manual_orders_warehouse_id', null);
      } else {
        const n = Number(raw);
        set('manual_orders_warehouse_id', Number.isFinite(n) && n > 0 ? n : null);
      }
    }
    if (updates.fbs_enabled !== undefined || updates.fbsEnabled !== undefined) {
      const v = updates.fbs_enabled ?? updates.fbsEnabled;
      set('fbs_enabled', v === true || v === '1' || v === 'true');
    }
    if (updates.fbo_enabled !== undefined || updates.fboEnabled !== undefined) {
      const v = updates.fbo_enabled ?? updates.fboEnabled;
      set('fbo_enabled', v === true || v === '1' || v === 'true');
    }
    if (updates.partsapi_keys !== undefined || updates.partsapiKeys !== undefined) {
      const raw = updates.partsapi_keys ?? updates.partsapiKeys;
      set('partsapi_keys', JSON.stringify(normalizePartsApiKeys(raw)));
    }
    if (updates.partsindex_keys !== undefined || updates.partsindexKeys !== undefined) {
      const raw = updates.partsindex_keys ?? updates.partsindexKeys;
      set('partsindex_keys', JSON.stringify(normalizePartsIndexKeys(raw)));
    }
    if (
      updates.fbo_deduction_warehouse_id !== undefined ||
      updates.fboDeductionWarehouseId !== undefined
    ) {
      const raw = updates.fbo_deduction_warehouse_id ?? updates.fboDeductionWarehouseId;
      if (raw == null || raw === '') {
        set('fbo_deduction_warehouse_id', null);
      } else {
        const n = Number(raw);
        set('fbo_deduction_warehouse_id', Number.isFinite(n) && n > 0 ? n : null);
      }
    }
    if (updates.role_nav_sections !== undefined || updates.roleNavSections !== undefined) {
      const raw = updates.role_nav_sections ?? updates.roleNavSections;
      set('role_nav_sections', JSON.stringify(parseRoleNavSections(raw)));
    }

    if (fields.length === 0) return await this.findById(id);
    params.push(id);
    const result = await query(
      `UPDATE profiles SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${i} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  async delete(id) {
    const result = await query('DELETE FROM profiles WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
}

export default new ProfilesRepositoryPG();
