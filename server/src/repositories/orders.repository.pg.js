/**
 * Orders Repository (PostgreSQL)
 * Репозиторий для работы с заказами в PostgreSQL
 */

import { query, transaction } from '../config/database.js';

/** Преобразование строки БД (snake_case) в формат API (camelCase) для совместимости с фронтом и файловым хранилищем */
function rowToCamel(row) {
  if (!row) return row;
  const pid =
    row.product_id != null && row.product_id !== ''
      ? Number(row.product_id)
      : row.matched_product_id != null && row.matched_product_id !== ''
        ? Number(row.matched_product_id)
        : null;
  const productId = Number.isFinite(pid) && pid >= 1 ? pid : null;
  return {
    id: row.id,
    marketplace: marketplaceFromDb(row.marketplace),
    orderId: row.order_id,
    orderGroupId: row.order_group_id || null,
    productId,
    offerId: row.offer_id,
    sku: row.marketplace_sku,
    productSku:
      row.product_sku != null && String(row.product_sku).trim() !== ''
        ? String(row.product_sku).trim()
        : null,
    productName: row.product_name,
    quantity: row.quantity,
    price: parseFloat(row.price),
    status: row.status,
    stockProblem: row.stock_problem ?? false,
    stockProblemDetectedAt: row.stock_problem_detected_at ?? null,
    stockProblemDetails: row.stock_problem_details ?? null,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    deliveryAddress: row.delivery_address,
    createdAt: row.created_at,
    inProcessAt: row.in_process_at,
    shipmentDate: row.shipment_date,
    updatedAt: row.updated_at,
    assembledAt: row.assembled_at ?? null,
    assembledByUserId: row.assembled_by_user_id ?? null,
    assembledByEmail: row.assembled_by_email ?? null,
    assembledByFullName: row.assembled_by_full_name ?? null,
    returnedToNewAt: row.returned_to_new_at ?? null,
    hasReserve: row.has_reserve ?? row.hasReserve ?? false,
    reservedQty: row.reserved_qty != null ? Number(row.reserved_qty) : (row.reservedQty != null ? Number(row.reservedQty) : 0)
  };
}

/** Нормализация marketplace для БД: таблица допускает только ozon, wb, ym */
function normalizeMarketplaceForDb(marketplace) {
  const m = (marketplace || '').toLowerCase();
  if (m === 'wildberries') return 'wb';
  if (m === 'yandex') return 'ym';
  return m || 'ozon';
}

/** В ответах API отдаём единый формат: ozon, wildberries, yandex (как в файловом хранилище и на фронте) */
function marketplaceFromDb(dbMarketplace) {
  if (dbMarketplace === 'wb') return 'wildberries';
  if (dbMarketplace === 'ym') return 'yandex';
  return dbMarketplace || 'ozon';
}

