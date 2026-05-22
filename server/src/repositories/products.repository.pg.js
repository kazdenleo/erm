/**
 * Products Repository (PostgreSQL)
 * Репозиторий для работы с товарами в PostgreSQL
 */

import { query, transaction } from '../config/database.js';

/** Единый ключ id товара для Map kit_components (PostgreSQL int8 в node-pg часто приходит строкой). */
function productIdMapKey(rawId) {
  if (rawId == null || rawId === '') return null;
  const n = typeof rawId === 'string' ? parseInt(String(rawId).trim(), 10) : Number(rawId);
  if (Number.isFinite(n) && n > 0) return String(n);
  const s = String(rawId).trim();
  return s === '' ? null : s;
}

function isKitProductType(raw) {
  return String(raw || '').toLowerCase() === 'kit';
}

/** Поля для listView=stock — без images, mp_* текстов и прочих тяжёлых колонок. */
const STOCK_LIST_SELECT = `
  p.id,
  p.sku,
  p.name,
  p.product_type,
  p.quantity,
  p.incoming_quantity,
  p.reserved_quantity,
  p.cost,
  p.brand_id,
  p.user_category_id,
  p.organization_id,
  p.profile_id,
  p.is_archived,
  p.created_at,
  p.updated_at,
  b.name AS brand_name,
  uc.name AS category_name,
  o.name AS organization_name,
  NULL AS category_marketplace
`;

/**
 * Сохраняет одну связку product_skus (Ozon допускает только marketplace_product_id; WB/ЯМ — непустой sku).
 */
async function upsertProductSkuRow(client, { productId, marketplace, skuRaw, marketplaceProductId }) {
  const mp = String(marketplace || '').toLowerCase();
  const sku =
    skuRaw != null && String(skuRaw).trim() !== '' ? String(skuRaw).trim() : null;
  let mpid =
    marketplaceProductId != null && marketplaceProductId !== ''
      ? Number(marketplaceProductId)
      : null;
  if (mpid != null && !Number.isFinite(mpid)) mpid = null;
  const mpidArg = mp === 'ozon' ? mpid : null;

  if (mp === 'ozon') {
    if (!sku && mpidArg == null) return;
  } else if (mp === 'wb' || mp === 'ym') {
    if (!sku) return;
  } else {
    return;
  }

  try {
    await client.query(
      `INSERT INTO product_skus (product_id, marketplace, sku, marketplace_product_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id, marketplace)
       DO UPDATE SET sku = EXCLUDED.sku, marketplace_product_id = EXCLUDED.marketplace_product_id`,
      [productId, mp, sku, mpidArg]
    );
  } catch (skusErr) {
    if (
      skusErr.message &&
      (skusErr.message.includes('marketplace_product_id') || skusErr.message.includes('does not exist'))
    ) {
      await client.query(
        `INSERT INTO product_skus (product_id, marketplace, sku)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, marketplace) DO UPDATE SET sku = EXCLUDED.sku`,
        [productId, mp, sku]
      );
    } else {
      throw skusErr;
    }
  }
}

/**
 * Частичное обновление product_skus: только ключи, присутствующие в mus (ozon/wb/ym).
 * Пустое значение — удалить строку для этого маркетплейса.
 */
async function applyMarketplaceSkusPatch(client, productId, mus, { ozonProductId = undefined } = {}) {
  if (!mus || typeof mus !== 'object') return;
  const numId = Number(productId);
  if (!Number.isFinite(numId) || numId < 1) return;

  const patchMp = async (mp, skuRaw, marketplaceProductId) => {
    const empty = skuRaw == null || String(skuRaw).trim() === '';
    if (mp === 'ozon' && empty && marketplaceProductId == null) {
      await client.query(`DELETE FROM product_skus WHERE product_id = $1 AND marketplace = $2`, [numId, mp]);
      return;
    }
    if ((mp === 'wb' || mp === 'ym') && empty) {
      await client.query(`DELETE FROM product_skus WHERE product_id = $1 AND marketplace = $2`, [numId, mp]);
      return;
    }
    await upsertProductSkuRow(client, {
      productId: numId,
      marketplace: mp,
      skuRaw,
      marketplaceProductId: mp === 'ozon' ? marketplaceProductId : null,
    });
  };

  if (Object.prototype.hasOwnProperty.call(mus, 'ozon')) {
    let ozonPid = null;
    if (ozonProductId !== undefined) {
      ozonPid =
        ozonProductId != null && ozonProductId !== '' && Number.isFinite(Number(ozonProductId))
          ? Number(ozonProductId)
          : null;
    } else {
      const cur = await client.query(
        `SELECT marketplace_product_id FROM product_skus WHERE product_id = $1 AND marketplace = 'ozon'`,
        [numId]
      );
      ozonPid = cur.rows[0]?.marketplace_product_id ?? null;
    }
    await patchMp('ozon', mus.ozon, ozonPid);
  }
  if (Object.prototype.hasOwnProperty.call(mus, 'wb')) {
    await patchMp('wb', mus.wb, null);
  }
  if (Object.prototype.hasOwnProperty.call(mus, 'ym')) {
    await patchMp('ym', mus.ym, null);
  }
}

/** Значение фильтра «без ERP-категории» с фронта; в SQL только IS NULL, не подставляем в bigint. */
const FILTER_CATEGORY_NONE = '__no_category__';

/**
 * Нормализация categoryId из query (Express может отдать строку или массив дублей).
 */
function normalizeListCategoryId(categoryId) {
  if (categoryId == null) return '';
  const first = Array.isArray(categoryId) ? categoryId[0] : categoryId;
  let s = String(first ?? '').trim().replace(/^\uFEFF/, '');
  if (s === '' || s === 'undefined' || s === 'null') return '';
  if (s === FILTER_CATEGORY_NONE) return FILTER_CATEGORY_NONE;
  const lower = s.toLowerCase();
  if (lower === FILTER_CATEGORY_NONE) return FILTER_CATEGORY_NONE;
  return s;
}

/**
 * Наличие для фильтра «только в наличии» — только колонка «Наличие» в таблице остатков
 * (склад / целые комплекты 1 SKU), без «в пути» и без остатков поставщиков.
 */
export function stockListOnHandQuantity(product) {
  if (!product) return 0;

  const kit = product.kit_display ?? product.kitDisplay;
  if (kit && typeof kit === 'object') {
    return Math.max(0, Number(kit.whole_on_hand ?? kit.wholeOnHand) || 0);
  }

  return Math.max(0, Number(product.quantity) || 0);
}

function buildFindAllFilters(options = {}) {
  const {
    brandId,
    categoryId,
    organizationId,
    search,
    profileId,
    productType,
    includeArchived,
    archivedOnly,
    inStockOnly,
    warehouseId
  } = options;
  let whereSql = ' WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (archivedOnly === true || archivedOnly === 'true' || archivedOnly === '1') {
    whereSql += ` AND COALESCE(p.is_archived, false) = true`;
  } else if (!(includeArchived === true || includeArchived === 'true' || includeArchived === '1')) {
    whereSql += ` AND COALESCE(p.is_archived, false) = false`;
  }

  if (profileId != null && profileId !== '') {
    whereSql += ` AND p.profile_id = $${paramIndex++}`;
    params.push(profileId);
  }

  if (brandId) {
    const bRaw = String(brandId).trim();
    if (/^\d+$/.test(bRaw)) {
      whereSql += ` AND p.brand_id = $${paramIndex++}`;
      params.push(bRaw);
    }
  }

  const categoryIdRaw = normalizeListCategoryId(categoryId);
  if (categoryIdRaw === FILTER_CATEGORY_NONE) {
    whereSql += ` AND p.user_category_id IS NULL`;
  } else if (categoryIdRaw && /^\d+$/.test(categoryIdRaw)) {
    whereSql += ` AND p.user_category_id = $${paramIndex++}`;
    params.push(categoryIdRaw);
  }

  if (organizationId != null && organizationId !== '') {
    const orgNum = typeof organizationId === 'string' ? parseInt(organizationId, 10) : Number(organizationId);
    const orgVal = Number.isFinite(orgNum) ? orgNum : organizationId;
    const profNum =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : NaN;
    const useProfileScope = Number.isFinite(profNum);
    if (useProfileScope) {
      whereSql += ` AND (
        p.organization_id = $${paramIndex}
        OR (
          p.organization_id IS NULL
          AND EXISTS (
            SELECT 1 FROM organizations o_filt
            WHERE o_filt.id = $${paramIndex + 1}
              AND o_filt.profile_id IS NOT NULL
              AND o_filt.profile_id = $${paramIndex + 2}
          )
        )
      )`;
      params.push(orgVal, orgVal, profNum);
      paramIndex += 3;
    } else {
      whereSql += ` AND p.organization_id = $${paramIndex++}`;
      params.push(orgVal);
    }
  }

  if (search) {
    const searchParam = `%${search}%`;
    whereSql += ` AND (
      p.name ILIKE $${paramIndex}
      OR p.sku ILIKE $${paramIndex}
      OR EXISTS (
        SELECT 1 FROM barcodes bc
        WHERE bc.product_id = p.id AND bc.barcode ILIKE $${paramIndex}
      )
      OR EXISTS (
        SELECT 1 FROM product_skus ps
        WHERE ps.product_id = p.id AND COALESCE(TRIM(ps.sku::text), '') ILIKE $${paramIndex}
      )
    )`;
    params.push(searchParam);
    paramIndex++;
  }

  const pt = productType != null && String(productType).trim() !== '' ? String(productType).trim().toLowerCase() : '';
  if (pt === 'kit') {
    whereSql += ` AND LOWER(TRIM(COALESCE(p.product_type::text, ''))) = 'kit'`;
  } else if (pt === 'product') {
    whereSql += ` AND (p.product_type IS NULL OR LOWER(TRIM(COALESCE(p.product_type::text, ''))) <> 'kit')`;
  }

  const onlyInStock =
    inStockOnly === true || inStockOnly === 'true' || inStockOnly === '1' || inStockOnly === 1;
  if (onlyInStock) {
    const whRaw = warehouseId != null && String(warehouseId).trim() !== '' ? warehouseId : null;
    const wid =
      whRaw != null
        ? typeof whRaw === 'string'
          ? parseInt(whRaw, 10)
          : Number(whRaw)
        : NaN;
    if (Number.isFinite(wid) && wid > 0) {
      whereSql += ` AND EXISTS (
        SELECT 1 FROM product_warehouse_stock pws
        WHERE pws.product_id = p.id
          AND pws.warehouse_id = $${paramIndex++}
          AND COALESCE(pws.quantity, 0) > 0
      )`;
      params.push(wid);
    } else {
      // «Все склады»: как колонка «Наличие» — сумма pws, legacy quantity без pws, рассинхрон pws=0 но products.quantity>0
      whereSql += ` AND (
        (
          SELECT COALESCE(SUM(COALESCE(pws.quantity, 0)), 0)
          FROM product_warehouse_stock pws
          WHERE pws.product_id = p.id
        ) > 0
        OR (
          NOT EXISTS (
            SELECT 1 FROM product_warehouse_stock pws0 WHERE pws0.product_id = p.id LIMIT 1
          )
          AND COALESCE(p.quantity, 0) > 0
        )
        OR (
          EXISTS (SELECT 1 FROM product_warehouse_stock pws0 WHERE pws0.product_id = p.id LIMIT 1)
          AND (
            SELECT COALESCE(SUM(COALESCE(pws.quantity, 0)), 0)
            FROM product_warehouse_stock pws
            WHERE pws.product_id = p.id
          ) = 0
          AND COALESCE(p.quantity, 0) > 0
        )
        OR EXISTS (
          SELECT 1 FROM kit_components kc
          INNER JOIN product_warehouse_stock pws ON pws.product_id = kc.component_product_id
          WHERE kc.kit_product_id = p.id AND COALESCE(pws.quantity, 0) > 0
        )
      )`;
    }
  }

  return { whereSql, params, paramIndex };
}

