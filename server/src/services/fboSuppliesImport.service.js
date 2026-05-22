/**
 * Импорт поставок FBO: Excel и API маркетплейсов (preview + confirm).
 */

import ExcelJS from 'exceljs';
import { query } from '../config/database.js';
import integrationsService from './integrations.service.js';
import fboSuppliesService from './fboSupplies.service.js';
import { getFetchProxyAgent } from '../utils/fetchAgent.js';
import { getYandexHttpsAgent, formatYandexNetworkError } from '../utils/yandex-https-agent.js';

const WB_SUPPLIES_API = 'https://supplies-api.wildberries.ru';
const YM_API = 'https://api.partner.market.yandex.ru';

const SUPPLIES_SHEET = 'Поставки';
const ITEMS_SHEET = 'Товары';

function normalizeCellValue(cell) {
  if (!cell) return '';
  let v = cell.value;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) {
    const d = v;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'object') {
    if (v.richText && Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return normalizeCellValue({ value: v.result });
  }
  return String(v).trim();
}

function rowToObject(worksheet, rowNum, keyRow) {
  const row = worksheet.getRow(rowNum);
  const obj = {};
  keyRow.eachCell({ includeEmpty: true }, (cell, col) => {
    const key = normalizeCellValue(cell).toLowerCase().replace(/\s+/g, '_');
    if (!key) return;
    obj[key] = normalizeCellValue(row.getCell(col));
  });
  return obj;
}

function findKeyRow(worksheet) {
  for (let r = 1; r <= Math.min(5, worksheet.rowCount || 5); r++) {
    const row = worksheet.getRow(r);
    const vals = [];
    row.eachCell({ includeEmpty: false }, (c) => vals.push(normalizeCellValue(c).toLowerCase()));
    const joined = vals.join('|');
    if (joined.includes('номер_отгрузки') || joined.includes('external_shipment_number')) {
      return row;
    }
  }
  return worksheet.getRow(1);
}

async function resolveProductId({ sku, barcode, profileId }) {
  const pid = profileId != null ? Number(profileId) : null;
  const b = barcode != null ? String(barcode).trim() : '';
  const s = sku != null ? String(sku).trim() : '';
  if (b) {
    const r = await query(
      `SELECT p.id
       FROM products p
       WHERE ($1::bigint IS NULL OR p.profile_id = $1)
         AND EXISTS (
           SELECT 1 FROM unnest(COALESCE(p.barcodes, ARRAY[]::text[])) AS bc
           WHERE TRIM(bc) = $2
         )
       LIMIT 1`,
      [pid, b]
    );
    if (r.rows?.[0]?.id) return r.rows[0].id;
  }
  if (s) {
    const r = await query(
      `SELECT p.id
       FROM products p
       LEFT JOIN product_skus ps ON ps.product_id = p.id AND TRIM(ps.sku) = $2
       WHERE ($1::bigint IS NULL OR p.profile_id = $1)
         AND (TRIM(p.sku) = $2 OR ps.id IS NOT NULL)
       LIMIT 1`,
      [pid, s]
    );
    if (r.rows?.[0]?.id) return r.rows[0].id;
  }
  return null;
}

async function resolveOrganizationId({ organizationName, organizationId, profileId }) {
  if (organizationId != null && organizationId !== '') {
    const oid = Number(organizationId);
    if (!Number.isNaN(oid)) return oid;
  }
  const name = organizationName != null ? String(organizationName).trim() : '';
  if (!name) return null;
  const r = await query(
    `SELECT id FROM organizations
     WHERE ($1::bigint IS NULL OR profile_id = $1) AND TRIM(name) ILIKE $2
     LIMIT 1`,
    [profileId != null ? Number(profileId) : null, name]
  );
  return r.rows?.[0]?.id ?? null;
}

function mapOzonStateToStatus(state) {
  const s = String(state || '').toLowerCase();
  if (s.includes('cancel') || s.includes('return')) return 'return';
  if (s.includes('complete') || s.includes('closed') || s.includes('accepted')) return 'closed';
  if (s.includes('shipped') || s.includes('transit') || s.includes('delivering')) return 'shipped';
  if (s.includes('ready') || s.includes('awaiting')) return 'ready_for_supply';
  if (s.includes('pack')) return 'packed';
  if (s.includes('assembl')) return 'assembled';
  return 'new';
}

