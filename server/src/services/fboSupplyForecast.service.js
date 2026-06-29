/**
 * Прогнозирование поставок FBO: остатки WB по складам (FBW).
 */

import { query, transaction } from '../config/database.js';
import integrationsService from './integrations.service.js';
import { findAll as findAllMarketplaceCabinets } from '../repositories/marketplace_cabinets.repository.pg.js';
import {
  fetchWbWarehousesInventory,
  fetchWbProductsOrdersCountMap,
  normalizeWbWarehouseInventoryItem,
} from './wbAnalytics.service.js';

const SYNC_COOLDOWN_MS = 20_000;
const INSERT_CHUNK = 400;
const ORDERS_COUNT_CACHE_MS = 10 * 60 * 1000;
const ordersCountCache = new Map();

function normalizeWbLinkKey(value) {
  return String(value ?? '')
    .trim()
    .replace(/;+$/g, '')
    .toLowerCase();
}

function trailingDigits(value) {
  const m = String(value ?? '').match(/([0-9]{5,})$/);
  return m ? m[1] : null;
}

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

function normalizeOrgId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function resolveWbApiKey({ profileId, organizationId }) {
  const orgId = normalizeOrgId(organizationId);
  const pid = normalizeProfileId(profileId);
  if (orgId) {
    const cabinets = await findAllMarketplaceCabinets(orgId).catch(() => []);
    const wb = (cabinets || []).find(
      (c) => String(c?.marketplace_type).toLowerCase() === 'wildberries' && c?.is_active
    );
    const key = wb?.config?.api_key ?? wb?.config?.apiKey;
    if (key) return String(key).trim();
  }
  const cfg = await integrationsService.getMarketplaceConfig('wildberries', {
    profileId: pid,
    organizationId: orgId,
  });
  const key = cfg?.api_key ?? cfg?.apiKey;
  if (!key) {
    const err = new Error(
      'Не настроен API-ключ Wildberries. Укажите токен с доступом «Аналитика» в интеграции или кабинете организации.'
    );
    err.statusCode = 400;
    throw err;
  }
  return String(key).trim();
}

async function buildWbProductLookup(profileId) {
  const pid = normalizeProfileId(profileId);
  const r = await query(
    `
    SELECT DISTINCT ON (p.id)
      p.id AS product_id,
      COALESCE(ps.sku, '') AS sku,
      ps.mp_extra,
      p.name,
      p.sku AS article,
      p.mp_wb_vendor_code,
      TRIM(
        COALESCE(
          p.wb_draft::jsonb->>'nmId',
          p.wb_draft::jsonb->>'nmID',
          p.wb_draft::jsonb->>'nm_id',
          ''
        )
      ) AS wb_nm_id
    FROM products p
    LEFT JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'wb'
    WHERE ($1::bigint IS NULL OR p.profile_id = $1)
      AND (
        ps.id IS NOT NULL
        OR NULLIF(TRIM(p.mp_wb_vendor_code), '') IS NOT NULL
        OR NULLIF(
          TRIM(
            COALESCE(
              p.wb_draft::jsonb->>'nmId',
              p.wb_draft::jsonb->>'nmID',
              p.wb_draft::jsonb->>'nm_id',
              ''
            )
          ),
          ''
        ) IS NOT NULL
      )
    ORDER BY p.id, ps.id NULLS LAST
    `,
    [pid]
  );

  const byNm = new Map();
  const byChrt = new Map();
  const byVendor = new Map();
  const byArticle = new Map();
  const byNmChrt = new Map();

  const put = (map, key, info) => {
    const k = key != null ? String(key).trim() : '';
    if (!k || map.has(k)) return;
    map.set(k, info);
  };

  const putVendor = (raw, info) => {
    const key = normalizeWbLinkKey(raw);
    if (key) put(byVendor, key, info);
  };

  for (const row of r.rows || []) {
    const info = {
      productId: Number(row.product_id),
      name: row.name || null,
      article: row.article || null,
      sku: row.sku || null,
    };
    const sku = String(row.sku || '')
      .trim()
      .replace(/;+$/g, '');
    const article = String(row.article || '')
      .trim()
      .replace(/;+$/g, '');
    const mpVendor = String(row.mp_wb_vendor_code || '')
      .trim()
      .replace(/;+$/g, '');
    const extra = row.mp_extra && typeof row.mp_extra === 'object' ? row.mp_extra : {};
    const chrtExtra = extra.chrtId ?? extra.chrtID ?? extra.chrt_id;
    const wbNmId = String(row.wb_nm_id || '').trim();

    if (wbNmId && /^\d+$/.test(wbNmId)) {
      put(byNm, wbNmId, info);
    }

    if (/^\d+$/.test(sku)) {
      put(byNm, sku, info);
      put(byChrt, sku, info);
    } else if (sku) {
      putVendor(sku, info);
      const tail = trailingDigits(sku);
      if (tail) put(byNm, tail, info);
    }

    if (mpVendor) {
      putVendor(mpVendor, info);
    }

    if (article) {
      put(byArticle, normalizeWbLinkKey(article), info);
      const tail = trailingDigits(article);
      if (tail) put(byNm, tail, info);
    }

    if (chrtExtra != null && String(chrtExtra).trim() !== '') {
      put(byChrt, String(chrtExtra).trim(), info);
      if (wbNmId) {
        put(byNmChrt, `${wbNmId}:${String(chrtExtra).trim()}`, info);
      }
    }
  }

  return { byNm, byChrt, byVendor, byArticle, byNmChrt };
}