class ProductsRepositoryPG {
  /**
   * Рассчитать себестоимость комплекта как сумму (себестоимость комплектующего × количество).
   * @param {object} client - клиент транзакции
   * @param {number} kitProductId - id товара-комплекта
   * @returns {number|null} - сумма или null если нет комплектующих
   */
  async _computeKitCost(client, kitProductId) {
    const id = typeof kitProductId === 'string' ? parseInt(kitProductId, 10) : Number(kitProductId);
    if (!id || isNaN(id)) return null;
    const res = await client.query(
      `SELECT kc.component_product_id, kc.quantity, COALESCE(p.cost, 0)::numeric as cost
       FROM kit_components kc
       JOIN products p ON p.id = kc.component_product_id
       WHERE kc.kit_product_id = $1`,
      [id]
    );
    if (!res.rows || res.rows.length === 0) return null;
    const total = res.rows.reduce((sum, row) => {
      const qty = Math.max(0, parseInt(row.quantity, 10) || 0);
      const cost = parseFloat(row.cost) || 0;
      return sum + cost * qty;
    }, 0);
    return Math.round(total * 100) / 100;
  }

  /**
   * То же что _computeKitCost, но через query() — для вызова вне транзакции (например после updateCostFromSupplierStocks).
   */
  async _computeKitCostWithQuery(kitProductId) {
    const id = typeof kitProductId === 'string' ? parseInt(kitProductId, 10) : Number(kitProductId);
    if (!id || isNaN(id)) return null;
    const res = await query(
      `SELECT kc.component_product_id, kc.quantity, COALESCE(p.cost, 0)::numeric as cost
       FROM kit_components kc
       JOIN products p ON p.id = kc.component_product_id
       WHERE kc.kit_product_id = $1`,
      [id]
    );
    if (!res.rows || res.rows.length === 0) return null;
    const total = res.rows.reduce((sum, row) => {
      const qty = Math.max(0, parseInt(row.quantity, 10) || 0);
      const cost = parseFloat(row.cost) || 0;
      return sum + cost * qty;
    }, 0);
    return Math.round(total * 100) / 100;
  }

  /**
   * Пересчитать себестоимость всех комплектов, в состав которых входит товар productId (вне транзакции).
   */
  async recalcKitsContainingProduct(productId) {
    const numId = typeof productId === 'string' ? parseInt(productId, 10) : productId;
    const kitsRes = await query(
      'SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = $1',
      [numId]
    );
    if (!kitsRes.rows || kitsRes.rows.length === 0) return;
    for (const row of kitsRes.rows) {
      const kitId = row.kit_product_id;
      if (!kitId) continue;
      const kitCost = await this._computeKitCostWithQuery(kitId);
      await query(
        'UPDATE products SET cost = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [kitCost != null ? kitCost : null, kitId]
      );
    }
  }

  /**
   * Остатки комплектов из БД по kit_components (не зависит от фильтра списка).
   */
  async _applyKitDerivedStockFromDb(products, options = {}) {
    if (!Array.isArray(products) || products.length === 0) return;
    const { enrichKitProductStock } = await import('../services/kitStock.service.js');
    const warehouseId = options.warehouseId ?? options.warehouse_id ?? null;
    const { isKitCatalogProduct } = await import('../services/kitStock.service.js');
    const kits = products.filter((p) => isKitCatalogProduct(p));
    await Promise.all(
      kits.map((p) =>
        enrichKitProductStock(p, {
          warehouseId: warehouseId != null && warehouseId !== '' ? warehouseId : null
        })
      )
    );
  }

  /**
   * Агрегат products.reserved_quantity должен совпадать с журналом (типы reserve / unreserve).
   * Иначе после перезагрузки страницы «Остатки» показывают неверный резерв.
   */
  async _reconcileReservedQuantityFromMovements(products, options = {}, kitCtx = null) {
    if (!Array.isArray(products) || products.length === 0) return;
    const numericIds = [
      ...new Set(
        products
          .map((p) => {
            const id = p?.id;
            const n = typeof id === 'string' ? parseInt(id, 10) : Number(id);
            return Number.isFinite(n) && n > 0 ? n : null;
          })
          .filter((x) => x != null)
      )
    ];
    if (numericIds.length === 0) return;

    let agg;
    try {
      const { NET_RESERVED_SUM_EXPR_SQL } = await import('../services/sellableQuantity.service.js');
      agg = await query(
        `SELECT product_id,
          ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
         FROM stock_movements
         WHERE product_id = ANY($1::bigint[])
           AND type IN ('reserve', 'unreserve')
         GROUP BY product_id`,
        [numericIds]
      );
    } catch (e) {
      console.warn('[Products Repository] _reconcileReservedQuantityFromMovements:', e.message);
      return;
    }

    const byPid = new Map();
    for (const r of agg.rows || []) {
      const key = productIdMapKey(r.product_id);
      if (!key) continue;
      byPid.set(key, Number(r.rv) || 0);
    }
    const idsToUpdate = [];
    const rvsToUpdate = [];
    const {
      kitDisplayReservedFromContext,
      buildKitListStockContext,
      readKitDisplayReservedQuantity,
      isKitCatalogProduct
    } = await import('../services/kitStock.service.js');

    let ctx = kitCtx;
    if (!ctx && products.some((p) => isKitCatalogProduct(p))) {
      ctx = await buildKitListStockContext(products, options);
    }

    const { getReservedQuantityFromMovements } = await import('../services/sellableQuantity.service.js');
    const skipKitCatalog = options.skipKitCatalog === true;

    for (const p of products) {
      const key = productIdMapKey(p.id);
      const nid = typeof p.id === 'string' ? parseInt(p.id, 10) : Number(p.id);
      if (skipKitCatalog && isKitCatalogProduct(p)) continue;

      let calc = 0;
      if (isKitCatalogProduct(p)) {
        if (Number.isFinite(nid) && nid > 0) {
          calc = ctx
            ? kitDisplayReservedFromContext(nid, ctx)
            : await readKitDisplayReservedQuantity(nid, options);
        }
      } else if (Number.isFinite(nid) && nid > 0) {
        calc = key && byPid.has(key) ? byPid.get(key) : await getReservedQuantityFromMovements(nid);
      }

      const stored = p.reserved_quantity != null ? Number(p.reserved_quantity) : 0;
      p.reserved_quantity = calc;
      p.net_reserved_quantity = calc;
      p.reservedQuantity = calc;
      p.netReservedQuantity = calc;
      if (stored !== calc && Number.isFinite(nid) && nid > 0) {
        idsToUpdate.push(nid);
        rvsToUpdate.push(calc);
      }
    }

    if (idsToUpdate.length > 0 && options.persistReservedToDb !== false) {
      try {
        await query(
          `UPDATE products AS p
           SET reserved_quantity = u.rv,
               updated_at = CURRENT_TIMESTAMP
           FROM unnest($1::bigint[], $2::int[]) AS u(id, rv)
           WHERE p.id = u.id`,
          [idsToUpdate, rvsToUpdate]
        );
      } catch (e) {
        console.warn('[Products Repository] reserved_quantity sync to DB:', e.message);
      }
    }
  }

  /**
   * ID товаров, сгруппированные по user_category_id (без JOIN/SKU — для UI списка категорий).
   * @param {{ profileId?: number|string|null }} [options]
   * @returns {Promise<Record<string, number[]>>}
   */
  async getProductIdsGroupedByUserCategory(options = {}) {
    const profileId = options.profileId ?? options.profile_id;
    const params = [];
    let where = 'WHERE user_category_id IS NOT NULL';
    if (profileId != null && profileId !== '') {
      where += ` AND profile_id = $${params.length + 1}`;
      params.push(profileId);
    }
    const result = await query(
      `SELECT user_category_id::text AS cid,
              coalesce(json_agg(id ORDER BY id), '[]'::json) AS product_ids
       FROM products
       ${where}
         AND COALESCE(is_archived, false) = false
       GROUP BY user_category_id`
    , params);
    const out = {};
    for (const row of result.rows || []) {
      let ids = row.product_ids;
      if (ids == null) ids = [];
      if (typeof ids === 'string') {
        try {
          ids = JSON.parse(ids);
        } catch {
          ids = [];
        }
      }
      if (!Array.isArray(ids)) ids = [];
      out[String(row.cid)] = ids
        .map((x) => (typeof x === 'string' ? parseInt(x, 10) : Number(x)))
        .filter((n) => Number.isFinite(n));
    }
    return out;
  }