function normalizeMarketplaceImport(raw) {
  const m = String(raw || 'ozon').toLowerCase().trim();
  if (m.includes('wild') || m === 'wb') return 'wb';
  if (m.includes('яндекс') || m.includes('yandex') || m === 'ym') return 'ym';
  return 'ozon';
}

function wbAuthHeader(apiKey) {
  const raw = String(apiKey || '').trim();
  if (!raw) return '';
  const tokenClean =
    typeof integrationsService?._normalizeWbToken === 'function'
      ? integrationsService._normalizeWbToken(raw)
      : raw.replace(/\s+/g, '').replace(/\uFEFF/g, '').trim();
  return tokenClean.toLowerCase().startsWith('bearer ') ? tokenClean : `Bearer ${tokenClean}`;
}

function ymAuthHeader(apiKey) {
  const raw = String(apiKey || '').trim();
  if (!raw) return '';
  return raw.toLowerCase().startsWith('api-key ') ? raw : `Api-Key ${raw}`;
}

async function wbFbwRequest(path, { apiKey, method = 'GET', body = null } = {}) {
  const auth = wbAuthHeader(apiKey);
  if (!auth) {
    const err = new Error('Не настроен API-ключ Wildberries (категория «Поставки»)');
    err.statusCode = 400;
    throw err;
  }
  const agent = getFetchProxyAgent();
  const url = path.startsWith('http') ? path : `${WB_SUPPLIES_API}${path.startsWith('/') ? path : `/${path}`}`;
  const opts = {
    method,
    headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(agent && { agent }),
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const response = await fetch(url, opts);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`Wildberries FBW API ${response.status}${text ? `: ${text.substring(0, 200)}` : ''}`);
    err.statusCode = response.status === 401 || response.status === 403 ? 400 : 502;
    throw err;
  }
  return response.json().catch(() => ({}));
}

