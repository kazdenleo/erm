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

const ITEMS_SHEET = 'Товары';

function generateDraftExternalNumber() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `NEW-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${Date.now().toString(36).slice(-6).toUpperCase()}`;
}

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
    if (
      joined.includes('номер_отгрузки') ||
      joined.includes('external_shipment_number') ||
      joined.includes('артикул') ||
      joined.includes('количество')
    ) {
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
           SELECT 1 FROM barcodes bc
           WHERE bc.product_id = p.id AND TRIM(bc.barcode) = $2
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
  const n = Number(status);
  if (Number.isFinite(n)) {
    if ([7, 8, 9].includes(n)) return 'return';
    if ([6, 10].includes(n)) return 'closed';
    if ([5].includes(n)) return 'shipped';
    if ([2, 3, 4].includes(n)) return 'ready_for_supply';
    if ([1].includes(n)) return 'new';
  }
  const s = String(status ?? '').toLowerCase();
  if (s.includes('cancel') || s.includes('reject')) return 'return';
  if (s.includes('complete') || s.includes('accept') || s.includes('done')) return 'closed';
  if (s.includes('transit') || s.includes('deliver') || s.includes('shipped')) return 'shipped';
  if (s.includes('ready') || s.includes('await')) return 'ready_for_supply';
  if (s.includes('pack')) return 'packed';
  if (s.includes('assembl')) return 'assembled';
  return 'new';
}

/** Тело POST /api/v1/supplies (FBW) — фильтр по датам RFC3339. */
function buildWbSuppliesListBody(daysBack) {
  const days = Math.max(1, Math.min(365, Number(daysBack) || 90));
  const till = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const toIso = (d) => d.toISOString();
  return {
    dates: [
      { from: toIso(from), till: toIso(till), type: 'createDate' },
      { from: toIso(from), till: toIso(till), type: 'supplyDate' },
    ],
  };
}

function parseWbSuppliesListResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.supplies)) return data.supplies;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function parseWbGoodsResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.goods)) return data.goods;
  if (Array.isArray(data?.products)) return data.products;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

/** ID для GET /api/v1/supplies/{ID}/goods — supplyID или preorderID. */
function wbSupplyGoodsApiId(row) {
  const supplyId = row.supplyID ?? row.supplyId ?? row.supply_id;
  if (supplyId != null && String(supplyId).trim() !== '' && Number(supplyId) !== 0) {
    return String(supplyId);
  }
  const preorder = row.preorderID ?? row.preorderId ?? row.preorder_id;
  if (preorder != null && String(preorder).trim() !== '') return String(preorder);
  return null;
}

