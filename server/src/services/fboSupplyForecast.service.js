/**
 * Прогнозирование поставок FBO: остатки WB по складам (FBW).
 */

import { query, transaction } from '../config/database.js';
import integrationsService from './integrations.service.js';
import { findAll as findAllMarketplaceCabinets } from '../repositories/marketplace_cabinets.repository.pg.js';
import {
  fetchWbWarehousesInventory,
  normalizeWbWarehouseInventoryItem,
} from './wbAnalytics.service.js';

const SYNC_COOLDOWN_MS = 20_000;
const INSERT_CHUNK = 400;

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
    SELECT ps.product_id, ps.sku, ps.mp_extra, p.name, p.sku AS article
    FROM product_skus ps
    JOIN products p ON p.id = ps.product_id
    WHERE ps.marketplace = 'wb'
      AND ($1::bigint IS NULL OR p.profile_id = $1)
    `,
    [pid]
  );

  const byNm = new Map();
  const byChrt = new Map();
  const byVendor = new Map();

  for (const row of r.rows || []) {
    const info = {
      productId: Number(row.product_id),
      name: row.name || null,
      article: row.article || null,
      sku: row.sku || null,
    };
    const sku = String(row.sku || '').trim();
    const extra = row.mp_extra && typeof row.mp_extra === 'object' ? row.mp_extra : {};
    const chrtExtra = extra.chrtId ?? extra.chrtID ?? extra.chrt_id;

    if (/^\d+$/.test(sku)) {
      if (!byNm.has(sku)) byNm.set(sku, info);
      if (!byChrt.has(sku)) byChrt.set(sku, info);
    } else if (sku) {
      byVendor.set(sku.toLowerCase(), info);
    }
    if (chrtExtra != null && String(chrtExtra).trim() !== '') {
      const c = String(chrtExtra).trim();
      if (!byChrt.has(c)) byChrt.set(c, info);
    }
  }

  return { byNm, byChrt, byVendor };
}

function resolveProduct(lookup, { nmId, chrtId, vendorCode }) {
  const nm = nmId != null ? String(nmId).trim() : '';
  const chrt = chrtId != null ? String(chrtId).trim() : '';
  const vc = vendorCode != null ? String(vendorCode).trim().toLowerCase() : '';
  if (chrt && lookup.byChrt.has(chrt)) return lookup.byChrt.get(chrt);
  if (nm && lookup.byNm.has(nm)) return lookup.byNm.get(nm);
  if (vc && lookup.byVendor.has(vc)) return lookup.byVendor.get(vc);
  return null;
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
        vendorByNm = await integrationsService.getWildberriesVendorCodeMapByNmIds(nmIds, pid);
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
  } = {}) {
    const pid = normalizeProfileId(profileId);
    const orgId = normalizeOrgId(organizationId);
    const snap = await getLatestSnapshot({ profileId: pid, organizationId: orgId });
    if (!snap) {
      return {
        syncedAt: null,
        snapshotId: null,
        rows: [],
        warehouses: [],
        totals: { quantity: 0, inWayToClient: 0, inWayFromClient: 0, rowCount: 0 },
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
        AND (
          $3::text IS NULL OR $3 = ''
          OR LOWER(COALESCE(r.wb_vendor_code, '')) LIKE '%' || $3 || '%'
          OR LOWER(COALESCE(r.external_sku, '')) LIKE '%' || $3 || '%'
          OR LOWER(COALESCE(p.name, '')) LIKE '%' || $3 || '%'
          OR LOWER(COALESCE(p.sku, '')) LIKE '%' || $3 || '%'
          OR LOWER(COALESCE(r.warehouse_name, '')) LIKE '%' || $3 || '%'
        )
        AND (
          $4::boolean IS NOT TRUE OR r.product_id IS NULL
        )
      ORDER BY
        COALESCE(p.sku, r.wb_vendor_code, r.external_sku),
        r.warehouse_name NULLS LAST,
        r.id
      `,
      [snap.id, Number.isFinite(whFilter) ? whFilter : null, q || null, !!unlinkedOnly]
    );

    const whR = await query(
      `
      SELECT DISTINCT warehouse_id, warehouse_name
      FROM wb_fbo_forecast_rows
      WHERE snapshot_id = $1 AND warehouse_id IS NOT NULL
      ORDER BY warehouse_name NULLS LAST, warehouse_id
      `,
      [snap.id]
    );

    const rows = (r.rows || []).map((row) => ({
      id: row.id,
      nmId: row.nm_id,
      chrtId: row.chrt_id,
      warehouseId: row.warehouse_id,
      warehouseName: row.warehouse_name,
      regionName: row.region_name,
      quantity: Number(row.quantity) || 0,
      inWayToClient: Number(row.in_way_to_client) || 0,
      inWayFromClient: Number(row.in_way_from_client) || 0,
      externalSku: row.external_sku,
      wbVendorCode: row.wb_vendor_code,
      productId: row.product_id,
      productName: row.product_name,
      productArticle: row.product_article,
      available: Math.max(0, Number(row.quantity) || 0),
    }));

    const totals = rows.reduce(
      (acc, row) => {
        acc.quantity += row.quantity;
        acc.inWayToClient += row.inWayToClient;
        acc.inWayFromClient += row.inWayFromClient;
        return acc;
      },
      { quantity: 0, inWayToClient: 0, inWayFromClient: 0, rowCount: rows.length }
    );

    return {
      syncedAt: snap.created_at,
      snapshotId: snap.id,
      rows,
      warehouses: (whR.rows || []).map((w) => ({
        id: w.warehouse_id,
        name: w.warehouse_name,
      })),
      totals,
      apiNote:
        'Данные WB обновляются примерно раз в 30 минут. «Резерв» = inWayToClient (в пути к клиенту).',
    };
  }
}

export default new FboSupplyForecastService();