  /**
   * Получить все товары
   */
  async findAll(options = {}) {
    const {
      limit,
      offset,
      brandId,
      categoryId,
      organizationId,
      search,
      forExport,
      profileId,
      productType,
      warehouseId,
      inStockOnly,
      listView
    } = options;
    const isStockList = listView === 'stock';

    // Для listView=stock отбор «в наличии» — только products.service._getStockListInStockPage (обход каталога).
    const sqlInStockOnly = isStockList ? false : inStockOnly;

    const { whereSql, params, paramIndex: startParamIndex } = buildFindAllFilters({
      brandId,
      categoryId,
      organizationId,
      search,
      profileId,
      productType,
      inStockOnly: sqlInStockOnly,
      warehouseId
    });

    const selectCols = isStockList
      ? STOCK_LIST_SELECT
      : `
        p.*,
        b.name as brand_name,
        uc.name as category_name,
        o.name as organization_name,
        NULL as category_marketplace
      `;
    let sql = `
      SELECT 
        ${selectCols}
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN user_categories uc ON p.user_category_id = uc.id
      LEFT JOIN organizations o ON p.organization_id = o.id
      ${whereSql}
    `;
    let paramIndex = startParamIndex;
    sql += ` ORDER BY p.created_at DESC`;
    
    if (limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(limit);
    }
    
    if (offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(offset);
    }
    
    const result = await query(sql, params);
    const products = result.rows;
    if (!isStockList) {
      console.log(`[Products Repository] Found ${products.length} products in findAll`);
    }

    if (products.length > 0 && warehouseId != null && warehouseId !== '') {
      const wid = typeof warehouseId === 'string' ? parseInt(warehouseId, 10) : Number(warehouseId);
      if (Number.isFinite(wid)) {
        const productIds = products
          .map((p) => {
            const id = p.id;
            return typeof id === 'string' ? parseInt(id, 10) : id;
          })
          .filter((n) => Number.isFinite(n));
        if (productIds.length > 0) {
          const pwsRes = await query(
            `SELECT product_id, quantity FROM product_warehouse_stock WHERE warehouse_id = $1 AND product_id = ANY($2::bigint[])`,
            [wid, productIds]
          );
          const map = new Map(
            pwsRes.rows.map((r) => [String(r.product_id), Math.max(0, parseInt(r.quantity, 10) || 0)])
          );
          products.forEach((p) => {
            p.quantity_total_all_warehouses = p.quantity != null ? Number(p.quantity) : 0;
            p.quantity = map.get(String(p.id)) ?? 0;
            p.quantity_warehouse_id = wid;
          });
        }
      }
    }

    if (
      products.length > 0 &&
      isStockList &&
      (warehouseId == null || String(warehouseId).trim() === '')
    ) {
      const productIds = products
        .map((p) => {
          const id = p.id;
          return typeof id === 'string' ? parseInt(id, 10) : id;
        })
        .filter((n) => Number.isFinite(n));
      if (productIds.length > 0) {
        const pwsSumRes = await query(
          `SELECT product_id, COALESCE(SUM(COALESCE(quantity, 0)), 0)::int AS quantity
           FROM product_warehouse_stock
           WHERE product_id = ANY($1::bigint[])
           GROUP BY product_id`,
          [productIds]
        );
        const sumByProduct = new Map(
          pwsSumRes.rows.map((r) => [String(r.product_id), Math.max(0, parseInt(r.quantity, 10) || 0)])
        );
        products.forEach((p) => {
          const key = String(p.id);
          const sum = sumByProduct.has(key) ? sumByProduct.get(key) : null;
          const legacy = Math.max(0, Number(p.quantity) || 0);
          if (sum != null) {
            p.quantity_total_all_warehouses = p.quantity != null ? Number(p.quantity) : 0;
            p.quantity = sum > 0 ? sum : legacy;
          } else {
            p.quantity = legacy;
          }
        });
      }
    }

    if (products.length > 0 && !isStockList) {
      // Преобразуем ID в числа для правильного сравнения в PostgreSQL
      const productIds = products.map(p => {
        const id = p.id;
        return typeof id === 'string' ? parseInt(id, 10) : id;
      });
      let skusResult;
      try {
        skusResult = await query(
          `SELECT product_id, marketplace, sku, marketplace_product_id FROM product_skus WHERE product_id = ANY($1)`,
          [productIds]
        );
      } catch (skusErr) {
        if (skusErr.message && (skusErr.message.includes('marketplace_product_id') || skusErr.message.includes('does not exist'))) {
          skusResult = await query(
            `SELECT product_id, marketplace, sku FROM product_skus WHERE product_id = ANY($1)`,
            [productIds]
          );
          console.warn('[Products Repository] Column marketplace_product_id missing — run migration 026. Ozon product_id will be null.');
        } else {
          throw skusErr;
        }
      }
      const barcodesResult = await query(
        `SELECT product_id, barcode FROM barcodes WHERE product_id = ANY($1)`,
        [productIds]
      );
      
      const stocksResult = await query(
        `SELECT 
          product_id,
          COALESCE(SUM(stock), 0) as total_stock,
          MIN(CASE 
            WHEN price IS NOT NULL AND CAST(price AS NUMERIC) > 0 
            THEN CAST(price AS NUMERIC) 
            ELSE NULL 
          END) as min_cost,
          AVG(CASE 
            WHEN price IS NOT NULL AND CAST(price AS NUMERIC) > 0 
            THEN CAST(price AS NUMERIC) 
            ELSE NULL 
          END) as avg_cost,
          MAX(CASE 
            WHEN price IS NOT NULL AND CAST(price AS NUMERIC) > 0 
            THEN CAST(price AS NUMERIC) 
            ELSE NULL 
          END) as max_cost
        FROM supplier_stocks 
        WHERE product_id = ANY($1)
        GROUP BY product_id`,
        [productIds]
      );
      let pricesByProduct = {};
      try {
        let pricesResult;
        try {
          pricesResult = await query(
            'SELECT product_id, marketplace, min_price, calculation_details, updated_at FROM product_marketplace_prices WHERE product_id = ANY($1)',
            [productIds]
          );
        } catch (colErr) {
          if (colErr.message && colErr.message.includes('calculation_details')) {
            pricesResult = await query(
              'SELECT product_id, marketplace, min_price, updated_at FROM product_marketplace_prices WHERE product_id = ANY($1)',
              [productIds]
            );
            console.warn('[Products Repository] Column calculation_details missing — run migration 025. Loaded min prices only.');
          } else {
            throw colErr;
          }
        }
        pricesResult.rows.forEach(row => {
          const rawId = row.product_id;
          const key = String(typeof rawId === 'number' ? rawId : parseInt(rawId, 10) || rawId);
          if (!pricesByProduct[key]) pricesByProduct[key] = {};
          const price = row.min_price != null ? parseFloat(row.min_price) : null;
          const details = row.calculation_details != null
            ? (typeof row.calculation_details === 'object' ? row.calculation_details : (typeof row.calculation_details === 'string' ? (() => { try { return JSON.parse(row.calculation_details); } catch (e) { return null; } })() : null))
            : null;
          if (row.marketplace === 'ozon') {
            pricesByProduct[key].ozon = price;
            pricesByProduct[key].ozonDetails = details;
          } else if (row.marketplace === 'wb') {
            pricesByProduct[key].wb = price;
            pricesByProduct[key].wbDetails = details;
          } else if (row.marketplace === 'ym') {
            pricesByProduct[key].ym = price;
            pricesByProduct[key].ymDetails = details;
          }
          if (row.updated_at && (!pricesByProduct[key].updated_at || new Date(row.updated_at) > new Date(pricesByProduct[key].updated_at))) {
            pricesByProduct[key].updated_at = row.updated_at;
          }
        });
      } catch (err) {
        console.warn('[Products Repository] product_marketplace_prices not loaded (table may not exist):', err.message);
      }

      const skusByProduct = {};
      skusResult.rows.forEach(row => {
        const key = String(row.product_id);
        if (!skusByProduct[key]) skusByProduct[key] = {};
        skusByProduct[key][row.marketplace] = row.sku;
        if (row.marketplace === 'ozon' && row.marketplace_product_id != null) {
          skusByProduct[key].ozon_product_id = Number(row.marketplace_product_id);
        }
      });
      const barcodesByProduct = {};
      barcodesResult.rows.forEach(row => {
        const key = String(row.product_id);
        if (!barcodesByProduct[key]) barcodesByProduct[key] = [];
        barcodesByProduct[key].push(row.barcode);
      });
      
      // Создаем мапу остатков и себестоимости по товарам
      const stocksByProduct = {};
      stocksResult.rows.forEach(row => {
        // Преобразуем product_id в строку для сравнения с product.id (который может быть строкой)
        const productId = row.product_id;
        const key = String(productId);
        stocksByProduct[key] = {
          totalStock: parseInt(row.total_stock) || 0,
          minCost: parseFloat(row.min_cost) || null,
          avgCost: parseFloat(row.avg_cost) || null,
          maxCost: parseFloat(row.max_cost) || null
        };
      });

      products.forEach(product => {
        const skus = skusByProduct[String(product.id)] || {};
        product.sku_ozon = skus.ozon ?? null;
        product.sku_wb = skus.wb ?? null;
        product.sku_ym = skus.ym ?? null;
        product.ozon_product_id = skus.ozon_product_id ?? null;
        product.barcodes = barcodesByProduct[String(product.id)] || [];
        if (product.user_category_id) product.categoryId = product.user_category_id;
        if (product.brand_name) product.brand = product.brand_name;
        // Гарантируем наличие поля cost из БД (на случай если колонка добавлена позже или пришла как строка)
        if (product.cost === undefined) product.cost = null;
        const costFromDb = product.cost != null && !isNaN(Number(product.cost)) ? Number(product.cost) : null;

        // Добавляем остатки и себестоимость
        // product.quantity = остаток на нашем складе (из БД). supplierStockTotal = сумма остатков у поставщиков.
        const productIdKey = String(product.id);
        const stockData = stocksByProduct[productIdKey];
        const oldCost = product.cost;
        const isKit = product.product_type === 'kit';
        if (product.quantity === null || product.quantity === undefined) {
          product.quantity = 0;
        }
        if (stockData) {
          product.supplierStockTotal = stockData.totalStock;
          // Себестоимость: у комплектов — только из БД (уже посчитана по комплектующим); у обычных — приоритет supplier_stocks
          const costFromSuppliers = stockData.minCost != null && !isNaN(Number(stockData.minCost)) ? Number(stockData.minCost) : null;
          if (!isKit && costFromSuppliers !== null) {
            product.cost = costFromSuppliers;
            product.avg_cost = stockData.avgCost;
            product.max_cost = stockData.maxCost;
            // Не вызываем updateCostFromSupplierStocks здесь: на списке из сотен товаров это
            // запускает сотни параллельных запросов и исчерпывает пул PostgreSQL → 500 / timeout.
            // Себестоимость для ответа уже взята из stockData; синхронизацию в БД — отдельным сценарием (getById / фон).
          } else if (costFromDb !== null) {
            product.cost = costFromDb;
          } else {
            product.cost = null;
          }
        } else {
          product.supplierStockTotal = 0;
          product.cost = costFromDb;
        }
        // Нормализация: фронт всегда получает number | null
        product.cost = product.cost != null && !isNaN(Number(product.cost)) ? Number(product.cost) : null;
        // Маппинг min_price -> minPrice для фронтенда
        product.minPrice = product.min_price != null && !isNaN(Number(product.min_price)) ? Number(product.min_price) : 50;
        product.additionalExpenses =
          product.additional_expenses != null && !isNaN(Number(product.additional_expenses))
            ? Number(product.additional_expenses)
            : null;
        // Сохранённые минимальные цены и детали расчёта по маркетплейсам (из product_marketplace_prices)
        const idKey = String(typeof product.id === 'number' ? product.id : parseInt(product.id, 10) || product.id);
        const stored = pricesByProduct[idKey] || pricesByProduct[String(product.id)] || {};
        product.storedMinPriceOzon = stored.ozon ?? null;
        product.storedMinPriceWb = stored.wb ?? null;
        product.storedMinPriceYm = stored.ym ?? null;
        product.storedCalculationDetailsOzon = stored.ozonDetails ?? null;
        product.storedCalculationDetailsWb = stored.wbDetails ?? null;
        product.storedCalculationDetailsYm = stored.ymDetails ?? null;
        if (stored.updated_at) product.storedMinPriceUpdatedAt = stored.updated_at;
      });

      if (forExport) {
        try {
          const attrRes = await query(
            `SELECT pav.product_id, pav.attribute_id, pav.value, pa.name as attr_name
             FROM product_attribute_values pav
             LEFT JOIN product_attributes pa ON pa.id = pav.attribute_id
             WHERE pav.product_id = ANY($1)`,
            [productIds]
          );
          const byPid = {};
          const globalIdToName = {};
          for (const row of attrRes.rows) {
            if (row.attr_name) globalIdToName[String(row.attribute_id)] = row.attr_name;
            const pid = String(row.product_id);
            if (!byPid[pid]) byPid[pid] = { byId: {}, byName: {} };
            byPid[pid].byId[String(row.attribute_id)] = row.value;
            if (row.attr_name) byPid[pid].byName[row.attr_name] = row.value;
          }
          for (const p of products) {
            p._erp_attr_id_to_name = globalIdToName;
            const pack = byPid[String(p.id)];
            if (pack) {
              p.attribute_values = pack.byId;
              p.erp_attributes_by_name = pack.byName;
            }
          }
        } catch (e) {
          console.warn('[Products Repository] product_attribute_values for export:', e.message);
        }
      }
    }

    if (products.length > 0) {
      if (isStockList) {
        for (const p of products) {
          if (p.quantity == null) p.quantity = 0;
          if (p.user_category_id) p.categoryId = p.user_category_id;
          if (p.brand_name) p.brand = p.brand_name;
          p.supplierStockTotal = 0;
        }
      }

      // Комплектующие для комплектов в списке (один запрос на страницу)
      const pageNumericIds = [
        ...new Set(
          products
            .map((p) => {
              const key = productIdMapKey(p.id);
              if (!key) return null;
              const n = parseInt(key, 10);
              return Number.isFinite(n) && n > 0 ? n : null;
            })
            .filter((n) => n != null)
        ),
      ];
      let kitParentKeySet = new Set();
      if (pageNumericIds.length > 0) {
        try {
          const kitParentRes = await query(
            `SELECT DISTINCT kit_product_id FROM kit_components WHERE kit_product_id = ANY($1::bigint[])`,
            [pageNumericIds]
          );
          kitParentKeySet = new Set(
            (kitParentRes.rows || [])
              .map((r) => productIdMapKey(r.kit_product_id))
              .filter(Boolean)
          );
        } catch (err) {
          if (!String(err?.message || '').includes('kit_components')) throw err;
        }
      }
      for (const p of products) {
        if (kitParentKeySet.has(productIdMapKey(p.id))) {
          p.is_kit_catalog = true;
        }
      }
      const kitProductIds = [
        ...new Set(
          products
            .filter((p) => isKitProductType(p.product_type) || p.is_kit_catalog === true)
            .map((p) => {
              const key = productIdMapKey(p.id);
              if (!key) return null;
              const n = parseInt(key, 10);
              return Number.isFinite(n) && n > 0 ? n : null;
            })
            .filter((n) => n != null)
        ),
      ];
      if (kitProductIds.length > 0) {
        try {
          const kitRes = await query(
            `SELECT kc.kit_product_id, kc.component_product_id, kc.quantity,
                    p.sku AS component_sku, p.name AS component_name
             FROM kit_components kc
             LEFT JOIN products p ON p.id = kc.component_product_id
             WHERE kc.kit_product_id = ANY($1::bigint[])`,
            [kitProductIds]
          );
          const byKit = new Map();
          for (const r of kitRes.rows) {
            const key = productIdMapKey(r.kit_product_id);
            if (!key) continue;
            if (!byKit.has(key)) byKit.set(key, []);
            byKit.get(key).push({
              productId: r.component_product_id,
              quantity: r.quantity,
              component_sku: r.component_sku,
              product_name: r.component_name,
            });
          }
          for (const p of products) {
            if (isKitProductType(p.product_type) || p.is_kit_catalog === true) {
              const key = productIdMapKey(p.id);
              p.kit_components = key ? byKit.get(key) || [] : [];
            }
          }
        } catch (err) {
          if (err.message && err.message.includes('kit_components')) {
            for (const p of products) {
              if (isKitProductType(p.product_type) || p.is_kit_catalog === true) {
                p.kit_components = [];
              }
            }
          } else {
            throw err;
          }
        }
      } else {
        for (const p of products) {
          if (isKitProductType(p.product_type) || p.is_kit_catalog === true) {
            p.kit_components = [];
          }
        }
      }
    }

    const { buildKitListStockContext, attachKitDisplayMetrics, isKitCatalogProduct } =
      await import('../services/kitStock.service.js');
    const hasKits = products.some((p) => isKitCatalogProduct(p));
    const kitCtx = hasKits ? await buildKitListStockContext(products, options) : null;

    if (hasKits && kitCtx) {
      await attachKitDisplayMetrics(products, { ...options, _kitCtx: kitCtx });
    }

    await this._reconcileReservedQuantityFromMovements(
      products,
      { ...options, persistReservedToDb: true, skipKitCatalog: hasKits && !!kitCtx },
      kitCtx
    );

    return products;
  }