/** Преобразует значение в Date для БД; при невалидной дате возвращает null */
function toValidDate(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

class OrdersRepositoryPG {
  /**
   * Массово выставить/снять флаг stock_problem для активных заказов.
   * @param {object} params
   * @param {number[]} params.problemOrderIds - orders.id, которые должны иметь stock_problem=true
   * @param {object} params.detailsByOrderId - { [orderId]: any } диагностика (JSON)
   * @param {string[]} params.activeStatuses - статусы заказов, которые считаются "активными" для флага
   */
  async setStockProblemFlags({ problemOrderIds = [], detailsByOrderId = {}, activeStatuses = [] } = {}) {
    const ids = (Array.isArray(problemOrderIds) ? problemOrderIds : [])
      .map((x) => (typeof x === 'string' ? parseInt(x, 10) : Number(x)))
      .filter((n) => Number.isFinite(n) && n > 0);
    const statuses = Array.isArray(activeStatuses) ? activeStatuses.map(String) : [];

    return await transaction(async (client) => {
      // 1) Снять флаг со всех активных заказов, которые сейчас НЕ в проблемном списке
      if (statuses.length > 0) {
        if (ids.length > 0) {
          await client.query(
            `UPDATE orders
             SET stock_problem = false,
                 stock_problem_detected_at = NULL,
                 stock_problem_details = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE status = ANY($1::text[])
               AND stock_problem = true
               AND id <> ALL($2::bigint[])`,
            [statuses, ids]
          );
        } else {
          await client.query(
            `UPDATE orders
             SET stock_problem = false,
                 stock_problem_detected_at = NULL,
                 stock_problem_details = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE status = ANY($1::text[])
               AND stock_problem = true`,
            [statuses]
          );
        }
      }

      // 2) Выставить флаг на проблемные
      let updated = 0;
      for (const id of ids) {
        const details = Object.prototype.hasOwnProperty.call(detailsByOrderId, String(id))
          ? detailsByOrderId[String(id)]
          : (Object.prototype.hasOwnProperty.call(detailsByOrderId, id) ? detailsByOrderId[id] : null);
        const params = [id];
        let sql = `
          UPDATE orders
          SET stock_problem = true,
              stock_problem_detected_at = CURRENT_TIMESTAMP,
              stock_problem_details = $2::jsonb,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `;
        params.push(details != null ? JSON.stringify(details) : JSON.stringify(null));
        if (statuses.length > 0) {
          sql += ` AND status = ANY($3::text[])`;
          params.push(statuses);
        }
        const r = await client.query(sql, params);
        updated += r.rowCount || 0;
      }
      return { updated, totalProblemOrders: ids.length };
    });
  }

  /**
   * Получить все заказы (возвращает camelCase для API).
   * Сопоставление с каталогом по product_skus (название товара); при ошибке или отсутствии таблицы — без него.
   */
  async findAll(options = {}) {
    const { limit, offset, marketplace, status, productId, search, stockProblem } = options;
    const params = [];
    let paramIndex = 1;
    let whereSql = ' WHERE 1=1';
    if (marketplace) {
      whereSql += ` AND o.marketplace = $${paramIndex++}`;
      params.push(marketplace);
    }
    if (status) {
      whereSql += ` AND o.status = $${paramIndex++}`;
      params.push(status);
    }
    if (productId) {
      whereSql += ` AND o.product_id = $${paramIndex++}`;
      params.push(productId);
    }
    if (search) {
      whereSql += ` AND ( o.order_id ILIKE $${paramIndex} OR o.product_name ILIKE $${paramIndex} OR o.customer_name ILIKE $${paramIndex} )`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    if (stockProblem === true) {
      whereSql += ` AND o.stock_problem = true`;
    } else if (stockProblem === false) {
      whereSql += ` AND o.stock_problem = false`;
    }
    let limitOffsetSql = ' ORDER BY o.created_at DESC, o.in_process_at DESC';
    if (limit) {
      limitOffsetSql += ` LIMIT $${paramIndex++}`;
      params.push(limit);
    }
    if (offset) {
      limitOffsetSql += ` OFFSET $${paramIndex++}`;
      params.push(offset);
    }

    const sqlWithJoin = `
      SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.offer_id, o.marketplace_sku,
        COALESCE(p.name, pm.matched_product_name, o.product_name) AS product_name,
        o.quantity, o.price, o.status, o.customer_name, o.customer_phone,
        o.delivery_address, o.created_at, o.in_process_at, o.shipment_date, o.updated_at,
        o.stock_problem, o.stock_problem_detected_at, o.stock_problem_details,
        o.returned_to_new_at,
        o.assembled_at, o.assembled_by_user_id,
        assembler.email AS assembled_by_email,
        assembler.full_name AS assembled_by_full_name,
        COALESCE(p.sku, pm.matched_product_sku) AS product_sku,
        EXISTS(
          SELECT 1 FROM stock_movements sm
          WHERE sm.type = 'reserve'
            AND sm.quantity_change < 0
            AND sm.meta ? 'order_id'
            AND (sm.meta->>'order_id')::bigint = o.id::bigint
          LIMIT 1
        ) AS has_reserve,
        COALESCE((
          SELECT
            GREATEST(
              0,
              COALESCE(SUM(CASE WHEN sm.type = 'reserve' THEN -sm.quantity_change ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN sm.type = 'unreserve' THEN sm.quantity_change ELSE 0 END), 0)
            )::int
          FROM stock_movements sm
          WHERE (sm.type = 'reserve' OR sm.type = 'unreserve')
            AND sm.meta ? 'order_id'
            AND (sm.meta->>'order_id')::bigint = o.id::bigint
        ), 0)::int AS reserved_qty
      FROM orders o
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN users assembler ON o.assembled_by_user_id = assembler.id
      LEFT JOIN LATERAL (
        SELECT p2.name AS matched_product_name, p2.sku AS matched_product_sku, p2.id AS matched_product_id
        FROM product_skus ps
        JOIN products p2 ON p2.id = ps.product_id
        WHERE ps.marketplace = o.marketplace
          AND ( (o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(o.offer_id))
                OR (o.marketplace_sku IS NOT NULL AND TRIM(ps.sku) = TRIM(CAST(o.marketplace_sku AS TEXT)))
                OR (o.marketplace = 'ozon' AND o.marketplace_sku IS NOT NULL AND ps.marketplace_product_id IS NOT NULL
                    AND ps.marketplace_product_id = o.marketplace_sku::bigint)
                OR (o.marketplace = 'wb' AND o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.offer_id::text, '^.*?([0-9]+)$', '\\1')))
                OR (o.marketplace = 'wb' AND o.product_name IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.product_name::text, '^.*?([0-9]+)$', '\\1'))) )
        LIMIT 1
      ) pm ON true
      ${whereSql} ${limitOffsetSql}
    `;

    try {
      const result = await query(sqlWithJoin, params);
      return result.rows.map(rowToCamel);
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('product_skus') || msg.includes('does not exist') || msg.includes('relation')) {
        const paramsSimple = [];
        let pi = 1;
        let sqlSimple = `
          SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.offer_id, o.marketplace_sku,
            COALESCE(p.name, o.product_name) AS product_name,
            o.quantity, o.price, o.status, o.customer_name, o.customer_phone,
            o.delivery_address, o.created_at, o.in_process_at, o.shipment_date, o.updated_at,
            o.stock_problem, o.stock_problem_detected_at, o.stock_problem_details,
            o.returned_to_new_at,
            o.assembled_at, o.assembled_by_user_id,
            assembler.email AS assembled_by_email,
            assembler.full_name AS assembled_by_full_name,
            p.sku AS product_sku,
            EXISTS(
              SELECT 1 FROM stock_movements sm
              WHERE sm.type = 'reserve'
                AND sm.quantity_change < 0
                AND sm.meta ? 'order_id'
                AND (sm.meta->>'order_id')::bigint = o.id::bigint
              LIMIT 1
            ) AS has_reserve,
            COALESCE((
              SELECT
                GREATEST(
                  0,
                  COALESCE(SUM(CASE WHEN sm.type = 'reserve' THEN -sm.quantity_change ELSE 0 END), 0)
                  - COALESCE(SUM(CASE WHEN sm.type = 'unreserve' THEN sm.quantity_change ELSE 0 END), 0)
                )::int
              FROM stock_movements sm
              WHERE (sm.type = 'reserve' OR sm.type = 'unreserve')
                AND sm.meta ? 'order_id'
                AND (sm.meta->>'order_id')::bigint = o.id::bigint
            ), 0)::int AS reserved_qty
          FROM orders o
          LEFT JOIN products p ON o.product_id = p.id
          LEFT JOIN users assembler ON o.assembled_by_user_id = assembler.id
          WHERE 1=1
        `;
        if (marketplace) {
          sqlSimple += ` AND o.marketplace = $${pi++}`;
          paramsSimple.push(marketplace);
        }
        if (status) {
          sqlSimple += ` AND o.status = $${pi++}`;
          paramsSimple.push(status);
        }
        if (productId) {
          sqlSimple += ` AND o.product_id = $${pi++}`;
          paramsSimple.push(productId);
        }
        if (search) {
          sqlSimple += ` AND ( o.order_id ILIKE $${pi} OR o.product_name ILIKE $${pi} OR o.customer_name ILIKE $${pi} )`;
          paramsSimple.push(`%${search}%`);
          pi++;
        }
        if (stockProblem === true) {
          sqlSimple += ` AND o.stock_problem = true`;
        } else if (stockProblem === false) {
          sqlSimple += ` AND o.stock_problem = false`;
        }
        sqlSimple += ' ORDER BY o.created_at DESC, o.in_process_at DESC';
        if (limit) {
          sqlSimple += ` LIMIT $${pi++}`;
          paramsSimple.push(limit);
        }
        if (offset) {
          sqlSimple += ` OFFSET $${pi++}`;
          paramsSimple.push(offset);
        }
        const result = await query(sqlSimple, paramsSimple);
        return result.rows.map(rowToCamel);
      }
      throw err;
    }
  }

  /**
   * Получить заказ по ID (camelCase)
   */
  async findById(id) {
    const result = await query(`
      SELECT 
        o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.offer_id, o.marketplace_sku,
        COALESCE(p.name, pm.matched_product_name, o.product_name) AS product_name,
        o.quantity, o.price, o.status, o.customer_name, o.customer_phone,
        o.delivery_address, o.created_at, o.in_process_at, o.shipment_date, o.updated_at,
        o.stock_problem, o.stock_problem_detected_at, o.stock_problem_details,
        o.returned_to_new_at,
        o.assembled_at, o.assembled_by_user_id,
        assembler.email AS assembled_by_email,
        assembler.full_name AS assembled_by_full_name,
        COALESCE(p.sku, pm.matched_product_sku) AS product_sku,
        EXISTS(
          SELECT 1 FROM stock_movements sm
          WHERE sm.type = 'reserve'
            AND sm.quantity_change < 0
            AND sm.meta ? 'order_id'
            AND (sm.meta->>'order_id')::bigint = o.id::bigint
          LIMIT 1
        ) AS has_reserve
      FROM orders o
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN users assembler ON o.assembled_by_user_id = assembler.id
      LEFT JOIN LATERAL (
        SELECT p2.name AS matched_product_name, p2.sku AS matched_product_sku, p2.id AS matched_product_id
        FROM product_skus ps JOIN products p2 ON p2.id = ps.product_id
        WHERE ps.marketplace = o.marketplace
          AND ( (o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(o.offer_id))
                OR (o.marketplace_sku IS NOT NULL AND TRIM(ps.sku) = TRIM(CAST(o.marketplace_sku AS TEXT)))
                OR (o.marketplace = 'ozon' AND o.marketplace_sku IS NOT NULL AND ps.marketplace_product_id IS NOT NULL
                    AND ps.marketplace_product_id = o.marketplace_sku::bigint)
                OR (o.marketplace = 'wb' AND o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.offer_id::text, '^.*?([0-9]+)$', '\\1')))
                OR (o.marketplace = 'wb' AND o.product_name IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.product_name::text, '^.*?([0-9]+)$', '\\1'))) )
        LIMIT 1
      ) pm ON true
      WHERE o.id = $1
    `, [id]);
    return rowToCamel(result.rows[0]) || null;
  }

  /**
   * Получить заказ по marketplace и order_id (camelCase)
   * Яндекс.Маркет: в БД order_id часто «число:offerId», order_group_id = числовой id заказа МП —
   * ищем также по группе и по базовому id (как getLocalOrderByMarketplaceAndOrderId в sync).
   */
  async findByMarketplaceAndOrderId(marketplace, orderId) {
    const dbMarketplace = normalizeMarketplaceForDb(marketplace);
    const oid = String(orderId ?? '').trim();

    const selectFull = `
      SELECT 
        o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.offer_id, o.marketplace_sku,
        COALESCE(p.name, pm.matched_product_name, o.product_name) AS product_name,
        o.quantity, o.price, o.status, o.customer_name, o.customer_phone,
        o.delivery_address, o.created_at, o.in_process_at, o.shipment_date, o.updated_at,
        o.stock_problem, o.stock_problem_detected_at, o.stock_problem_details,
        o.returned_to_new_at,
        o.assembled_at, o.assembled_by_user_id,
        assembler.email AS assembled_by_email,
        assembler.full_name AS assembled_by_full_name,
        COALESCE(p.sku, pm.matched_product_sku) AS product_sku,
        EXISTS(
          SELECT 1 FROM stock_movements sm
          WHERE sm.type = 'reserve'
            AND sm.quantity_change < 0
            AND sm.meta ? 'order_id'
            AND (sm.meta->>'order_id')::bigint = o.id::bigint
          LIMIT 1
        ) AS has_reserve
      FROM orders o
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN users assembler ON o.assembled_by_user_id = assembler.id
      LEFT JOIN LATERAL (
        SELECT p2.name AS matched_product_name, p2.sku AS matched_product_sku, p2.id AS matched_product_id
        FROM product_skus ps JOIN products p2 ON p2.id = ps.product_id
        WHERE ps.marketplace = o.marketplace
          AND ( (o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(o.offer_id))
                OR (o.marketplace_sku IS NOT NULL AND TRIM(ps.sku) = TRIM(CAST(o.marketplace_sku AS TEXT)))
                OR (o.marketplace = 'ozon' AND o.marketplace_sku IS NOT NULL AND ps.marketplace_product_id IS NOT NULL
                    AND ps.marketplace_product_id = o.marketplace_sku::bigint)
                OR (o.marketplace = 'wb' AND o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.offer_id::text, '^.*?([0-9]+)$', '\\1')))
                OR (o.marketplace = 'wb' AND o.product_name IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.product_name::text, '^.*?([0-9]+)$', '\\1'))) )
        LIMIT 1
      ) pm ON true
      WHERE o.marketplace = $1 AND o.order_id = $2`;

    const byExact = async (mp, idStr) => {
      const result = await query(selectFull, [mp, idStr]);
      return result.rows[0] ? rowToCamel(result.rows[0]) : null;
    };

    let row = await byExact(dbMarketplace, oid);
    if (row) return row;

    if (dbMarketplace === 'ym') {
      const colon = oid.indexOf(':');
      const base = colon >= 0 ? oid.slice(0, colon) : oid;
      if (base && base !== oid) {
        row = await byExact('ym', base);
        if (row) return row;
      }
      const rGroup = await query(
        `SELECT id FROM orders WHERE marketplace = 'ym' AND order_group_id = $1 ORDER BY id ASC LIMIT 1`,
        [base]
      );
      if (rGroup.rows[0]?.id) return await this.findById(rGroup.rows[0].id);
      const rLike = await query(
        `SELECT id FROM orders WHERE marketplace = 'ym' AND order_id LIKE $1 ORDER BY id ASC LIMIT 1`,
        [`${base}:%`]
      );
      if (rLike.rows[0]?.id) return await this.findById(rLike.rows[0].id);
    }

    return null;
  }

  /** Подготовка одного заказа к upsert (те же поля, что в upsertFromSync) */
  _orderToUpsertParams(order) {
    const marketplace = normalizeMarketplaceForDb(order.marketplace);
    const orderId = String(order.orderId || order.order_id || '');
    const orderGroupId = order.orderGroupId ?? order.order_group_id ?? null;
    const quantity = parseInt(order.quantity, 10) || 1;
    const price = parseFloat(order.price) || 0;
    let marketplaceSku = null;
    if (order.sku != null) {
      const parsed = parseInt(order.sku, 10);
      if (!Number.isNaN(parsed)) marketplaceSku = parsed;
    }
    const createdAt = toValidDate(order.createdAt);
    const inProcessAt = toValidDate(order.inProcessAt);
    const shipmentDate = toValidDate(order.shipmentDate);
    const returnedToNewAt = toValidDate(order.returnedToNewAt ?? order.returned_to_new_at);
    return [
      marketplace,
      orderId,
      orderGroupId ? String(orderGroupId) : null,
      null,
      order.offerId ?? order.offer_id ?? null,
      marketplaceSku,
      order.productName ?? order.product_name ?? null,
      quantity,
      price,
      order.status ?? null,
      order.customerName ?? order.customer_name ?? null,
      order.customerPhone ?? order.customer_phone ?? null,
      order.deliveryAddress ?? order.delivery_address ?? null,
      createdAt,
      inProcessAt,
      shipmentDate,
      returnedToNewAt
    ];
  }

  /**
   * Upsert заказа из синхронизации (формат sync: camelCase, marketplace ozon/wildberries/yandex).
   * В БД сохраняем marketplace как ozon/wb/ym.
   */
  async upsertFromSync(order) {
    const params = this._orderToUpsertParams(order);
    const result = await query(`
      INSERT INTO orders (
        marketplace, order_id, order_group_id, product_id, offer_id, marketplace_sku,
        product_name, quantity, price, status, customer_name,
        customer_phone, delivery_address, created_at, in_process_at, shipment_date, returned_to_new_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (marketplace, order_id) DO UPDATE SET
        order_group_id = CASE
          WHEN orders.order_group_id LIKE '%|split|%' THEN orders.order_group_id
          ELSE COALESCE(EXCLUDED.order_group_id, orders.order_group_id)
        END,
        offer_id = EXCLUDED.offer_id,
        marketplace_sku = EXCLUDED.marketplace_sku,
        product_name = EXCLUDED.product_name,
        quantity = EXCLUDED.quantity,
        price = EXCLUDED.price,
        status = CASE
          WHEN orders.status = 'in_procurement' THEN orders.status
          WHEN orders.status = 'assembled' AND EXCLUDED.status IN (
            'new', 'in_assembly', 'unknown', 'wb_assembly', 'wb_status_unknown', '__wb_status_pending__'
          ) THEN orders.status
          WHEN orders.status = 'in_assembly' AND EXCLUDED.status IN (
            'new', 'unknown', 'wb_assembly', 'wb_status_unknown', '__wb_status_pending__'
          ) THEN orders.status
          WHEN orders.status = 'in_assembly' AND EXCLUDED.status = 'assembled' THEN orders.status
          ELSE EXCLUDED.status
        END,
        customer_name = EXCLUDED.customer_name,
        customer_phone = EXCLUDED.customer_phone,
        delivery_address = EXCLUDED.delivery_address,
        created_at = COALESCE(EXCLUDED.created_at, orders.created_at),
        in_process_at = COALESCE(EXCLUDED.in_process_at, orders.in_process_at),
        shipment_date = COALESCE(EXCLUDED.shipment_date, orders.shipment_date),
        returned_to_new_at = COALESCE(EXCLUDED.returned_to_new_at, orders.returned_to_new_at),
        assembled_at = orders.assembled_at,
        assembled_by_user_id = orders.assembled_by_user_id,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, params);
    return rowToCamel(result.rows[0]);
  }

  /**
   * Пакетный upsert заказов из синхронизации (меньше запросов к БД и записей в лог).
   * Разбивает на чанки по 100 строк.
   */
  async upsertFromSyncBatch(orders) {
    if (!orders || orders.length === 0) return;
    const BATCH = 100;
    const cols = `marketplace, order_id, order_group_id, product_id, offer_id, marketplace_sku,
        product_name, quantity, price, status, customer_name,
        customer_phone, delivery_address, created_at, in_process_at, shipment_date, returned_to_new_at`;
    const setClause = `
        order_group_id = CASE
          WHEN orders.order_group_id LIKE '%|split|%' THEN orders.order_group_id
          ELSE COALESCE(EXCLUDED.order_group_id, orders.order_group_id)
        END,
        offer_id = EXCLUDED.offer_id,
        marketplace_sku = EXCLUDED.marketplace_sku,
        product_name = EXCLUDED.product_name,
        quantity = EXCLUDED.quantity,
        price = EXCLUDED.price,
        status = CASE
          WHEN orders.status = 'in_procurement' THEN orders.status
          WHEN orders.status = 'assembled' AND EXCLUDED.status IN (
            'new', 'in_assembly', 'unknown', 'wb_assembly', 'wb_status_unknown', '__wb_status_pending__'
          ) THEN orders.status
          WHEN orders.status = 'in_assembly' AND EXCLUDED.status IN (
            'new', 'unknown', 'wb_assembly', 'wb_status_unknown', '__wb_status_pending__'
          ) THEN orders.status
          WHEN orders.status = 'in_assembly' AND EXCLUDED.status = 'assembled' THEN orders.status
          ELSE EXCLUDED.status
        END,
        customer_name = EXCLUDED.customer_name,
        customer_phone = EXCLUDED.customer_phone,
        delivery_address = EXCLUDED.delivery_address,
        created_at = COALESCE(EXCLUDED.created_at, orders.created_at),
        in_process_at = COALESCE(EXCLUDED.in_process_at, orders.in_process_at),
        shipment_date = COALESCE(EXCLUDED.shipment_date, orders.shipment_date),
        returned_to_new_at = COALESCE(EXCLUDED.returned_to_new_at, orders.returned_to_new_at),
        assembled_at = orders.assembled_at,
        assembled_by_user_id = orders.assembled_by_user_id,
        updated_at = CURRENT_TIMESTAMP`;
    for (let i = 0; i < orders.length; i += BATCH) {
      const chunk = orders.slice(i, i + BATCH);
      const params = [];
      const placeholders = [];
      chunk.forEach((order, idx) => {
        const p = this._orderToUpsertParams(order);
        params.push(...p);
        const base = idx * 17 + 1;
        placeholders.push(
          `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16})`
        );
      });
      await query(`
        INSERT INTO orders (${cols})
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (marketplace, order_id) DO UPDATE SET ${setClause}
      `, params);
    }
  }

  /**
   * Найти заказ по order_id (posting number) в любом маркетплейсе — для этикеток и API по :orderId.
   */
  async findAnyByOrderId(orderId) {
    const id = String(orderId ?? '').trim();
    if (!id) return null;
    const result = await query(
      `
      SELECT o.* FROM orders o
      WHERE o.order_id = $1
         OR o.order_group_id = $1
         OR o.order_id LIKE ($1 || '~%')
      ORDER BY CASE
        WHEN o.order_id = $1 THEN 0
        WHEN o.order_group_id = $1 THEN 1
        ELSE 2
      END
      LIMIT 1
    `,
      [id]
    );
    return rowToCamel(result.rows[0]) || null;
  }

  /**
   * Создать заказ
   */
  async create(orderData) {
    const result = await query(`
      INSERT INTO orders (
        marketplace, order_id, order_group_id, product_id, offer_id, marketplace_sku,
        product_name, quantity, price, status, customer_name,
        customer_phone, delivery_address, created_at, in_process_at, shipment_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
    `, [
      orderData.marketplace,
      orderData.order_id,
      orderData.order_group_id || null,
      orderData.product_id || null,
      orderData.offer_id || null,
      orderData.marketplace_sku || null,
      orderData.product_name || null,
      orderData.quantity || 1,
      orderData.price || 0,
      orderData.status || null,
      orderData.customer_name || null,
      orderData.customer_phone || null,
      orderData.delivery_address || null,
      orderData.created_at || new Date(),
      orderData.in_process_at || null,
      orderData.shipment_date || null
    ]);
    
    return rowToCamel(result.rows[0]);
  }

  /**
   * Найти все заказы по order_group_id (для группового ручного заказа)
   */
  async findByOrderGroupId(orderGroupId) {
    if (!orderGroupId) return [];
    const result = await query(`
      SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.offer_id, o.marketplace_sku,
        COALESCE(p.name, o.product_name) AS product_name,
        o.quantity, o.price, o.status, o.customer_name, o.customer_phone,
        o.delivery_address, o.created_at, o.in_process_at, o.shipment_date, o.updated_at,
        o.returned_to_new_at,
        o.assembled_at, o.assembled_by_user_id,
        assembler.email AS assembled_by_email,
        assembler.full_name AS assembled_by_full_name
      FROM orders o
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN users assembler ON o.assembled_by_user_id = assembler.id
      WHERE o.order_group_id = $1
      ORDER BY o.id
    `, [String(orderGroupId)]);
    return result.rows.map(rowToCamel);
  }

  /**
   * Обновить статус всех заказов в группе
   */
  async updateStatusByOrderGroupId(orderGroupId, status) {
    if (!orderGroupId) return 0;
    const clearAssembly = ['new', 'in_assembly', 'in_procurement'].includes(status);
    const result = await query(
      `
      UPDATE orders SET
        status = $1::text,
        returned_to_new_at = CASE WHEN $1::text = 'new' THEN CURRENT_TIMESTAMP ELSE NULL END,
        assembled_at = CASE WHEN $3 THEN NULL ELSE assembled_at END,
        assembled_by_user_id = CASE WHEN $3 THEN NULL ELSE assembled_by_user_id END,
        updated_at = CURRENT_TIMESTAMP
      WHERE order_group_id = $2::text
      RETURNING id
    `,
      [status, String(orderGroupId), clearAssembly]
    );
    return result.rowCount || 0;
  }

  /**
   * Отметить все строки группы как собранные (дата/время и пользователь сборки).
   */
  async markAssembledByOrderGroupId(orderGroupId, assembledByUserId) {
    if (!orderGroupId) return;
    const uid = assembledByUserId != null && Number(assembledByUserId) > 0 ? Number(assembledByUserId) : null;
    await query(
      `
      UPDATE orders SET
        status = 'assembled',
        returned_to_new_at = NULL,
        assembled_at = CURRENT_TIMESTAMP,
        assembled_by_user_id = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE order_group_id = $1
    `,
      [String(orderGroupId), uid]
    );
  }

  /**
   * Одна строка заказа — собрана.
   */
  async markAssembledByMarketplaceAndOrderId(marketplace, orderId, assembledByUserId) {
    const dbM = normalizeMarketplaceForDb(marketplace);
    const uid = assembledByUserId != null && Number(assembledByUserId) > 0 ? Number(assembledByUserId) : null;
    await query(
      `
      UPDATE orders SET
        status = 'assembled',
        returned_to_new_at = NULL,
        assembled_at = CURRENT_TIMESTAMP,
        assembled_by_user_id = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE marketplace = $1 AND order_id = $2
    `,
      [dbM, String(orderId), uid]
    );
  }
  
  /**
   * Обновить заказ
   */
  async update(id, updates) {
    const updateFields = [];
    const params = [];
    let paramIndex = 1;
    
    const allowedFields = [
      'product_id', 'offer_id', 'marketplace_sku', 'product_name',
      'quantity', 'price', 'status', 'customer_name', 'customer_phone',
      'delivery_address', 'in_process_at', 'shipment_date'
    ];
    
    for (const field of allowedFields) {
      if (updates.hasOwnProperty(field)) {
        updateFields.push(`${field} = $${paramIndex++}`);
        params.push(updates[field]);
      }
    }
    
    if (updateFields.length === 0) {
      return await this.findById(id);
    }
    
    params.push(id);
    const result = await query(`
      UPDATE orders 
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramIndex}
      RETURNING *
    `, params);
    
    return result.rows[0] || null;
  }
  
  /**
   * Обновить заказ по marketplace и order_id.
   * marketplace принимается в формате API (wildberries, yandex), в БД хранится wb, ym — нормализуем.
   */
  async updateByMarketplaceAndOrderId(marketplace, orderId, updates) {
    const updateFields = [];
    const params = [];
    let paramIndex = 1;
    
    const allowedFields = [
      'product_id', 'offer_id', 'marketplace_sku', 'product_name',
      'quantity', 'price', 'status', 'customer_name', 'customer_phone',
      'delivery_address', 'in_process_at', 'shipment_date', 'returned_to_new_at'
    ];
    
    for (const field of allowedFields) {
      if (updates.hasOwnProperty(field)) {
        updateFields.push(`${field} = $${paramIndex++}`);
        params.push(updates[field]);
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'status') && !Object.prototype.hasOwnProperty.call(updates, 'returned_to_new_at')) {
      if (updates.status === 'new') {
        updateFields.push('returned_to_new_at = CURRENT_TIMESTAMP');
      } else {
        updateFields.push('returned_to_new_at = NULL');
      }
    }

    const st = updates.status;
    if (st != null && ['new', 'in_assembly', 'in_procurement'].includes(st)) {
      updateFields.push(`assembled_at = $${paramIndex++}`);
      params.push(null);
      updateFields.push(`assembled_by_user_id = $${paramIndex++}`);
      params.push(null);
    }
    
    if (updateFields.length === 0) {
      return await this.findByMarketplaceAndOrderId(marketplace, orderId);
    }
    
    const dbMarketplace = normalizeMarketplaceForDb(marketplace);
    params.push(dbMarketplace, orderId);
    const result = await query(`
      UPDATE orders 
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE marketplace = $${paramIndex++} AND order_id = $${paramIndex}
      RETURNING *
    `, params);
    
    return result.rows[0] || null;
  }
  
  /**
   * Удалить заказ по id
   */
  async delete(id) {
    const result = await query('DELETE FROM orders WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }

  /**
   * Удалить заказ по marketplace и order_id (одна строка).
   */
  async deleteByMarketplaceAndOrderId(marketplace, orderId) {
    const dbMarketplace = normalizeMarketplaceForDb(marketplace);
    const result = await query(
      'DELETE FROM orders WHERE marketplace = $1 AND order_id = $2 RETURNING id',
      [dbMarketplace, String(orderId)]
    );
    return result.rowCount > 0;
  }

  /**
   * Удалить все заказы группы (по order_group_id).
   */
  async deleteByOrderGroupId(orderGroupId) {
    if (!orderGroupId) return 0;
    const result = await query(
      'DELETE FROM orders WHERE order_group_id = $1 RETURNING id',
      [String(orderGroupId)]
    );
    return result.rowCount || 0;
  }
  
  /**
   * Найти первый заказ на сборке (in_assembly), содержащий товар с данным productId.
   * Учитывает как прямую связь (orders.product_id), так и совпадение по product_skus
   * (offer_id, marketplace_sku, для WB — nmId из product_name/offer_id).
   * Нужно для сборки по штрихкоду: заказы WB часто без product_id, но товар совпадает по nmId.
   */
  async findFirstAssembledByProductIdOrSku(productId) {
    if (productId == null) return null;
    const pid = Number(productId);
    if (Number.isNaN(pid)) return null;
    const sql = `
      SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.offer_id, o.marketplace_sku,
        COALESCE(p.name, pm.matched_product_name, o.product_name) AS product_name,
        o.quantity, o.price, o.status, o.customer_name, o.customer_phone,
        o.delivery_address, o.created_at, o.in_process_at, o.shipment_date, o.updated_at,
        o.assembled_at, o.assembled_by_user_id,
        assembler.email AS assembled_by_email,
        assembler.full_name AS assembled_by_full_name,
        COALESCE(p.sku, pm.matched_product_sku) AS product_sku
      FROM orders o
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN users assembler ON o.assembled_by_user_id = assembler.id
      LEFT JOIN LATERAL (
        SELECT p2.name AS matched_product_name, p2.sku AS matched_product_sku, p2.id AS matched_product_id
        FROM product_skus ps
        JOIN products p2 ON p2.id = ps.product_id
        WHERE ps.marketplace = o.marketplace
          AND ( (o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(o.offer_id))
                OR (o.marketplace_sku IS NOT NULL AND TRIM(ps.sku) = TRIM(CAST(o.marketplace_sku AS TEXT)))
                OR (o.marketplace = 'ozon' AND o.marketplace_sku IS NOT NULL AND ps.marketplace_product_id IS NOT NULL
                    AND ps.marketplace_product_id = o.marketplace_sku::bigint)
                OR (o.marketplace = 'wb' AND o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.offer_id::text, '^.*?([0-9]+)$', '\\1')))
                OR (o.marketplace = 'wb' AND o.product_name IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.product_name::text, '^.*?([0-9]+)$', '\\1'))) )
        LIMIT 1
      ) pm ON true
      WHERE o.status = 'in_assembly'
        AND (
          o.product_id = $1
          OR EXISTS (
            SELECT 1 FROM product_skus ps
            WHERE ps.product_id = $1
              AND ps.marketplace = o.marketplace
              AND (
                (o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(o.offer_id))
                OR (o.marketplace_sku IS NOT NULL AND TRIM(ps.sku) = TRIM(CAST(o.marketplace_sku AS TEXT)))
                OR (o.marketplace = 'ozon' AND o.marketplace_sku IS NOT NULL AND ps.marketplace_product_id IS NOT NULL
                    AND ps.marketplace_product_id = o.marketplace_sku::bigint)
                OR (o.marketplace = 'wb' AND o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.offer_id::text, '^.*?([0-9]+)$', '\\1')))
                OR (o.marketplace = 'wb' AND o.product_name IS NOT NULL AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.product_name::text, '^.*?([0-9]+)$', '\\1')))
              )
          )
          OR EXISTS (
            SELECT 1 FROM products pmain
            WHERE pmain.id = $1
              AND (
                (o.offer_id IS NOT NULL AND TRIM(o.offer_id) = TRIM(COALESCE(pmain.sku, '')))
                OR (o.marketplace_sku IS NOT NULL AND TRIM(CAST(o.marketplace_sku AS TEXT)) = TRIM(COALESCE(pmain.sku, '')))
                OR (o.marketplace = 'ozon' AND o.marketplace_sku IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM product_skus x
                    WHERE x.product_id = pmain.id AND x.marketplace = 'ozon'
                      AND x.marketplace_product_id IS NOT NULL
                      AND x.marketplace_product_id = o.marketplace_sku::bigint
                  ))
                OR (o.marketplace = 'wb' AND o.offer_id IS NOT NULL
                  AND TRIM(COALESCE(pmain.sku, '')) = TRIM(REGEXP_REPLACE(o.offer_id::text, '^.*?([0-9]+)$', '\\1')))
                OR (o.marketplace = 'wb' AND o.product_name IS NOT NULL
                  AND TRIM(COALESCE(pmain.sku, '')) = TRIM(REGEXP_REPLACE(o.product_name::text, '^.*?([0-9]+)$', '\\1')))
              )
          )
          OR EXISTS (
            SELECT 1 FROM product_skus psku
            WHERE psku.product_id = $1
              AND (
                (o.offer_id IS NOT NULL AND TRIM(o.offer_id) = TRIM(psku.sku))
                OR (o.marketplace_sku IS NOT NULL AND TRIM(CAST(o.marketplace_sku AS TEXT)) = TRIM(psku.sku))
                OR (o.marketplace = 'ozon' AND o.marketplace_sku IS NOT NULL
                  AND psku.marketplace = 'ozon'
                  AND psku.marketplace_product_id IS NOT NULL
                  AND psku.marketplace_product_id = o.marketplace_sku::bigint)
                OR (o.marketplace = 'wb' AND o.offer_id IS NOT NULL AND psku.marketplace = 'wb'
                  AND TRIM(psku.sku) = TRIM(REGEXP_REPLACE(o.offer_id::text, '^.*?([0-9]+)$', '\\1')))
                OR (o.marketplace = 'wb' AND o.product_name IS NOT NULL AND psku.marketplace = 'wb'
                  AND TRIM(psku.sku) = TRIM(REGEXP_REPLACE(o.product_name::text, '^.*?([0-9]+)$', '\\1')))
              )
          )
        )
      ORDER BY o.created_at DESC, o.in_process_at DESC
      LIMIT 1
    `;
    const result = await query(sql, [pid]);
    return result.rows[0] ? rowToCamel(result.rows[0]) : null;
  }

  /**
   * Подсчитать общее количество заказов
   */
  async count(options = {}) {
    let sql = 'SELECT COUNT(*) as total FROM orders WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (options.marketplace) {
      sql += ` AND marketplace = $${paramIndex++}`;
      params.push(options.marketplace);
    }
    
    if (options.status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(options.status);
    }
    
    if (options.productId) {
      sql += ` AND product_id = $${paramIndex++}`;
      params.push(options.productId);
    }
    
    if (options.search) {
      sql += ` AND (
        order_id ILIKE $${paramIndex} OR 
        product_name ILIKE $${paramIndex} OR
        customer_name ILIKE $${paramIndex}
      )`;
      params.push(`%${options.search}%`);
    }
    
    const result = await query(sql, params);
    return parseInt(result.rows[0].total);
  }
  
  /**
   * Получить статистику по заказам
   */
  async getStatistics(options = {}) {
    let sql = `
      SELECT 
        marketplace,
        status,
        COUNT(*) as count,
        SUM(quantity) as total_quantity,
        SUM(price * quantity) as total_amount
      FROM orders
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (options.marketplace) {
      sql += ` AND marketplace = $${paramIndex++}`;
      params.push(options.marketplace);
    }
    
    sql += ` GROUP BY marketplace, status ORDER BY marketplace, status`;
    
    const result = await query(sql, params);
    return result.rows;
  }
}

export default new OrdersRepositoryPG();