function resolveProduct(lookup, { nmId, chrtId, vendorCode, externalSku }) {
  const nm = nmId != null ? String(nmId).trim() : '';
  const chrt = chrtId != null ? String(chrtId).trim() : '';
  const vc = normalizeWbLinkKey(vendorCode);
  const ext = externalSku != null ? String(externalSku).trim() : '';
  const extNm = ext.includes(':') ? ext.split(':')[0].trim() : ext;
  const extChrt = ext.includes(':') ? ext.split(':').slice(1).join(':').trim() : '';

  const nmKey = nm || (/^\d+$/.test(extNm) ? extNm : '');
  const chrtKey = chrt || (/^\d+$/.test(extChrt) ? extChrt : '');

  if (nmKey && chrtKey) {
    const composite = `${nmKey}:${chrtKey}`;
    if (lookup.byNmChrt.has(composite)) return lookup.byNmChrt.get(composite);
  }
  if (chrtKey && lookup.byChrt.has(chrtKey)) return lookup.byChrt.get(chrtKey);
  if (nmKey && lookup.byNm.has(nmKey)) return lookup.byNm.get(nmKey);
  if (vc && lookup.byVendor.has(vc)) return lookup.byVendor.get(vc);
  if (vc && lookup.byArticle.has(vc)) return lookup.byArticle.get(vc);
  return null;
}

async function resolveMissingWbVendorCodes(rows, { profileId, organizationId } = {}) {
  const missing = [
    ...new Set(
      rows
        .filter((row) => !row.productId && !row.wbVendorCode && row.nmId != null)
        .map((row) => String(row.nmId).trim())
        .filter((nm) => nm !== '' && /^\d+$/.test(nm))
    ),
  ];
  if (missing.length === 0) return new Map();
  try {
    return await integrationsService.getWildberriesVendorCodeMapByNmIds(missing, {
      profileId: normalizeProfileId(profileId),
      organizationId: normalizeOrgId(organizationId),
    });
  } catch {
    return new Map();
  }
}

function enrichForecastRow(row, lookup, vendorOverride = null) {
  const wbVendorCode =
    vendorOverride != null && String(vendorOverride).trim() !== ''
      ? String(vendorOverride).trim()
      : row.wb_vendor_code ?? row.wbVendorCode ?? null;
  const product = resolveProduct(lookup, {
    nmId: row.nm_id ?? row.nmId,
    chrtId: row.chrt_id ?? row.chrtId,
    vendorCode: wbVendorCode,
    externalSku: row.external_sku ?? row.externalSku,
  });
  const productId = product?.productId ?? (row.product_id != null ? Number(row.product_id) : null);
  const productName = product?.name ?? row.product_name ?? null;
  const productArticle = product?.article ?? row.product_article ?? null;
  return {
    id: row.id,
    nmId: row.nm_id ?? row.nmId,
    chrtId: row.chrt_id ?? row.chrtId,
    warehouseId: row.warehouse_id ?? row.warehouseId,
    warehouseName: row.warehouse_name ?? row.warehouseName,
    regionName: row.region_name ?? row.regionName,
    quantity: Number(row.quantity) || 0,
    inWayToClient: Number(row.in_way_to_client ?? row.inWayToClient) || 0,
    inWayFromClient: Number(row.in_way_from_client ?? row.inWayFromClient) || 0,
    externalSku: row.external_sku ?? row.externalSku,
    wbVendorCode,
    productId: Number.isFinite(productId) ? productId : null,
    productName,
    productArticle,
    available: Math.max(0, Number(row.quantity) || 0),
  };
}