  async countAll(options = {}) {
    const isStockList = options.listView === 'stock';
    const { whereSql, params } = buildFindAllFilters({
      ...options,
      inStockOnly: isStockList ? false : options.inStockOnly
    });
    const result = await query(
      `SELECT COUNT(*)::int AS total
       FROM products p
       ${whereSql}`,
      params
    );
    return Number(result.rows?.[0]?.total || 0);
  }
  
  /**
   * Получить товар по ID
   */
  async findById(id) {
    // Преобразуем ID в число, если это строка
    const numericId = typeof id === 'string' ? parseInt(id, 10) : id;
    
    if (isNaN(numericId) || numericId <= 0) {
      console.warn(`[Products Repository] Invalid ID provided to findById: ${id} (type: ${typeof id})`);
      return null;
    }
    
    console.log(`[Products Repository] Searching for product with ID: ${numericId} (original: ${id}, type: ${typeof id})`);
    
    const result = await query(`
      SELECT 
        p.*,
        b.name as brand_name,
        uc.name as category_name,
        o.name as organization_name
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN user_categories uc ON p.user_category_id = uc.id
      LEFT JOIN organizations o ON p.organization_id = o.id
      WHERE p.id = $1
    `, [numericId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const product = result.rows[0];
    
    console.log(`[Products Repository] Found product: ${product.name} (ID: ${product.id})`);
    
    // Маппим brand_name в brand для совместимости с фронтендом
    if (product.brand_name) {
      product.brand = product.brand_name;
    }
    
    // Маппим user_category_id в categoryId для совместимости с фронтендом
    if (product.user_category_id) {
      product.categoryId = product.user_category_id;
    }
    
    // Загружаем остатки и себестоимость из supplier_stocks
    // Убрали условие AND stock > 0, чтобы показывать все товары, даже с нулевыми остатками
    const stocksResult = await query(
      `SELECT 
        COALESCE(SUM(stock), 0) as total_stock,
        MIN(CASE 
          WHEN price IS NOT NULL AND CAST(price AS NUMERIC) > 0 
          THEN CAST(price AS NUMERIC) 
          ELSE NULL 
        END) as min_cost,
        AVG(CASE 
          WHEN price IS NOT NULL AND CAST(price AS NUMERIC) > 0 
          THEN CAST(price AS NUMERIC) 
          ELSE NULL 
        END) as avg_cost,
        MAX(CASE 
          WHEN price IS NOT NULL AND CAST(price AS NUMERIC) > 0 
          THEN CAST(price AS NUMERIC) 
          ELSE NULL 
        END) as max_cost
      FROM supplier_stocks 
      WHERE product_id = $1`,
      [numericId]
    );
    
    if (product.cost === undefined) product.cost = null;
    const costFromDb = product.cost != null && !isNaN(Number(product.cost)) ? Number(product.cost) : null;
    const isKit = product.product_type === 'kit';

    if (stocksResult.rows.length > 0) {
      const stockData = stocksResult.rows[0];
      const costFromSuppliers = stockData.min_cost != null && !isNaN(parseFloat(stockData.min_cost)) ? parseFloat(stockData.min_cost) : null;
      // У комплектов себестоимость только из БД (сумма по комплектующим)
      if (!isKit && costFromSuppliers !== null) {
        product.cost = costFromSuppliers;
        product.avg_cost = stockData.avg_cost != null ? parseFloat(stockData.avg_cost) : null;
        product.max_cost = stockData.max_cost != null ? parseFloat(stockData.max_cost) : null;
        this.updateCostFromSupplierStocks(numericId).catch(err => {
          console.error(`[Products Repository] Error updating cost in DB for product ${numericId}:`, err.message);
        });
      } else if (costFromDb !== null) {
        product.cost = costFromDb;
      } else {
        product.cost = null;
      }
    } else {
      product.cost = costFromDb;
    }
    product.cost = product.cost != null && !isNaN(Number(product.cost)) ? Number(product.cost) : null;

    product.sku_ozon = null;
    product.sku_wb = null;
    product.sku_ym = null;
    product.minPrice = product.min_price != null && !isNaN(Number(product.min_price)) ? Number(product.min_price) : 50;
    product.additionalExpenses =
      product.additional_expenses != null && !isNaN(Number(product.additional_expenses))
        ? Number(product.additional_expenses)
        : null;
    let skusResult;
    try {
      skusResult = await query(
        'SELECT marketplace, sku, marketplace_product_id FROM product_skus WHERE product_id = $1',
        [numericId]
      );
    } catch (skusErr) {
      if (skusErr.message && (skusErr.message.includes('marketplace_product_id') || skusErr.message.includes('does not exist'))) {
        skusResult = await query(
          'SELECT marketplace, sku FROM product_skus WHERE product_id = $1',
          [numericId]
        );
      } else {
        throw skusErr;
      }
    }
    skusResult.rows.forEach(row => {
      if (row.marketplace === 'ozon') {
        product.sku_ozon = row.sku;
        product.ozon_product_id = row.marketplace_product_id != null ? Number(row.marketplace_product_id) : null;
      } else if (row.marketplace === 'wb') product.sku_wb = row.sku;
      else if (row.marketplace === 'ym') product.sku_ym = row.sku;
    });
    await this._reconcileReservedQuantityFromMovements([product]);
    const { isKitCatalogProduct, attachKitDisplayMetrics, buildKitListStockContext } =
      await import('../services/kitStock.service.js');
    if (isKitCatalogProduct(product)) {
      try {
        const kc = await query(
          `SELECT component_product_id, quantity FROM kit_components WHERE kit_product_id = $1`,
          [numericId]
        );
        product.kit_components = (kc.rows || []).map((r) => ({
          productId: r.component_product_id,
          quantity: r.quantity
        }));
        product.is_kit_catalog = true;
      } catch {
        product.kit_components = product.kit_components || [];
      }
      const kitCtx = await buildKitListStockContext([product], {});
      if (kitCtx) {
        await attachKitDisplayMetrics([product], { _kitCtx: kitCtx });
      }
    }
    return product;
  }
  
  /**
   * Получить товар по SKU.
   * @param {string} sku
   * @param {{ profileId?: number|string|null }} [options] — если задан, поиск только внутри аккаунта (мультитенант)
   */
  async findBySku(sku, options = {}) {
    const profileId = options.profileId ?? options.profile_id;
    const params = [sku];
    let profileClause = '';
    if (profileId != null && profileId !== '') {
      profileClause = ' AND p.profile_id = $2';
      params.push(profileId);
    }
    const result = await query(`
      SELECT 
        p.*,
        b.name as brand_name,
        uc.name as category_name
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN user_categories uc ON p.user_category_id = uc.id
      WHERE p.sku = $1${profileClause}
    `, params);
    
    const product = result.rows[0] || null;
    if (product) {
      // Маппим user_category_id в categoryId для совместимости с фронтендом
      if (product.user_category_id) {
        product.categoryId = product.user_category_id;
      }
      // Маппим brand_name в brand для совместимости с фронтендом
      if (product.brand_name) {
        product.brand = product.brand_name;
      }
    }
    return product;
  }

  /** Варианты EAN для сканера (12↔13 цифр, ведущий ноль). */
  _barcodeDigitVariants(digits) {
    const out = [];
    const d = String(digits || '').replace(/\D/g, '');
    if (!d) return out;
    out.push(d);
    if (d.length === 12) out.push(`0${d}`);
    if (d.length === 13 && d.startsWith('0')) out.push(d.slice(1));
    return [...new Set(out)];
  }

  async _findProductIdByBarcodeValue(trimmed, digitsOnly) {
    const hasDigits = digitsOnly.length > 0;
    const result = await query(
      hasDigits
        ? `SELECT product_id
           FROM barcodes
           WHERE TRIM(barcode) = TRIM($1)
              OR REGEXP_REPLACE(barcode, '\\D', '', 'g') = $2
           LIMIT 1`
        : `SELECT product_id
           FROM barcodes
           WHERE TRIM(barcode) = TRIM($1)
           LIMIT 1`,
      hasDigits ? [trimmed, digitsOnly] : [trimmed]
    );
    return result.rows[0]?.product_id ?? null;
  }

  /**
   * Получить товар по штрихкоду (id товара из таблицы barcodes)
   */
  async findByBarcode(barcode) {
    const trimmed = typeof barcode === 'string' ? barcode.trim() : String(barcode || '');
    if (!trimmed) return null;
    const digits = trimmed.replace(/\D/g, '');
    const hasDigits = digits.length > 0;

    const lookupKeys = [trimmed];
    if (hasDigits) {
      for (const v of this._barcodeDigitVariants(digits)) {
        lookupKeys.push(v);
      }
    }

    let productId = null;
    for (const key of lookupKeys) {
      const d = key.replace(/\D/g, '');
      productId = await this._findProductIdByBarcodeValue(key, d);
      if (productId != null) break;
    }

    if (productId == null) {
      const skuKeys = [trimmed];
      if (hasDigits) {
        for (const v of this._barcodeDigitVariants(digits)) skuKeys.push(v);
      }
      for (const key of [...new Set(skuKeys)]) {
        const bySku = await query(
          `SELECT id FROM products
           WHERE TRIM(sku) = TRIM($1)
             AND COALESCE(is_archived, false) = false
           LIMIT 1`,
          [key]
        );
        if (bySku.rows[0]?.id != null) {
          return await this.findById(bySku.rows[0].id);
        }
        const d = key.replace(/\D/g, '');
        if (d.length >= 6) {
          const bySkuDigits = await query(
            `SELECT id FROM products
             WHERE REGEXP_REPLACE(COALESCE(sku, ''), '\\D', '', 'g') = $1
               AND COALESCE(is_archived, false) = false
             LIMIT 1`,
            [d]
          );
          if (bySkuDigits.rows[0]?.id != null) {
            return await this.findById(bySkuDigits.rows[0].id);
          }
        }
      }
      return null;
    }
    return await this.findById(productId);
  }
  
  /**
   * Получить товар с полной информацией (штрихкоды, SKU маркетплейсов, связи)
   */
  async findByIdWithDetails(id) {
    const product = await this.findById(id);
    if (!product) return null;
    const numId = Number(product.id);
    if (isNaN(numId)) return product;
    
    // Маппинг уже выполнен в findById, но убедимся, что brand тоже есть
    if (product.brand_name && !product.brand) {
      product.brand = product.brand_name;
    }
    
    // Получаем штрихкоды (используем числовой id, как при записи)
    const barcodesResult = await query(
      'SELECT barcode FROM barcodes WHERE product_id = $1',
      [numId]
    );
    product.barcodes = barcodesResult.rows.map(r => r.barcode);
    
    // Получаем SKU маркетплейсов и Ozon product_id
    let skusResultDetail;
    try {
      skusResultDetail = await query(
        'SELECT marketplace, sku, marketplace_product_id FROM product_skus WHERE product_id = $1',
        [numId]
      );
    } catch (skusErr) {
      if (skusErr.message && (skusErr.message.includes('marketplace_product_id') || skusErr.message.includes('does not exist'))) {
        skusResultDetail = await query(
          'SELECT marketplace, sku FROM product_skus WHERE product_id = $1',
          [numId]
        );
      } else {
        throw skusErr;
      }
    }
    product.marketplace_skus = {};
    skusResultDetail.rows.forEach(row => {
      product.marketplace_skus[row.marketplace] = row.sku;
      if (row.marketplace === 'ozon' && row.marketplace_product_id != null) {
        product.ozon_product_id = Number(row.marketplace_product_id);
      }
    });
    
    // Получаем связи с маркетплейсами
    const linksResult = await query(
      'SELECT marketplace, is_linked FROM product_links WHERE product_id = $1',
      [numId]
    );
    product.mp_linked = {};
    linksResult.rows.forEach(row => {
      product.mp_linked[row.marketplace] = row.is_linked;
    });
    
    // Комплектующие (для типа kit)
    if (product.product_type === 'kit') {
      try {
        const kitResult = await query(
          `SELECT kc.component_product_id, kc.quantity, p.sku as component_sku, p.name as component_name
           FROM kit_components kc
           LEFT JOIN products p ON p.id = kc.component_product_id
           WHERE kc.kit_product_id = $1`,
          [numId]
        );
        product.kit_components = kitResult.rows.map(r => ({
          productId: r.component_product_id,
          quantity: r.quantity,
          component_sku: r.component_sku,
          product_name: r.component_name
        }));
      } catch (err) {
        if (err.message && !err.message.includes('kit_components')) {
          throw err;
        }
        product.kit_components = [];
      }
    } else {
      product.kit_components = [];
    }
    
    // Значения атрибутов товара
    try {
      const attrValResult = await query(
        'SELECT attribute_id, value FROM product_attribute_values WHERE product_id = $1',
        [numId]
      );
      product.attribute_values = {};
      attrValResult.rows.forEach(row => {
        const aid = row.attribute_id != null ? String(row.attribute_id) : null;
        if (aid) product.attribute_values[aid] = row.value;
      });
    } catch (err) {
      if (!err.message || !err.message.includes('product_attribute_values')) {
        throw err;
      }
      product.attribute_values = {};
    }
    
    return product;
  }
  
  /**
   * Создать товар
   */
  async create(productData) {
    return await transaction(async (client) => {
      // Вставляем товар
      // Используем user_category_id для пользовательских категорий, если передан categoryId
      const userCategoryId = productData.categoryId || productData.user_category_id || null;
      const productType = (productData.product_type === 'kit' ? 'kit' : 'product');
      const orgId = productData.organization_id != null && productData.organization_id !== '' ? productData.organization_id : null;
      const addExpRaw = productData.additionalExpenses ?? productData.additional_expenses;
      const additionalExpensesVal =
        addExpRaw != null && addExpRaw !== '' && !isNaN(Number(addExpRaw)) ? Number(addExpRaw) : null;
      const mpStr = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
      const profileIdRaw = productData.profile_id ?? productData.profileId ?? null;
      if (profileIdRaw == null || profileIdRaw === '') {
        const err = new Error('Для товара нужен profile_id (аккаунт пользователя)');
        err.statusCode = 400;
        throw err;
      }
      const productResult = await client.query(`
        INSERT INTO products (
          profile_id,
          sku, name, brand_id, user_category_id, price, cost, additional_expenses, min_price, buyout_rate, buyout_rate_ozon, buyout_rate_wb, buyout_rate_ym,
          weight, length, width, height, volume, quantity, unit, description, product_type, organization_id, country_of_origin,
          mp_ozon_name, mp_ozon_description, mp_ozon_brand,
          mp_wb_vendor_code, mp_wb_name, mp_wb_description, mp_wb_brand,
          mp_ym_name, mp_ym_description
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
        RETURNING *
      `, [
        profileIdRaw,
        productData.sku,
        productData.name,
        productData.brand_id || null,
        userCategoryId,
        productData.price || 0,
        productData.cost || null,
        additionalExpensesVal,
        (productData.minPrice ?? productData.min_price ?? 50) || 50,
        productData.buyout_rate || 95,
        productData.buyout_rate_ozon || null,
        productData.buyout_rate_wb || null,
        productData.buyout_rate_ym || null,
        productData.weight || null,
        productData.length || null,
        productData.width || null,
        productData.height || null,
        productData.volume || null,
        (() => {
          const q = productData.quantity;
          if (q === undefined || q === null || q === '') return 0;
          const n = parseInt(q, 10);
          return Number.isNaN(n) ? 0 : Math.max(0, n);
        })(),
        productData.unit || 'шт',
        productData.description || null,
        productType,
        orgId,
        productData.country_of_origin || null,
        mpStr(productData.mp_ozon_name),
        mpStr(productData.mp_ozon_description),
        mpStr(productData.mp_ozon_brand),
        mpStr(productData.mp_wb_vendor_code),
        mpStr(productData.mp_wb_name),
        mpStr(productData.mp_wb_description),
        mpStr(productData.mp_wb_brand),
        mpStr(productData.mp_ym_name),
        mpStr(productData.mp_ym_description)
      ]);
      
      const product = productResult.rows[0];
      if (!product || product.id == null) {
        throw new Error('INSERT INTO products не вернул строку (RETURNING *). Проверьте наличие колонки product_type и миграции.');
      }

      await client.query(
        `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
         SELECT $1, w.id, 0
         FROM (SELECT id FROM warehouses WHERE type = 'warehouse' AND supplier_id IS NULL) w
         ON CONFLICT (product_id, warehouse_id) DO NOTHING`,
        [product.id]
      );
      
      // Маппим user_category_id в categoryId для совместимости с фронтендом
      if (product.user_category_id) {
        product.categoryId = product.user_category_id;
      }
      
      // Добавляем штрихкоды (UNIQUE на barcode)
      if (productData.barcodes && Array.isArray(productData.barcodes)) {
        for (const barcode of productData.barcodes) {
          const s = typeof barcode === 'string' ? barcode.trim() : '';
          if (s) {
            await client.query(
              'INSERT INTO barcodes (product_id, barcode) VALUES ($1, $2) ON CONFLICT (barcode) DO NOTHING',
              [product.id, s]
            );
          }
        }
      }
      
      // SKU маркетплейсов: Ozon — offer_id и/или product_id; WB/ЯМ — непустой sku
      if (productData.marketplace_skus && typeof productData.marketplace_skus === 'object') {
        const mus = productData.marketplace_skus;
        const ozonPid =
          productData.marketplace_ozon_product_id != null ? productData.marketplace_ozon_product_id : null;
        await upsertProductSkuRow(client, {
          productId: product.id,
          marketplace: 'ozon',
          skuRaw: mus.ozon,
          marketplaceProductId: ozonPid,
        });
        await upsertProductSkuRow(client, {
          productId: product.id,
          marketplace: 'wb',
          skuRaw: mus.wb,
          marketplaceProductId: null,
        });
        await upsertProductSkuRow(client, {
          productId: product.id,
          marketplace: 'ym',
          skuRaw: mus.ym,
          marketplaceProductId: null,
        });
      }
      
      // Добавляем связи с маркетплейсами (UNIQUE product_id, marketplace)
      if (productData.mp_linked) {
        for (const [marketplace, isLinked] of Object.entries(productData.mp_linked)) {
          await client.query(
            `INSERT INTO product_links (product_id, marketplace, is_linked) VALUES ($1, $2, $3)
             ON CONFLICT (product_id, marketplace) DO UPDATE SET is_linked = EXCLUDED.is_linked`,
            [product.id, marketplace, Boolean(isLinked)]
          );
        }
      }
      
      // Комплектующие (для типа kit)
      if (productType === 'kit' && productData.kit_components && Array.isArray(productData.kit_components)) {
        for (const item of productData.kit_components) {
          const compId = item.productId != null ? Number(item.productId) : Number(item.component_product_id);
          const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
          if (compId && compId !== product.id) {
            await client.query(
              `INSERT INTO kit_components (kit_product_id, component_product_id, quantity) VALUES ($1, $2, $3)
               ON CONFLICT (kit_product_id, component_product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
              [product.id, compId, qty]
            );
          }
        }
        // Себестоимость комплекта = сумма (себестоимость комплектующего × количество)
        const kitId = Number(product.id) || parseInt(product.id, 10);
        const kitCost = await this._computeKitCost(client, kitId);
        await client.query(
          'UPDATE products SET cost = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [kitCost != null ? kitCost : null, kitId]
        );
        product.cost = kitCost != null ? kitCost : null;
      }
      
      // Значения атрибутов товара
      if (productData.attribute_values && typeof productData.attribute_values === 'object') {
        for (const [attrId, value] of Object.entries(productData.attribute_values)) {
          const aid = parseInt(attrId, 10);
          if (aid && (value !== undefined && value !== null && value !== '')) {
            const valStr = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
            await client.query(
              `INSERT INTO product_attribute_values (product_id, attribute_id, value) VALUES ($1, $2, $3)
               ON CONFLICT (product_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
              [product.id, aid, valStr]
            );
          }
        }
      }
      
      // Не вызываем findByIdWithDetails здесь: он использует другое соединение и не видит незакоммиченную строку.
      // Сервис после коммита вызовет findById(product.id) и получит полные данные.
      if (product.brand_name) product.brand = product.brand_name;
      product.barcodes = productData.barcodes && Array.isArray(productData.barcodes)
        ? productData.barcodes.filter(b => b && String(b).trim()).map(b => String(b).trim())
        : [];
      product.kit_components = product.product_type === 'kit' && productData.kit_components && Array.isArray(productData.kit_components)
        ? productData.kit_components.map(c => ({ productId: c.productId ?? c.component_product_id, quantity: c.quantity || 1 }))
        : [];
      if (productData.ozon_attributes != null && typeof productData.ozon_attributes === 'object') {
        await client.query(
          'UPDATE products SET ozon_attributes = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [JSON.stringify(productData.ozon_attributes), product.id]
        );
        product.ozon_attributes = productData.ozon_attributes;
      }
      if (productData.wb_attributes != null && typeof productData.wb_attributes === 'object') {
        await client.query(
          'UPDATE products SET wb_attributes = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [JSON.stringify(productData.wb_attributes), product.id]
        );
        product.wb_attributes = productData.wb_attributes;
      }
      if (productData.ym_attributes != null && typeof productData.ym_attributes === 'object') {
        await client.query(
          'UPDATE products SET ym_attributes = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [JSON.stringify(productData.ym_attributes), product.id]
        );
        product.ym_attributes = productData.ym_attributes;
      }
      if (productData.ozon_draft !== undefined) {
        await client.query(
          'UPDATE products SET ozon_draft = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [productData.ozon_draft != null && typeof productData.ozon_draft === 'object' ? JSON.stringify(productData.ozon_draft) : null, product.id]
        );
        product.ozon_draft = productData.ozon_draft ?? null;
      }
      if (productData.wb_draft !== undefined) {
        await client.query(
          'UPDATE products SET wb_draft = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [productData.wb_draft != null && typeof productData.wb_draft === 'object' ? JSON.stringify(productData.wb_draft) : null, product.id]
        );
        product.wb_draft = productData.wb_draft ?? null;
      }
      if (productData.ym_draft !== undefined) {
        await client.query(
          'UPDATE products SET ym_draft = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [productData.ym_draft != null && typeof productData.ym_draft === 'object' ? JSON.stringify(productData.ym_draft) : null, product.id]
        );
        product.ym_draft = productData.ym_draft ?? null;
      }
      if (productData.images !== undefined) {
        await client.query(
          'UPDATE products SET images = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [productData.images != null && typeof productData.images === 'object' ? JSON.stringify(productData.images) : null, product.id]
        );
        product.images = productData.images ?? null;
      }
      return product;
    });
  }
  
  /**
   * Обновить товар
   */
  async update(id, updates) {
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    await transaction(async (client) => {
      // Для комплектов cost не берём из запроса — он считается по комплектующим ниже
      const typeCheck = await client.query('SELECT product_type FROM products WHERE id = $1', [numId]);
      const isKit = typeCheck.rows.length > 0 && String(typeCheck.rows[0].product_type || '').trim().toLowerCase() === 'kit';
      const allowedFields = [
        'sku', 'name', 'brand_id', 'price', ...(isKit ? [] : ['cost']), 'buyout_rate', 
        'buyout_rate_ozon', 'buyout_rate_wb', 'buyout_rate_ym',
        'weight', 'length', 'width', 'height', 'volume', 'quantity', 'unit', 'description', 'product_type', 'organization_id', 'country_of_origin',
        'mp_ozon_name', 'mp_ozon_description', 'mp_ozon_brand',
        'mp_wb_vendor_code', 'mp_wb_name', 'mp_wb_description', 'mp_wb_brand',
        'mp_ym_name', 'mp_ym_description',
        'ozon_attributes', 'wb_attributes', 'ym_attributes',
        'ozon_draft', 'wb_draft', 'ym_draft',
        'images'
      ];
      const updateFields = [];
      const params = [];
      let paramIndex = 1;
      
      // Обрабатываем categoryId отдельно, маппим в user_category_id
      if (updates.hasOwnProperty('categoryId')) {
        updateFields.push(`user_category_id = $${paramIndex++}`);
        params.push(updates.categoryId || null);
      }
      
      // Обрабатываем minPrice отдельно, маппим в min_price
      if (updates.hasOwnProperty('minPrice')) {
        updateFields.push(`min_price = $${paramIndex++}`);
        params.push(updates.minPrice != null && updates.minPrice !== '' && !isNaN(Number(updates.minPrice))
          ? Number(updates.minPrice)
          : 50);
      }

      if (updates.hasOwnProperty('additionalExpenses') || updates.hasOwnProperty('additional_expenses')) {
        updateFields.push(`additional_expenses = $${paramIndex++}`);
        const v = updates.hasOwnProperty('additionalExpenses') ? updates.additionalExpenses : updates.additional_expenses;
        params.push(v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : null);
      }
      
      if (updates.hasOwnProperty('buyout_rate')) {
        const v = updates.buyout_rate;
        const buyoutRateValue = (v === null || v === undefined) ? 95 : (isNaN(parseFloat(v)) ? 95 : parseFloat(v));
        updateFields.push(`buyout_rate = $${paramIndex++}`);
        params.push(buyoutRateValue);
      }
      
      for (const field of allowedFields) {
        if (field === 'buyout_rate') continue;
        if (!updates.hasOwnProperty(field)) continue;
        if (
          field === 'ozon_attributes' || field === 'wb_attributes' || field === 'ym_attributes' ||
          field === 'ozon_draft' || field === 'wb_draft' || field === 'ym_draft' ||
          field === 'images'
        ) {
          updateFields.push(`${field} = $${paramIndex++}::jsonb`);
          params.push(updates[field] != null && typeof updates[field] === 'object' ? JSON.stringify(updates[field]) : null);
        } else {
          updateFields.push(`${field} = $${paramIndex++}`);
          params.push(updates[field]);
        }
      }
      
      if (updateFields.length > 0) {
        params.push(numId);
        await client.query(
          `UPDATE products SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
          params
        );
      }
      
      if (updates.barcodes !== undefined) {
        await client.query('DELETE FROM barcodes WHERE product_id = $1', [numId]);
        if (Array.isArray(updates.barcodes)) {
          for (const barcode of updates.barcodes) {
            if (barcode && barcode.trim()) {
              await client.query(
                'INSERT INTO barcodes (product_id, barcode) VALUES ($1, $2)',
                [numId, barcode.trim()]
              );
            }
          }
        }
      }

      if (updates.marketplace_skus !== undefined) {
        const mus = updates.marketplace_skus;
        const ozonPidOpt = Object.prototype.hasOwnProperty.call(updates, 'marketplace_ozon_product_id')
          ? updates.marketplace_ozon_product_id
          : undefined;
        await applyMarketplaceSkusPatch(client, numId, mus, { ozonProductId: ozonPidOpt });
      }

      if (updates.mp_linked) {
        for (const [marketplace, isLinked] of Object.entries(updates.mp_linked)) {
          await client.query(
            `INSERT INTO product_links (product_id, marketplace, is_linked) VALUES ($1, $2, $3)
             ON CONFLICT (product_id, marketplace) DO UPDATE SET is_linked = EXCLUDED.is_linked`,
            [numId, marketplace, Boolean(isLinked)]
          );
        }
      }
      
      // Комплектующие (для типа kit): перезаписываем список
      if (updates.hasOwnProperty('kit_components')) {
        await client.query('DELETE FROM kit_components WHERE kit_product_id = $1', [numId]);
        if (Array.isArray(updates.kit_components) && updates.kit_components.length > 0) {
          for (const item of updates.kit_components) {
            const compId = item.productId != null ? Number(item.productId) : Number(item.component_product_id);
            const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
            if (compId && compId !== numId) {
              await client.query(
                `INSERT INTO kit_components (kit_product_id, component_product_id, quantity) VALUES ($1, $2, $3)
                 ON CONFLICT (kit_product_id, component_product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
                [numId, compId, qty]
              );
            }
          }
        }
      }
      
      // Значения атрибутов товара
      if (updates.hasOwnProperty('attribute_values') && typeof updates.attribute_values === 'object') {
        await client.query('DELETE FROM product_attribute_values WHERE product_id = $1', [numId]);
        for (const [attrId, value] of Object.entries(updates.attribute_values)) {
          const aid = parseInt(attrId, 10);
          if (aid && (value !== undefined && value !== null && value !== '')) {
            const valStr = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
            await client.query(
              'INSERT INTO product_attribute_values (product_id, attribute_id, value) VALUES ($1, $2, $3)',
              [numId, aid, valStr]
            );
          }
        }
      }

      // Для комплектов всегда пересчитываем себестоимость по комплектующим
      const typeRes = await client.query('SELECT product_type FROM products WHERE id = $1', [numId]);
      const productType = typeRes.rows.length > 0 ? String(typeRes.rows[0].product_type || '').trim().toLowerCase() : '';
      if (productType === 'kit') {
        const kitCost = await this._computeKitCost(client, numId);
        await client.query(
          'UPDATE products SET cost = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [kitCost != null ? kitCost : null, numId]
        );
      }

      // Если обновили себестоимость товара — пересчитать себестоимость всех комплектов, где он комплектующий
      const kitsContainingThis = await client.query(
        'SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = $1',
        [numId]
      );
      if (kitsContainingThis.rows && kitsContainingThis.rows.length > 0) {
        for (const row of kitsContainingThis.rows) {
          const kitId = row.kit_product_id;
          if (!kitId) continue;
          const kitCost = await this._computeKitCost(client, kitId);
          await client.query(
            'UPDATE products SET cost = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [kitCost != null ? kitCost : null, kitId]
          );
        }
      }
    });
    return await this.findByIdWithDetails(id);
  }

  /** Первый «свой» склад (type=warehouse, без поставщика) по MIN(id) — для операций без явного склада. */
  async getDefaultOwnWarehouseId() {
    // Приоритет: явный ID из env (если задан), затем «Москва» (по адресу), затем MIN(id).
    const envIdRaw = process.env.DEFAULT_OWN_WAREHOUSE_ID;
    if (envIdRaw != null && String(envIdRaw).trim() !== '') {
      const n = parseInt(String(envIdRaw), 10);
      if (Number.isFinite(n) && n > 0) {
        const ok = await query(
          `SELECT 1 FROM warehouses WHERE id = $1 AND type = 'warehouse' AND supplier_id IS NULL LIMIT 1`,
          [n]
        );
        if (ok.rows?.length) return n;
      }
    }

    const preferCityRaw = process.env.DEFAULT_OWN_WAREHOUSE_CITY || 'Москва';
    const preferCity = String(preferCityRaw || '').trim();
    if (preferCity) {
      const rCity = await query(
        `SELECT id
         FROM warehouses
         WHERE type = 'warehouse'
           AND supplier_id IS NULL
           AND COALESCE(address, '') ILIKE $1
         ORDER BY id ASC
         LIMIT 1`,
        [`%${preferCity}%`]
      );
      if (rCity.rows?.[0]?.id != null) return rCity.rows[0].id;
    }

    const r = await query(
      `SELECT id FROM warehouses WHERE type = 'warehouse' AND supplier_id IS NULL ORDER BY id ASC LIMIT 1`
    );
    return r.rows?.[0]?.id ?? null;
  }

  /** Проверка id склада и fallback на склад по умолчанию. */
  async resolveOwnWarehouseId(warehouseId) {
    if (warehouseId != null && warehouseId !== '') {
      const n = typeof warehouseId === 'string' ? parseInt(warehouseId, 10) : Number(warehouseId);
      if (Number.isFinite(n)) {
        const r = await query(
          `SELECT id FROM warehouses WHERE id = $1 AND type = 'warehouse' AND supplier_id IS NULL`,
          [n]
        );
        if (r.rows?.length) return n;
      }
    }
    return await this.getDefaultOwnWarehouseId();
  }

  /** Склад обязателен: без fallback на склад по умолчанию. */
  async resolveStrictOwnWarehouseId(warehouseId) {
    if (warehouseId == null || warehouseId === '') return null;
    const n = typeof warehouseId === 'string' ? parseInt(warehouseId, 10) : Number(warehouseId);
    if (!Number.isFinite(n) || n < 1) return null;
    const r = await query(
      `SELECT id FROM warehouses WHERE id = $1 AND type = 'warehouse' AND supplier_id IS NULL`,
      [n]
    );
    return r.rows?.length ? n : null;
  }

  async getWarehouseFreeStock(productId, warehouseId) {
    const r = await query(
      `SELECT quantity FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2`,
      [productId, warehouseId]
    );
    if (!r.rows?.length) {
      // Если складской учёт включён, но строка по складу ещё не создана (например, после миграции),
      // то резерв/свободный остаток начинают считаться как 0. Делам безопасный backfill из products.quantity.
      const pr = await query(`SELECT quantity FROM products WHERE id = $1`, [productId]);
      const q = pr.rows?.[0]?.quantity != null ? Math.max(0, parseInt(pr.rows[0].quantity, 10) || 0) : 0;
      try {
        await query(
          `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (product_id, warehouse_id) DO NOTHING`,
          [productId, warehouseId, q]
        );
      } catch {
        // ignore
      }
      return q;
    }
    return Math.max(0, parseInt(r.rows[0].quantity, 10) || 0);
  }

  async setWarehouseFreeStock(productId, warehouseId, quantity) {
    const q = Math.max(0, parseInt(quantity, 10) || 0);
    await query(
      `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [productId, warehouseId, q]
    );
  }

  /**
   * Обновить только остаток (quantity) товара
   * Используется для операций склада (поступление, списание и т.п.)
   */
  async updateQuantity(id, quantity) {
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    const q = quantity != null ? Math.max(0, Number(quantity) || 0) : 0;
    const wId = await this.getDefaultOwnWarehouseId();
    if (wId) {
      await this.setWarehouseFreeStock(numId, wId, q);
    } else {
      await query(
        'UPDATE products SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [q, numId]
      );
    }
  }

  /**
   * Обновить остаток и резерв (для операций reserve / unreserve)
   */
  async updateQuantityAndReserved(id, quantity, reservedQuantity) {
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    const q = quantity != null ? Math.max(0, Number(quantity) || 0) : 0;
    const reserved = reservedQuantity != null && !Number.isNaN(Number(reservedQuantity)) ? Math.max(0, Number(reservedQuantity)) : 0;
    const wId = await this.getDefaultOwnWarehouseId();
    if (wId) {
      await this.setWarehouseFreeStock(numId, wId, q);
    } else {
      await query(
        'UPDATE products SET quantity = $1, reserved_quantity = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [q, reserved, numId]
      );
      return;
    }
    await query(
      'UPDATE products SET reserved_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [reserved, numId]
    );
  }
  
  /**
   * Удалить товар
   */
  async delete(id) {
    const result = await query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }

  /**
   * Отправить товар в архив / вернуть из архива
   */
  async setArchived(id, isArchived) {
    const numId = typeof id === 'string' ? parseInt(id, 10) : Number(id);
    if (!Number.isFinite(numId) || numId < 1) return null;
    const flag = Boolean(isArchived);
    const result = await query(
      `UPDATE products
       SET is_archived = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, is_archived`,
      [numId, flag]
    );
    return result.rows[0] || null;
  }

  async findArchivedFlag(id) {
    const numId = typeof id === 'string' ? parseInt(id, 10) : Number(id);
    if (!Number.isFinite(numId) || numId < 1) return null;
    const result = await query('SELECT is_archived FROM products WHERE id = $1', [numId]);
    if (!result.rows.length) return null;
    return Boolean(result.rows[0].is_archived);
  }
  
  /**
   * Обновить себестоимость товара на основе данных поставщиков
   */
  async updateCostFromSupplierStocks(productId) {
    const numId = typeof productId === 'string' ? parseInt(productId, 10) : productId;
    const productRow = await query('SELECT product_type FROM products WHERE id = $1', [numId]);
    if (productRow.rows.length > 0 && productRow.rows[0].product_type === 'kit') {
      return null; // себестоимость комплекта считается по комплектующим
    }
    // Сначала проверяем, есть ли вообще записи в supplier_stocks для этого товара
    const checkResult = await query(
      `SELECT product_id, COUNT(*) as count, 
              ARRAY_AGG(price) FILTER (WHERE price IS NOT NULL) as prices
       FROM supplier_stocks 
       WHERE product_id = $1
       GROUP BY product_id`,
      [numId]
    );
    
    if (checkResult.rows.length === 0) {
      console.log(`[Products Repository] No supplier_stocks records found for product ${numId}`);
      return null;
    }
    
    const prices = checkResult.rows[0].prices || [];
    console.log(`[Products Repository] Found ${checkResult.rows[0].count} supplier_stocks records for product ${numId}, prices:`, prices);
    
    // Получаем минимальную цену от поставщиков
    // Используем CAST для надежного сравнения чисел (на случай если price хранится как текст)
    const stocksResult = await query(
      `SELECT 
        MIN(CASE 
          WHEN price IS NOT NULL AND CAST(price AS NUMERIC) > 0 
          THEN CAST(price AS NUMERIC) 
          ELSE NULL 
        END) as min_cost
      FROM supplier_stocks 
      WHERE product_id = $1`,
      [numId]
    );
    
    if (stocksResult.rows.length > 0 && stocksResult.rows[0].min_cost !== null) {
      const minCost = parseFloat(stocksResult.rows[0].min_cost);
      if (!isNaN(minCost) && minCost > 0) {
        // Обновляем cost в БД
        await query(
          `UPDATE products SET cost = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [minCost, numId]
        );
        console.log(`[Products Repository] ✓ Updated cost for product ${numId} to ${minCost}₽`);
        await this.recalcKitsContainingProduct(numId);
        return minCost;
      } else {
        console.log(`[Products Repository] Invalid min_cost value for product ${numId}: ${minCost}`);
      }
    } else {
      console.log(`[Products Repository] No valid prices (> 0) found in supplier_stocks for product ${numId}`);
    }
    