function wbExternalShipmentNumber(row) {
  const supplyId = row.supplyID ?? row.supplyId;
  if (supplyId != null && String(supplyId).trim() !== '' && Number(supplyId) !== 0) {
    return String(supplyId);
  }
  const preorder = row.preorderID ?? row.preorderId;
  if (preorder != null && String(preorder).trim() !== '') {
    return `PRE-${preorder}`;
  }
  return '';
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
  /**
   * Excel: только артикул и количество → одна новая поставка (черновик).
   */
  async parseExcelBuffer(buffer, { profileId } = {}) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet(ITEMS_SHEET) || wb.worksheets[0];
    if (!ws) {
      const err = new Error('Файл Excel пуст');
      err.statusCode = 400;
      throw err;
    }

    const keyRow = findKeyRow(ws);
    const items = [];
    for (let r = keyRow.number + 1; r <= (ws.rowCount || 0); r++) {
      const raw = rowToObject(ws, r, keyRow);
      const sku = String(raw.sku || raw.артикул || '').trim();
      const qty = parseInt(raw.quantity || raw.количество || '0', 10);
      if (!sku || !qty || qty <= 0) continue;
      const productId = await resolveProductId({ sku, barcode: null, profileId });
      items.push({
        productId,
        quantity: qty,
        sku,
        barcode: null,
        name: null,
        unresolved: productId == null,
      });
    }

    if (!items.length) {
      const err = new Error('В файле нет строк с артикулом и количеством');
      err.statusCode = 400;
      throw err;
    }

    const externalShipmentNumber = generateDraftExternalNumber();
    return [
      {
        importKey: `excel:${externalShipmentNumber}`,
        isNewDraft: true,
        marketplace: 'ozon',
        name: 'Новая поставка',
        readyAt: null,
        marketplaceWarehouseName: null,
        externalShipmentNumber,
        deductionWarehouseId: null,
        organizationId: null,
        deductStock: false,
        status: 'new',
        source: 'excel',
        items,
        itemCount: items.length,
        alreadyImported: false,
      },
    ];
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
    if (!apiKey || !String(apiKey).trim()) {
      const err = new Error(
        'Не настроен API-ключ Wildberries. Укажите токен категории «Поставки» (FBW) в «Интеграции» для выбранной организации и выберите ту же организацию в шапке сайта.'
      );
      err.statusCode = 400;
      throw err;
    }

    const listBody = buildWbSuppliesListBody(daysBack);
    let listData;
    try {
      listData = await wbFbwRequest('/api/v1/supplies', {
        apiKey,
        method: 'POST',
        body: listBody,
      });
    } catch (e1) {
      const err = new Error(
        e1?.message ||
          'Не удалось получить список поставок WB (FBW). Проверьте токен «Поставки» и доступ к supplies-api.wildberries.ru.'
      );
      err.statusCode = e1?.statusCode === 502 ? 502 : 400;
      throw err;
    }

    const rows = parseWbSuppliesListResponse(listData);
    const candidates = [];

    for (const row of rows) {
      const externalNumber = wbExternalShipmentNumber(row);
      const goodsApiId = wbSupplyGoodsApiId(row);
      if (!externalNumber || !goodsApiId) continue;

      let items = [];
      try {
        const goodsData = await wbFbwRequest(
          `/api/v1/supplies/${encodeURIComponent(goodsApiId)}/goods`,
          { apiKey, method: 'GET' }
        );
        const list = parseWbGoodsResponse(goodsData);
        for (const g of list) {
          const qty = parseInt(
            g.quantity ?? g.count ?? g.amount ?? g.readyForSaleQuantity ?? 0,
            10
          );
          if (!qty || qty <= 0) continue;
          const sku =
            g.vendorCode ??
            g.supplierArticle ??
            g.supplierVendorCode ??
            g.sku ??
            null;
          const barcode = g.barcode ?? g.barCode ?? g.barcodes?.[0] ?? null;
          const productId = await resolveProductId({ sku, barcode, profileId });
          items.push({
            productId,
            quantity: qty,
            sku,
            barcode,
            mpOfferId: sku,
            mpProductId: g.nmID != null ? String(g.nmID) : g.nmId != null ? String(g.nmId) : null,
            name: g.name ?? g.subject ?? g.brand ?? null,
            unresolved: productId == null,
          });
        }
      } catch {
        items = [];
      }

      const supplyId = row.supplyID ?? row.supplyId;
      const preorderId = row.preorderID ?? row.preorderId;
      const whName =
        row.warehouseName ??
        row.warehouse ??
        row.warehouseAddress ??
        (row.warehouseID != null ? `Склад WB #${row.warehouseID}` : null);

      candidates.push({
        importKey: `wb:${externalNumber}`,
        marketplace: 'wb',
        name:
          row.name ??
          (supplyId ? `Поставка WB ${supplyId}` : `Заказ WB ${preorderId ?? goodsApiId}`),
        readyAt: parseDateOnly(
          row.supplyDate ?? row.factDate ?? row.createDate ?? row.updatedDate ?? row.date
        ),
        marketplaceWarehouseName: whName,
        marketplaceWarehouseId:
          row.warehouseID != null
            ? String(row.warehouseID)
            : row.warehouseId != null
              ? String(row.warehouseId)
              : null,
        externalShipmentNumber: externalNumber,
        externalSupplyId: supplyId != null ? String(supplyId) : String(preorderId ?? goodsApiId),
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