function rowMatchesSearch(row, q) {
  if (!q) return true;
  const hay = [
    row.wbVendorCode,
    row.externalSku,
    row.productName,
    row.productArticle,
    row.warehouseName,
  ]
    .map((v) => (v != null ? String(v).toLowerCase() : ''))
    .join(' ');
  return hay.includes(q);
}

function normalizePlanDays(v) {
  const n = toInt(v);
  if (n === 60 || n === 90) return n;
  return 30;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

async function buildErmWbOrderCounts(profileId, planDays) {
  const pid = normalizeProfileId(profileId);
  const days = normalizePlanDays(planDays);
  const r = await query(
    `
    SELECT
      NULLIF(TRIM(CAST(o.marketplace_sku AS TEXT)), '') AS nm_id,
      o.product_id,
      LOWER(TRIM(COALESCE(o.offer_id, ''))) AS offer_id,
      CASE
        WHEN TRIM(COALESCE(o.delivery_address, '')) ~ '^[0-9]+'
          THEN (regexp_match(TRIM(o.delivery_address), '^([0-9]+)'))[1]
        ELSE NULL
      END AS warehouse_id,
      SUM(o.quantity)::int AS order_qty
    FROM orders o
    WHERE o.marketplace = 'wb'
      AND ($1::bigint IS NULL OR o.profile_id = $1)
      AND o.created_at >= NOW() - ($2::int || ' days')::interval
      AND COALESCE(LOWER(TRIM(o.status)), '') NOT IN ('cancelled', 'canceled', 'cancel')
    GROUP BY 1, 2, 3, 4
    `,
    [pid, days]
  );

  const byNm = new Map();
  const byNmWh = new Map();
  const byProduct = new Map();
  const byOffer = new Map();

  for (const row of r.rows || []) {
    const qty = toInt(row.order_qty);
    if (qty <= 0) continue;
    const nm = row.nm_id != null ? String(row.nm_id).trim() : '';
    const wh = row.warehouse_id != null ? String(row.warehouse_id).trim() : '';
    const pidNum = row.product_id != null ? Number(row.product_id) : NaN;
    const offer = row.offer_id != null ? String(row.offer_id).trim() : '';

    if (nm) {
      byNm.set(nm, (byNm.get(nm) || 0) + qty);
      if (wh) {
        const k = `${nm}:${wh}`;
        byNmWh.set(k, (byNmWh.get(k) || 0) + qty);
      }
    }
    if (Number.isFinite(pidNum)) {
      byProduct.set(pidNum, (byProduct.get(pidNum) || 0) + qty);
    }
    if (offer) {
      byOffer.set(offer, (byOffer.get(offer) || 0) + qty);
    }
  }

  return { byNm, byNmWh, byProduct, byOffer };
}

async function getWbOrdersCountMap({ profileId, organizationId, planDays }) {
  const pid = normalizeProfileId(profileId);
  const orgId = normalizeOrgId(organizationId);
  const days = normalizePlanDays(planDays);
  const cacheKey = `${pid ?? 'all'}:${orgId ?? ''}:${days}`;
  const cached = ordersCountCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ORDERS_COUNT_CACHE_MS) {
    return cached.map;
  }

  let map = new Map();
  try {
    const apiKey = await resolveWbApiKey({ profileId: pid, organizationId: orgId });
    map = await fetchWbProductsOrdersCountMap(apiKey, days);
  } catch {
    map = new Map();
  }
  ordersCountCache.set(cacheKey, { at: Date.now(), map });
  return map;
}

function resolveRowOrdersCount(row, { wbByNm, erm }) {
  const nm = row.nmId != null ? String(row.nmId).trim() : '';
  const wh = row.warehouseId != null ? String(row.warehouseId).trim() : '';
  const vendor = normalizeWbLinkKey(row.wbVendorCode);
  const productId = row.productId != null ? Number(row.productId) : NaN;

  if (nm && wh && erm.byNmWh.has(`${nm}:${wh}`)) {
    return erm.byNmWh.get(`${nm}:${wh}`);
  }
  if (nm && wbByNm.has(nm)) return wbByNm.get(nm);
  if (nm && erm.byNm.has(nm)) return erm.byNm.get(nm);
  if (Number.isFinite(productId) && erm.byProduct.has(productId)) {
    return erm.byProduct.get(productId);
  }
  if (vendor && erm.byOffer.has(vendor)) return erm.byOffer.get(vendor);
  return 0;
}