async function ymRequest(path, { apiKey, method = 'GET', body = null } = {}) {
  const auth = ymAuthHeader(apiKey);
  if (!auth) {
    const err = new Error('Не настроен API-ключ Яндекс.Маркета');
    err.statusCode = 400;
    throw err;
  }
  const agent = getYandexHttpsAgent();
  const url = path.startsWith('http') ? path : `${YM_API}${path.startsWith('/') ? path : `/${path}`}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(agent && { agent }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new Error(formatYandexNetworkError(e, url));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`Яндекс.Маркет API ${response.status}${text ? `: ${text.substring(0, 200)}` : ''}`);
    err.statusCode = response.status === 401 || response.status === 403 ? 400 : 502;
    throw err;
  }
  return response.json().catch(() => ({}));
}

function mapWbStateToStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (s.includes('cancel') || s.includes('reject')) return 'return';
  if (s.includes('complete') || s.includes('accept') || s.includes('done')) return 'closed';
  if (s.includes('transit') || s.includes('deliver') || s.includes('shipped')) return 'shipped';
  if (s.includes('ready') || s.includes('await')) return 'ready_for_supply';
  if (s.includes('pack')) return 'packed';
  if (s.includes('assembl')) return 'assembled';
  return 'new';
}

function mapYmStateToStatus(status) {
  const s = String(status ?? '').toUpperCase();
  if (s.includes('CANCEL') || s.includes('REJECT')) return 'return';
  if (s.includes('FINISH') || s.includes('COMPLET') || s.includes('ACCEPT')) return 'closed';
  if (s.includes('TRANSIT') || s.includes('DELIVER') || s.includes('SHIPPED')) return 'shipped';
  if (s.includes('READY') || s.includes('PREPAR')) return 'ready_for_supply';
  if (s.includes('PACK')) return 'packed';
  return 'new';
}

function parseDateOnly(v) {
  if (!v) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const dm = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dm) return `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

class FboSuppliesImportService {
  async parseExcelBuffer(buffer, { profileId } = {}) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const suppliesWs = wb.getWorksheet(SUPPLIES_SHEET) || wb.worksheets[0];
    const itemsWs = wb.getWorksheet(ITEMS_SHEET) || wb.worksheets[1];
    if (!suppliesWs) {
      const err = new Error('Лист «Поставки» не найден в файле Excel');
      err.statusCode = 400;
      throw err;
    }

    const suppliesKeyRow = findKeyRow(suppliesWs);
    const supplies = [];
    const startRow = suppliesKeyRow.number + 1;
    for (let r = startRow; r <= (suppliesWs.rowCount || 0); r++) {
      const raw = rowToObject(suppliesWs, r, suppliesKeyRow);
      const externalNumber =
        raw.external_shipment_number ||
        raw.номер_отгрузки ||
        raw.внешний_номер ||
        raw.shipment_number;
      if (!externalNumber) continue;
      const orgId = await resolveOrganizationId({
        organizationName: raw.organization || raw.организация || raw.organization_name,
        organizationId: raw.organization_id || raw.организация_id,
        profileId,
      });
      supplies.push({
        importKey: `excel:${externalNumber}`,
        marketplace: normalizeMarketplaceImport(raw.marketplace || raw.маркетплейс),
        name: raw.name || raw.название || null,
        readyAt: parseDateOnly(raw.ready_at || raw.дата_готовности || raw.дата_отгрузки),
        marketplaceWarehouseName: raw.marketplace_warehouse || raw.склад_маркетплейса || raw.склад || null,
        externalShipmentNumber: String(externalNumber),
        deductionWarehouseId: raw.deduction_warehouse_id || raw.склад_списания_id || null,
        organizationId: orgId,
        deductStock: ['1', 'true', 'да', 'yes'].includes(String(raw.deduct_stock || raw.списать_остатки || '').toLowerCase()),
        items: [],
        alreadyImported: false,
      });
    }

    const byNumber = new Map(supplies.map((s) => [s.externalShipmentNumber, s]));

    if (itemsWs) {
      const itemsKeyRow = findKeyRow(itemsWs);
      for (let r = itemsKeyRow.number + 1; r <= (itemsWs.rowCount || 0); r++) {
        const raw = rowToObject(itemsWs, r, itemsKeyRow);
        const ext =
          raw.external_shipment_number || raw.номер_отгрузки || raw.внешний_номер || raw.shipment_number;
        const qty = parseInt(raw.quantity || raw.количество || '0', 10);
        if (!ext || !qty || qty <= 0) continue;
        const supply = byNumber.get(String(ext));
        if (!supply) continue;
        const sku = raw.sku || raw.артикул || null;
        const barcode = raw.barcode || raw.штрихкод || raw.штрих_код || null;
        const productId = await resolveProductId({ sku, barcode, profileId });
        supply.items.push({
          productId,
          quantity: qty,
          sku,
          barcode,
          name: raw.name || raw.название || null,
          unresolved: productId == null,
        });
      }
    }

    const existing = await fboSuppliesService.findExistingExternalNumbers(
      supplies.map((s) => ({ marketplace: s.marketplace, externalShipmentNumber: s.externalShipmentNumber })),
      { profileId }
    );
    for (const s of supplies) {
      const key = `${s.marketplace}:${s.externalShipmentNumber}`;
      s.alreadyImported = existing.has(key);
    }

    return supplies.filter((s) => s.items.length > 0 || s.externalShipmentNumber);
  }

  async fetchOzonPreview({ profileId, organizationId, daysBack = 90 } = {}) {
    const since = new Date();
    since.setDate(since.getDate() - Math.max(1, Math.min(365, Number(daysBack) || 90)));
    const listBody = {
      filter: {
        since: since.toISOString(),
        to: new Date().toISOString(),
      },
      paging: { limit: 100, offset: 0 },
    };

    let listData;
    try {
      listData = await integrationsService._ozonApiPost('/v2/supply-order/list', listBody, { profileId });
    } catch (e) {
      try {
        listData = await integrationsService._ozonApiPost('/v3/supply-order/list', { ...listBody, limit: 100, offset: 0 }, { profileId });
      } catch (e2) {
        const err = new Error(e?.message || 'Не удалось получить список поставок Ozon');
        err.statusCode = 400;
        throw err;
      }
    }

    const orders =
      listData?.result?.supply_orders ||
      listData?.result?.orders ||
      listData?.supply_orders ||
      listData?.orders ||
      [];

    const candidates = [];
    for (const order of orders) {
      const supplyOrderId = order.supply_order_id ?? order.id ?? order.order_id;
      const externalNumber = String(
        order.supply_order_number ?? order.order_number ?? order.external_number ?? supplyOrderId ?? ''
      ).trim();
      if (!externalNumber) continue;

      let items = [];
      const bundleId = order.bundle_id ?? order.bundle_ids?.[0];
      if (bundleId) {
        try {
          const bundleData = await integrationsService._ozonApiPost(
            '/v1/supply-order/bundle',
            { bundle_ids: [String(bundleId)], limit: 500 },
            { profileId }
          );
          const rows =
            bundleData?.result?.items ||
            bundleData?.items ||
            bundleData?.result?.products ||
            [];
          for (const row of rows) {
            const qty = parseInt(row.quantity ?? row.count ?? row.amount ?? 0, 10);
            if (!qty || qty <= 0) continue;
            const offerId = row.offer_id ?? row.sku ?? null;
            const barcode = row.barcode ?? row.bar_code ?? null;
            const productId = await resolveProductId({
              sku: offerId,
              barcode,
              profileId,
            });
            items.push({
              productId,
              quantity: qty,
              sku: offerId,
              barcode,
              mpOfferId: offerId,
              mpProductId: row.product_id != null ? String(row.product_id) : null,
              name: row.name ?? row.product_name ?? null,
              unresolved: productId == null,
            });
          }
        } catch {
          items = [];
        }
      }

      const wh = order.warehouse ?? order.warehouse_info ?? {};
      candidates.push({
        importKey: `ozon:${externalNumber}`,
        marketplace: 'ozon',
        name: order.name ?? order.supply_order_number ?? `Ozon ${externalNumber}`,
        readyAt: parseDateOnly(
          order.timeslot?.timeslot?.from ??
            order.delivery_date ??
            order.planned_date ??
            order.created_at
        ),
        marketplaceWarehouseName: wh.name ?? order.warehouse_name ?? null,
        marketplaceWarehouseId: wh.warehouse_id != null ? String(wh.warehouse_id) : null,
        externalShipmentNumber: externalNumber,
        externalSupplyId: supplyOrderId != null ? String(supplyOrderId) : null,
        deductionWarehouseId: null,
        organizationId: organizationId != null ? Number(organizationId) : null,
        deductStock: false,
        status: mapOzonStateToStatus(order.state ?? order.status),
        items,
        itemCount: items.length,
        alreadyImported: false,
      });
    }

    const existing = await fboSuppliesService.findExistingExternalNumbers(
      candidates.map((c) => ({ marketplace: c.marketplace, externalShipmentNumber: c.externalShipmentNumber })),
      { profileId }
    );
    for (const c of candidates) {
      c.alreadyImported = existing.has(`${c.marketplace}:${c.externalShipmentNumber}`);
    }

    return candidates;
  }

  async fetchWbPreview({ profileId, organizationId, daysBack = 90 } = {}) {
    const wbConfig = await integrationsService.getMarketplaceConfig('wildberries', {
      profileId,
      organizationId,
    });
    const apiKey = wbConfig?.api_key ?? wbConfig?.apiKey;
    if (!apiKey) {
      const err = new Error('Не настроен API-ключ Wildberries. Нужен токен с доступом «Поставки» (FBW).');
      err.statusCode = 400;
      throw err;
    }

    const since = new Date();
    since.setDate(since.getDate() - Math.max(1, Math.min(365, Number(daysBack) || 90)));
    const dateFrom = since.toISOString().slice(0, 10);
    const dateTo = new Date().toISOString().slice(0, 10);

    let listData;
    try {
      listData = await wbFbwRequest('/api/v1/supplies', {
        apiKey,
        method: 'POST',
        body: { dates: [{ from: dateFrom, to: dateTo }] },
      });
    } catch (e1) {
      try {
        listData = await wbFbwRequest('/api/v1/supplies', {
          apiKey,
          method: 'POST',
          body: { dateFrom, dateTo },
        });
      } catch (e2) {
        const err = new Error(e1?.message || 'Не удалось получить список поставок WB (FBW)');
        err.statusCode = 400;
        throw err;
      }
    }

    const rows = listData?.supplies ?? listData?.result ?? listData?.data ?? (Array.isArray(listData) ? listData : []);
    const candidates = [];

    for (const row of rows) {
      const supplyId = row.supplyID ?? row.supplyId ?? row.id ?? row.preorderID;
      const externalNumber = String(
        row.supplyID ?? row.preorderID ?? row.giId ?? row.supplyId ?? supplyId ?? ''
      ).trim();
      if (!externalNumber) continue;

      let items = [];
      try {
        const goodsData = await wbFbwRequest(
          `/api/v1/supplies/${encodeURIComponent(String(supplyId ?? externalNumber))}/goods`,
          { apiKey, method: 'GET' }
        );
        const goods = goodsData?.goods ?? goodsData?.products ?? goodsData?.data ?? [];
        for (const g of goods) {
          const qty = parseInt(g.quantity ?? g.count ?? g.amount ?? 0, 10);
          if (!qty || qty <= 0) continue;
          const sku = g.vendorCode ?? g.supplierArticle ?? g.sku ?? g.barcode ?? null;
          const barcode = g.barcode ?? g.barCode ?? null;
          const productId = await resolveProductId({ sku, barcode, profileId });
          items.push({
            productId,
            quantity: qty,
            sku,
            barcode,
            mpOfferId: sku,
            name: g.name ?? g.subject ?? null,
            unresolved: productId == null,
          });
        }
      } catch {
        items = [];
      }

      candidates.push({
        importKey: `wb:${externalNumber}`,
        marketplace: 'wb',
        name: row.name ?? row.warehouseName ?? `WB ${externalNumber}`,
        readyAt: parseDateOnly(row.supplyDate ?? row.createDate ?? row.date ?? row.acceptedDate),
        marketplaceWarehouseName: row.warehouseName ?? row.warehouse ?? null,
        marketplaceWarehouseId: row.warehouseID != null ? String(row.warehouseID) : null,
        externalShipmentNumber: externalNumber,
        externalSupplyId: supplyId != null ? String(supplyId) : null,
        deductionWarehouseId: null,
        organizationId: organizationId != null ? Number(organizationId) : null,
        deductStock: false,
        status: mapWbStateToStatus(row.statusName ?? row.status ?? row.statusID),
        items,
        itemCount: items.length,
        alreadyImported: false,
      });
    }

    const existing = await fboSuppliesService.findExistingExternalNumbers(
      candidates.map((c) => ({ marketplace: c.marketplace, externalShipmentNumber: c.externalShipmentNumber })),
      { profileId }
    );
    for (const c of candidates) {
      c.alreadyImported = existing.has(`${c.marketplace}:${c.externalShipmentNumber}`);
    }
    return candidates;
  }

  async fetchYandexPreview({ profileId, organizationId, daysBack = 90 } = {}) {
    const ymConfig = await integrationsService.getMarketplaceConfig('yandex', {
      profileId,
      organizationId,
    });
    const apiKey = ymConfig?.api_key ?? ymConfig?.apiKey;
    const campaignId = ymConfig?.campaign_id ?? ymConfig?.campaignId;
    if (!apiKey) {
      const err = new Error('Не настроен API-ключ Яндекс.Маркета');
      err.statusCode = 400;
      throw err;
    }
    if (!campaignId) {
      const err = new Error('Укажите campaign_id в интеграции Яндекс.Маркета');
      err.statusCode = 400;
      throw err;
    }

    const since = new Date();
    since.setDate(since.getDate() - Math.max(1, Math.min(365, Number(daysBack) || 90)));

    const listData = await ymRequest(
      `/v2/campaigns/${encodeURIComponent(String(campaignId))}/supply-requests?limit=100`,
      {
        apiKey,
        method: 'POST',
        body: {
          requestTypes: ['SUPPLY'],
          requestDateFrom: since.toISOString(),
          requestDateTo: new Date().toISOString(),
        },
      }
    );

    const requests = listData?.result?.requests ?? listData?.requests ?? [];
    const candidates = [];

    for (const req of requests) {
      const reqId = req.id?.id ?? req.id ?? req.requestId;
      const externalNumber = String(
        req.id?.warehouseRequestId ?? req.warehouseRequestId ?? reqId ?? ''
      ).trim();
      if (!externalNumber && reqId == null) continue;
      const extNum = externalNumber || String(reqId);

      let items = [];
      try {
        const itemsData = await ymRequest(
          `/v2/campaigns/${encodeURIComponent(String(campaignId))}/supply-requests/items?limit=500`,
          {
            apiKey,
            method: 'POST',
            body: { requestId: reqId, supplyRequestId: reqId },
          }
        );
        const rows = itemsData?.result?.items ?? itemsData?.items ?? [];
        for (const row of rows) {
          const counters = row.counters ?? {};
          const qty = parseInt(
            counters.planCount ?? counters.factCount ?? counters.quantity ?? row.quantity ?? 0,
            10
          );
          if (!qty || qty <= 0) continue;
          const offerId = row.offerId ?? row.shopSku ?? null;
          const productId = await resolveProductId({ sku: offerId, barcode: null, profileId });
          items.push({
            productId,
            quantity: qty,
            sku: offerId,
            barcode: null,
            mpOfferId: offerId,
            name: row.name ?? null,
            unresolved: productId == null,
          });
        }
      } catch {
        items = [];
      }

      const target = req.targetLocation ?? req.targetWarehouse ?? {};
      candidates.push({
        importKey: `ym:${extNum}`,
        marketplace: 'ym',
        name: target.name ?? `Яндекс ${extNum}`,
        readyAt: parseDateOnly(req.updatedAt ?? req.plannedDate ?? req.createdAt),
        marketplaceWarehouseName: target.name ?? target.warehouseName ?? null,
        marketplaceWarehouseId: target.id != null ? String(target.id) : null,
        externalShipmentNumber: extNum,
        externalSupplyId: reqId != null ? String(reqId) : null,
        deductionWarehouseId: null,
        organizationId: organizationId != null ? Number(organizationId) : null,
        deductStock: false,
        status: mapYmStateToStatus(req.status),
        items,
        itemCount: items.length,
        alreadyImported: false,
      });
    }

    const existing = await fboSuppliesService.findExistingExternalNumbers(
      candidates.map((c) => ({ marketplace: c.marketplace, externalShipmentNumber: c.externalShipmentNumber })),
      { profileId }
    );
    for (const c of candidates) {
      c.alreadyImported = existing.has(`${c.marketplace}:${c.externalShipmentNumber}`);
    }
    return candidates;
  }

  async fetchMarketplacePreview({ marketplace, profileId, organizationId, daysBack } = {}) {
    const mp = normalizeMarketplaceImport(marketplace);
    if (mp === 'ozon') return this.fetchOzonPreview({ profileId, organizationId, daysBack });
    if (mp === 'wb') return this.fetchWbPreview({ profileId, organizationId, daysBack });
    if (mp === 'ym') return this.fetchYandexPreview({ profileId, organizationId, daysBack });
    const err = new Error(`Неизвестный маркетплейс: ${marketplace}`);
    err.statusCode = 400;
    throw err;
  }

  async confirmImport(supplies, { profileId, userId } = {}) {
    if (!Array.isArray(supplies) || !supplies.length) {
      const err = new Error('Выберите хотя бы одну поставку для загрузки');
      err.statusCode = 400;
      throw err;
    }
    const created = [];
    const skipped = [];
    for (const row of supplies) {
      if (row.alreadyImported) {
        skipped.push({ externalShipmentNumber: row.externalShipmentNumber, reason: 'already_imported' });
        continue;
      }
      try {
        const doc = await fboSuppliesService.create(
          {
            marketplace: row.marketplace,
            name: row.name,
            readyAt: row.readyAt,
            marketplaceWarehouseName: row.marketplaceWarehouseName,
            marketplaceWarehouseId: row.marketplaceWarehouseId,
            externalShipmentNumber: row.externalShipmentNumber,
            externalSupplyId: row.externalSupplyId,
            deductionWarehouseId: row.deductionWarehouseId,
            organizationId: row.organizationId,
            deductStock: row.deductStock,
            status: row.status || 'new',
            source: row.source || 'api',
            items: (row.items || []).map((it) => ({
              productId: it.productId,
              quantity: it.quantity,
              barcode: it.barcode,
              sku: it.sku,
              mpOfferId: it.mpOfferId,
              mpProductId: it.mpProductId,
              name: it.name,
            })),
          },
          { profileId, userId }
        );
        created.push(doc);
      } catch (e) {
        if (e.code === 'DUPLICATE_SUPPLY') {
          skipped.push({
            externalShipmentNumber: row.externalShipmentNumber,
            reason: 'duplicate',
          });
        } else {
          throw e;
        }
      }
    }
    return { created, skipped };
  }
}

export default new FboSuppliesImportService();