    return null;
  }
  
  /**
   * Можно ли импортировать/обновить товар от имени профиля (организация товара входит в профиль).
   * Без profileId — без ограничения (как общий API).
   */
  async isProductImportableByProfile(productId, profileId) {
    if (profileId == null || profileId === '') return true;
    const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    const prof =
      typeof profileId === 'string' ? parseInt(profileId, 10) : Number(profileId);
    if (!Number.isFinite(pid) || !Number.isFinite(prof)) return false;
    const result = await query(
      `SELECT 1 FROM products p
       WHERE p.id = $1
         AND p.organization_id IS NOT NULL
         AND p.organization_id IN (SELECT id FROM organizations WHERE profile_id = $2)
       LIMIT 1`,
      [pid, prof]
    );
    return result.rows.length > 0;
  }

  /**
   * Подсчитать общее количество товаров
   */
  async count(options = {}) {
    const { profileId } = options;
    let sql = 'SELECT COUNT(*) as total FROM products WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (options.brandId) {
      const bRaw = String(options.brandId).trim();
      if (/^\d+$/.test(bRaw)) {
        sql += ` AND brand_id = $${paramIndex++}`;
        params.push(bRaw);
      }
    }

    const catRaw = normalizeListCategoryId(options.categoryId);
    if (catRaw === FILTER_CATEGORY_NONE) {
      sql += ` AND user_category_id IS NULL`;
    } else if (catRaw && /^\d+$/.test(catRaw)) {
      sql += ` AND user_category_id = $${paramIndex++}`;
      params.push(catRaw);
    }

    if (options.organizationId != null && options.organizationId !== '') {
      const organizationId = options.organizationId;
      const orgNum = typeof organizationId === 'string' ? parseInt(organizationId, 10) : Number(organizationId);
      const orgVal = Number.isFinite(orgNum) ? orgNum : organizationId;
      const profNum =
        profileId != null && profileId !== ''
          ? typeof profileId === 'string'
            ? parseInt(profileId, 10)
            : Number(profileId)
          : NaN;
      const useProfileScope = Number.isFinite(profNum);
      if (useProfileScope) {
        sql += ` AND (
          organization_id = $${paramIndex}
          OR (
            organization_id IS NULL
            AND EXISTS (
              SELECT 1 FROM organizations o_filt
              WHERE o_filt.id = $${paramIndex + 1}
                AND o_filt.profile_id IS NOT NULL
                AND o_filt.profile_id = $${paramIndex + 2}
            )
          )
        )`;
        params.push(orgVal, orgVal, profNum);
        paramIndex += 3;
      } else {
        sql += ` AND organization_id = $${paramIndex++}`;
        params.push(orgVal);
      }
    }
    
    if (options.search) {
      const sp = `%${options.search}%`;
      sql += ` AND (
        name ILIKE $${paramIndex}
        OR sku ILIKE $${paramIndex}
        OR EXISTS (
          SELECT 1 FROM barcodes bc
          WHERE bc.product_id = products.id AND bc.barcode ILIKE $${paramIndex}
        )
        OR EXISTS (
          SELECT 1 FROM product_skus ps
          WHERE ps.product_id = products.id AND COALESCE(TRIM(ps.sku::text), '') ILIKE $${paramIndex}
        )
      )`;
      params.push(sp);
    }

    const ptCount =
      options.productType != null && String(options.productType).trim() !== ''
        ? String(options.productType).trim().toLowerCase()
        : '';
    if (ptCount === 'kit') {
      sql += ` AND LOWER(TRIM(COALESCE(product_type::text, ''))) = 'kit'`;
    } else if (ptCount === 'product') {
      sql += ` AND (product_type IS NULL OR LOWER(TRIM(COALESCE(product_type::text, ''))) <> 'kit')`;
    }
    
    const result = await query(sql, params);
    return parseInt(result.rows[0].total);
  }
}

export default new ProductsRepositoryPG();