async function getLatestSnapshot({ profileId, organizationId }) {
  const pid = normalizeProfileId(profileId);
  const orgId = normalizeOrgId(organizationId);
  const r = await query(
    `
    SELECT id, profile_id, organization_id, created_at, row_count, notes
    FROM wb_fbo_forecast_snapshots
    WHERE ($1::bigint IS NULL OR profile_id = $1)
      AND ($2::bigint IS NULL OR organization_id = $2)
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [pid, orgId]
  );
  return r.rows?.[0] || null;
}

async function insertForecastRows(snapshotId, rows, client = null) {
  const sid = Number(snapshotId);
  if (!Number.isFinite(sid) || sid < 1 || !rows.length) return 0;
  const run = client?.query ? client.query.bind(client) : query;

  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const params = [];
    const placeholders = [];
    let p = 1;
    for (const row of chunk) {
      params.push(
        sid,
        row.nmId,
        row.chrtId,
        row.warehouseId,
        row.warehouseName,
        row.regionName,
        row.quantity,
        row.inWayToClient,
        row.inWayFromClient,
        row.externalSku,
        row.wbVendorCode,
        row.productId
      );
      placeholders.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
      );
    }
    const res = await run(
      `INSERT INTO wb_fbo_forecast_rows (
        snapshot_id, nm_id, chrt_id, warehouse_id, warehouse_name, region_name,
        quantity, in_way_to_client, in_way_from_client, external_sku, wb_vendor_code, product_id
      ) VALUES ${placeholders.join(', ')}`,
      params
    );
    inserted += res.rowCount || 0;
  }
  return inserted;
}

class FboSupplyForecastService {
  async syncWb({ profileId, organizationId } = {}) {
    const pid = normalizeProfileId(profileId);
    const orgId = normalizeOrgId(organizationId);

    const latest = await getLatestSnapshot({ profileId: pid, organizationId: orgId });
    if (latest?.created_at) {
      const age = Date.now() - new Date(latest.created_at).getTime();
      if (age < SYNC_COOLDOWN_MS) {
        const waitSec = Math.ceil((SYNC_COOLDOWN_MS - age) / 1000);
        const err = new Error(`Подождите ${waitSec} с перед повторным обновлением (лимит API WB).`);
        err.statusCode = 429;
        err.retryAfterSec = waitSec;
        throw err;
      }
    }

    const apiKey = await resolveWbApiKey({ profileId: pid, organizationId: orgId });
    const rawItems = await fetchWbWarehousesInventory(apiKey);
    const list = Array.isArray(rawItems) ? rawItems : [];

    const nmIds = [
      ...new Set(
        list
          .map((row) => {
            const n = row?.nmId ?? row?.nmID;
            return n != null && String(n).trim() !== '' ? String(n).trim() : null;
          })
          .filter(Boolean)
      ),
    ];
    let vendorByNm = new Map();
    if (nmIds.length > 0) {
      try {
        vendorByNm = await integrationsService.getWildberriesVendorCodeMapByNmIds(nmIds, {
          profileId: pid,
          organizationId: orgId,
        });
      } catch {
        vendorByNm = new Map();
      }
    }

    const lookup = await buildWbProductLookup(pid);
    const rows = [];
    for (const it of list) {
      const norm = normalizeWbWarehouseInventoryItem(it);
      if (!norm.externalSku) continue;
      if (
        norm.quantity === 0 &&
        norm.inWayToClient === 0 &&
        norm.inWayFromClient === 0
      ) {
        continue;
      }
      const nmKey = norm.nmId != null ? String(norm.nmId) : '';
      const vendorRaw = nmKey ? vendorByNm.get(nmKey) : null;
      const wbVendorCode =
        vendorRaw != null && String(vendorRaw).trim() !== '' ? String(vendorRaw).trim() : null;
      const product = resolveProduct(lookup, {
        nmId: norm.nmId,
        chrtId: norm.chrtId,
        vendorCode: wbVendorCode,
        externalSku: norm.externalSku,
      });
      rows.push({
        ...norm,
        wbVendorCode,
        productId: product?.productId ?? null,
        productName: product?.name ?? null,
        productArticle: product?.article ?? null,
      });
    }

    const snapshotId = await transaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO wb_fbo_forecast_snapshots (profile_id, organization_id, row_count, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [pid, orgId, rows.length, 'wb stocks-report/wb-warehouses']
      );
      const sid = ins.rows[0].id;
      await insertForecastRows(sid, rows, client);
      return sid;
    });

    return {
      snapshotId,
      rowCount: rows.length,
      syncedAt: new Date().toISOString(),
      apiNote:
        'Данные WB обновляются примерно раз в 30 минут. «Резерв» = inWayToClient (в пути к клиенту).',
    };
  }

  async getWbForecast({
    profileId,
    organizationId,
    warehouseId = null,
    search = null,
    unlinkedOnly = false,
    planDays = 30,
  } = {}) {
    const pid = normalizeProfileId(profileId);
    const orgId = normalizeOrgId(organizationId);
    const periodDays = normalizePlanDays(planDays);
    const snap = await getLatestSnapshot({ profileId: pid, organizationId: orgId });
    if (!snap) {
      return {
        syncedAt: null,
        snapshotId: null,
        planDays: periodDays,
        rows: [],
        warehouses: [],
        totals: {
          quantity: 0,
          inWayToClient: 0,
          inWayFromClient: 0,
          ordersCount: 0,
          rowCount: 0,
        },
        apiNote:
          'Нажмите «Обновить с WB», чтобы загрузить остатки по складам FBO. Нужен токен WB с категорией «Аналитика».',
      };
    }

    const whFilter =
      warehouseId != null && String(warehouseId).trim() !== ''
        ? Number(warehouseId)
        : null;
    const q = search != null ? String(search).trim().toLowerCase() : '';

    const r = await query(
      `
      SELECT
        r.id,
        r.nm_id,
        r.chrt_id,
        r.warehouse_id,
        r.warehouse_name,
        r.region_name,
        r.quantity,
        r.in_way_to_client,
        r.in_way_from_client,
        r.external_sku,
        r.wb_vendor_code,
        r.product_id,
        p.name AS product_name,
        p.sku AS product_article
      FROM wb_fbo_forecast_rows r
      LEFT JOIN products p ON p.id = r.product_id
      WHERE r.snapshot_id = $1
        AND ($2::bigint IS NULL OR r.warehouse_id = $2)
      ORDER BY
        COALESCE(r.wb_vendor_code, r.external_sku),
        r.warehouse_name NULLS LAST,
        r.id
      `,
      [snap.id, Number.isFinite(whFilter) ? whFilter : null]
    );

    const lookup = await buildWbProductLookup(pid);
    let rows = (r.rows || []).map((row) => enrichForecastRow(row, lookup));
    const vendorByNm = await resolveMissingWbVendorCodes(rows, {
      profileId: pid,
      organizationId: orgId,
    });
    if (vendorByNm.size > 0) {
      rows = rows.map((row) => {
        if (row.productId || row.wbVendorCode || row.nmId == null) return row;
        const vendor = vendorByNm.get(String(row.nmId).trim());
        if (!vendor) return row;
        return enrichForecastRow(
          {
            ...row,
            nm_id: row.nmId,
            chrt_id: row.chrtId,
            external_sku: row.externalSku,
            wb_vendor_code: vendor,
            product_id: null,
            product_name: null,
            product_article: null,
          },
          lookup,
          vendor
        );
      });
    }
    if (q) {
      rows = rows.filter((row) => rowMatchesSearch(row, q));
    }
    if (unlinkedOnly) {
      rows = rows.filter((row) => !row.productId);
    }

    const [wbByNm, erm] = await Promise.all([
      getWbOrdersCountMap({ profileId: pid, organizationId: orgId, planDays: periodDays }),
      buildErmWbOrderCounts(pid, periodDays),
    ]);
    rows = rows.map((row) => ({
      ...row,
      ordersCount: resolveRowOrdersCount(row, { wbByNm, erm }),
    }));

    const whR = await query(
      `
      SELECT DISTINCT warehouse_id, warehouse_name
      FROM wb_fbo_forecast_rows
      WHERE snapshot_id = $1 AND warehouse_id IS NOT NULL
      ORDER BY warehouse_name NULLS LAST, warehouse_id
      `,
      [snap.id]
    );

    const totals = rows.reduce(
      (acc, row) => {
        acc.quantity += row.quantity;
        acc.inWayToClient += row.inWayToClient;
        acc.inWayFromClient += row.inWayFromClient;
        acc.ordersCount += row.ordersCount || 0;
        return acc;
      },
      { quantity: 0, inWayToClient: 0, inWayFromClient: 0, ordersCount: 0, rowCount: rows.length }
    );

    return {
      syncedAt: snap.created_at,
      snapshotId: snap.id,
      planDays: periodDays,
      rows,
      warehouses: (whR.rows || []).map((w) => ({
        id: w.warehouse_id,
        name: w.warehouse_name,
      })),
      totals,
      apiNote:
        `Данные WB обновляются примерно раз в 30 минут. «Резерв» = inWayToClient (в пути к клиенту). «Заказы» — за ${periodDays} дн. (аналитика WB и заказы в ERM).`,
    };
  }
}

export default new FboSupplyForecastService();
