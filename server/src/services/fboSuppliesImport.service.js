/**
 * Импорт поставок FBO: Excel и API маркетплейсов (preview + confirm).
 */

import ExcelJS from 'exceljs';
import { query } from '../config/database.js';
import integrationsService from './integrations.service.js';
import fboSuppliesService from './fboSupplies.service.js';
import { getFetchProxyAgent } from '../utils/fetchAgent.js';
import { getYandexHttpsAgent, formatYandexNetworkError } from '../utils/yandex-https-agent.js';
import { parseOzonBundleRowMeta } from '../constants/ozonPlacementZones.js';

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

const OZON_SUPPLY_LIST_STATES = [
  'DATA_FILLING',
  'READY_TO_SUPPLY',
  'ACCEPTED_AT_SUPPLY_WAREHOUSE',
  'IN_TRANSIT',
  'ACCEPTANCE_AT_STORAGE_WAREHOUSE',
  'REPORTS_CONFIRMATION_AWAITING',
  'REPORT_REJECTED',
  'COMPLETED',
  'REJECTED_AT_SUPPLY_WAREHOUSE',
  'CANCELLED',
  'OVERDUE',
];

/** Вкладка Ozon «Подготовка к поставке» → «Заполнение данных». */
const OZON_SUPPLY_IMPORT_STATES = ['DATA_FILLING'];

const OZON_SUPPLY_TERMINAL_STATES = new Set([
  'COMPLETED',
  'CANCELLED',
  'REJECTED_AT_SUPPLY_WAREHOUSE',
]);

function ozonSupplyAlreadyImported(imported, externalNumber, externalSupplyId, supplyOrderId) {
  if (imported.shipmentNumbers.has(`ozon:${externalNumber}`)) return true;
  if (externalSupplyId != null && imported.supplyIds.has(String(externalSupplyId))) return true;
  if (supplyOrderId != null && imported.supplyIds.has(String(supplyOrderId))) return true;
  return false;
}

function buildOzonSupplyListBody(daysBack, lastId = '', states = OZON_SUPPLY_LIST_STATES, { useTimeslotFilter = true } = {}) {
  const days = Math.max(1, Math.min(365, Number(daysBack) || 90));
  const since = new Date();
  since.setDate(since.getDate() - days);
  const till = new Date();
  // Будущие слоты отгрузки (в ЛК часто дата отгрузки через несколько дней).
  till.setDate(till.getDate() + days);
  const body = {
    limit: 100,
    sort_by: 'ORDER_CREATION',
    sort_dir: 'DESC',
    filter: {
      states,
    },
  };
  if (useTimeslotFilter) {
    body.filter.timeslot_from_range = {
      from: since.toISOString(),
      to: till.toISOString(),
      timeslot_filter_type: 'BY_UTC_TIME',
    };
  }
  if (lastId) body.last_id = String(lastId);
  return body;
}

function parseOzonListOrderIds(listData) {
  const ids = listData?.result?.order_ids ?? listData?.order_ids ?? [];
  return (Array.isArray(ids) ? ids : []).map((id) => String(id)).filter(Boolean);
}

function parseOzonListLastId(listData) {
  const v = listData?.result?.last_id ?? listData?.last_id ?? '';
  return v != null && String(v).trim() !== '' ? String(v) : '';
}

/** Разворачивает заявки v3/supply-order/get в строки по поставкам (supplies). */
function flattenOzonSupplyOrders(orders) {
  const rows = [];
  for (const order of orders || []) {
    const supplies = order.supplies;
    if (Array.isArray(supplies) && supplies.length) {
      for (const supply of supplies) {
        rows.push({ order, supply });
      }
    } else {
      rows.push({ order, supply: null });
    }
  }
  return rows;
}

function ozonSupplyRowState(order, supply) {
  return String(supply?.state ?? order?.state ?? order?.status ?? '').toUpperCase();
}

function isOzonSupplyImportable(order, supply) {
  return OZON_SUPPLY_IMPORT_STATES.includes(ozonSupplyRowState(order, supply));
}

function resolveOzonBundleId(order, supply) {
  const fromSupply = supply?.bundle_id ?? supply?.bundleId;
  if (fromSupply != null && String(fromSupply).trim() !== '') return String(fromSupply).trim();

  const supplyBundles = supply?.bundle_ids;
  if (Array.isArray(supplyBundles) && supplyBundles.length) {
    for (const entry of supplyBundles) {
      const id =
        typeof entry === 'string' || typeof entry === 'number'
          ? String(entry)
          : entry?.bundle_id ?? entry?.bundleId;
      if (id != null && String(id).trim() !== '') return String(id).trim();
    }
  }

  const orderBundle = order?.bundle_id ?? order?.bundleId;
  if (orderBundle != null && String(orderBundle).trim() !== '') return String(orderBundle).trim();

  const orderBundles = order?.bundle_ids;
  if (Array.isArray(orderBundles) && orderBundles.length) {
    const entry = orderBundles[0];
    const id =
      typeof entry === 'string' || typeof entry === 'number'
        ? String(entry)
        : entry?.bundle_id ?? entry?.bundleId;
    if (id != null && String(id).trim() !== '') return String(id).trim();
  }

  return null;
}

function parseOzonBundleResponse(bundleData) {
  const root = bundleData?.result ?? bundleData ?? {};
  let rows = root.items ?? root.products ?? bundleData?.items ?? [];
  if ((!Array.isArray(rows) || !rows.length) && Array.isArray(root.bundles)) {
    rows = root.bundles.flatMap((b) => b?.items ?? b?.products ?? []);
  }
  const totalCount = parseInt(root.total_count ?? root.totalCount ?? 0, 10) || 0;
  const hasNext = root.has_next === true || root.hasNext === true;
  const lastId = root.last_id ?? root.lastId ?? '';
  return {
    rows: Array.isArray(rows) ? rows : [],
    totalCount,
    hasNext,
    lastId: lastId != null && String(lastId).trim() !== '' ? String(lastId) : '',
  };
}

function parseOzonBundleRowQuantity(row) {
  return parseInt(
    row?.quantity ??
      row?.count ??
      row?.amount ??
      row?.total_quantity ??
      row?.planned_quantity ??
      0,
    10
  );
}

function parseOzonBundleRowOfferId(row) {
  return (
    row?.offer_id ??
    row?.offerId ??
    row?.contractor_item_code ??
    row?.contractorItemCode ??
    row?.sku ??
    null
  );
}

async function fetchOzonSupplyOrderDetails(supplyOrderId, ozonApiOpts) {
  if (supplyOrderId == null || String(supplyOrderId).trim() === '') {
    return { bundleIds: [], shippingCluster: null, totalQuantity: 0 };
  }
  try {
    const data = await integrationsService._ozonApiPost(
      '/v1/supply-order/details',
      { supply_order_id: Number(supplyOrderId) || supplyOrderId },
      ozonApiOpts
    );
    const result = data?.result ?? data ?? {};
    const ids = [];
    const pushId = (v) => {
      if (v != null && String(v).trim() !== '') ids.push(String(v).trim());
    };
    for (const entry of result.bundle_ids ?? []) {
      pushId(typeof entry === 'object' ? entry?.bundle_id ?? entry?.bundleId : entry);
    }
    for (const s of result.supplies ?? result.supply ?? []) {
      pushId(s?.bundle_id ?? s?.bundleId);
      for (const entry of s?.bundle_ids ?? []) {
        pushId(typeof entry === 'object' ? entry?.bundle_id ?? entry?.bundleId : entry);
      }
    }

    const clusterCandidates = [
      result.macrocluster?.name,
      result.macrocluster_name,
      result.cluster_name,
      result.placement_cluster_name,
      result.destination_warehouse?.cluster_name,
      result.destination_warehouse?.name,
      result.storage_warehouse?.cluster_name,
      ...(result.supplies ?? result.supply ?? []).flatMap((s) => [
        s?.macrocluster?.name,
        s?.macrocluster_name,
        s?.cluster_name,
        s?.placement_cluster_name,
        s?.storage_warehouse?.cluster_name,
        s?.storage_warehouse?.macrocluster_name,
      ]),
    ];
    let shippingCluster = null;
    for (const c of clusterCandidates) {
      if (c != null && String(c).trim() !== '') {
        shippingCluster = String(c).trim();
        break;
      }
    }

    const qtyCandidates = [
      result.total_quantity,
      result.total_item_count,
      result.items_count,
      ...(result.supplies ?? result.supply ?? []).flatMap((s) => [
        s?.total_quantity,
        s?.total_item_count,
        s?.items_count,
      ]),
    ];
    let totalQuantity = 0;
    for (const v of qtyCandidates) {
      const n = parseInt(v, 10);
      if (n > 0) {
        totalQuantity = n;
        break;
      }
    }

    return {
      bundleIds: [...new Set(ids)],
      shippingCluster,
      totalQuantity,
    };
  } catch {
    return { bundleIds: [], shippingCluster: null, totalQuantity: 0 };
  }
}

function resolveOzonSupplyMetaCounts(order, supply) {
  const values = [
    supply?.total_quantity,
    supply?.total_item_count,
    supply?.items_count,
    supply?.quantity,
    supply?.total_items,
    order?.total_quantity,
    order?.total_item_count,
    order?.items_count,
  ];
  for (const v of values) {
    const n = parseInt(v, 10);
    if (n > 0) return n;
  }
  return 0;
}

async function fetchOzonBundleItems(bundleId, ozonApiOpts, profileId) {
  const items = [];
  let lastId = '';
  let reportedTotal = 0;
  for (let page = 0; page < 20; page++) {
    const body = { bundle_ids: [String(bundleId)], limit: 100, item_tags_calculation: true };
    if (lastId) body.last_id = lastId;
    const bundleData = await integrationsService._ozonApiPost(
      '/v1/supply-order/bundle',
      body,
      ozonApiOpts
    );
    const parsed = parseOzonBundleResponse(bundleData);
    if (parsed.totalCount > reportedTotal) reportedTotal = parsed.totalCount;

    for (const row of parsed.rows) {
      const qty = parseOzonBundleRowQuantity(row);
      if (!qty || qty <= 0) continue;
      const offerId = parseOzonBundleRowOfferId(row);
      const barcode = row.barcode ?? row.bar_code ?? null;
      const { placementZone, ozonTags } = parseOzonBundleRowMeta(row);
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
        placementZone,
        ozonTags,
        unresolved: productId == null,
      });
    }

    if (!parsed.hasNext) break;
    if (!parsed.lastId || parsed.lastId === lastId) break;
    lastId = parsed.lastId;
  }
  return {
    items,
    totalCount: Math.max(reportedTotal, sumSupplyItemsQuantity(items)),
  };
}

async function fetchOzonSupplyItems(order, supply, ozonApiOpts, profileId, orderDetails = null) {
  const supplyOrderId = order?.supply_order_id ?? order?.order_id ?? order?.id;
  const details =
    orderDetails ?? (await fetchOzonSupplyOrderDetails(supplyOrderId, ozonApiOpts));

  const bundleIds = [];
  const primaryBundleId = resolveOzonBundleId(order, supply);
  if (primaryBundleId) bundleIds.push(primaryBundleId);
  for (const id of details.bundleIds) {
    if (!bundleIds.includes(id)) bundleIds.push(id);
  }

  let items = [];
  let totalCount = details.totalQuantity || 0;
  for (const bundleId of bundleIds) {
    try {
      const fetched = await fetchOzonBundleItems(bundleId, ozonApiOpts, profileId);
      if (fetched.items.length > items.length) items = fetched.items;
      if (fetched.totalCount > totalCount) totalCount = fetched.totalCount;
      if (items.length && totalCount > 0) break;
    } catch {
      /* try next bundle_id */
    }
  }

  if (!totalCount) totalCount = resolveOzonSupplyMetaCounts(order, supply);
  if (!totalCount && items.length) totalCount = sumSupplyItemsQuantity(items);

  return { items, totalCount, shippingCluster: details.shippingCluster };
}

async function fetchOzonSupplyOrderIds(daysBack, ozonApiOpts, { states, useTimeslotFilter = true } = {}) {
  const ids = [];
  let lastId = '';
  const listStates = states?.length ? states : OZON_SUPPLY_LIST_STATES;
  for (let page = 0; page < 30; page++) {
    const listData = await integrationsService._ozonApiPost(
      '/v3/supply-order/list',
      buildOzonSupplyListBody(daysBack, lastId, listStates, { useTimeslotFilter }),
      ozonApiOpts
    );
    const batch = parseOzonListOrderIds(listData);
    ids.push(...batch);
    const next = parseOzonListLastId(listData);
    if (!next || !batch.length) break;
    lastId = next;
  }
  return [...new Set(ids)];
}

async function fetchOzonSupplyOrderIdsForImport(daysBack, ozonApiOpts, { states } = {}) {
  let ids = await fetchOzonSupplyOrderIds(daysBack, ozonApiOpts, { states, useTimeslotFilter: true });
  if (!ids.length) {
    ids = await fetchOzonSupplyOrderIds(daysBack, ozonApiOpts, { states, useTimeslotFilter: false });
  }
  return ids;
}

async function fetchOzonSupplyOrdersByIds(orderIds, ozonApiOpts) {
  const orders = [];
  const warehousesById = new Map();
  const unique = [...new Set((orderIds || []).map((id) => String(id)).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await integrationsService._ozonApiPost(
      '/v3/supply-order/get',
      { order_ids: chunk },
      ozonApiOpts
    );
    const list = data?.result?.orders ?? data?.orders ?? [];
    if (Array.isArray(list)) orders.push(...list);
    const whList = data?.result?.warehouses ?? data?.warehouses ?? [];
    for (const wh of whList) {
      const id = wh?.warehouse_id ?? wh?.id;
      if (id != null) warehousesById.set(String(id), wh);
    }
  }
  return { orders, warehousesById };
}

async function fetchOzonStorageWarehouseClusterMap(ozonApiOpts) {
  const map = new Map();
  const bodies = [{ cluster_type: 'CLUSTER_TYPE_OZON' }, {}];
  for (const body of bodies) {
    try {
      const data = await integrationsService._ozonApiPost('/v1/cluster/list', body, ozonApiOpts);
      const clusters = data?.result?.clusters ?? data?.clusters ?? [];
      for (const cluster of clusters) {
        const clusterName = String(cluster?.name ?? cluster?.cluster_name ?? '').trim();
        if (!clusterName) continue;
        const logistic = cluster?.logistic_clusters ?? cluster?.logisticClusters ?? [];
        for (const lc of logistic) {
          for (const wh of lc?.warehouses ?? []) {
            const id = wh?.warehouse_id ?? wh?.id;
            if (id != null) map.set(String(id), clusterName);
          }
        }
      }
      if (map.size) break;
    } catch {
      /* try next body */
    }
  }
  return map;
}

function resolveOzonShippingCluster(order, supply, warehousesById, clusterByWarehouseId) {
  const direct =
    supply?.cluster_name ??
    supply?.cluster?.name ??
    supply?.placement_cluster_name ??
    supply?.placement_cluster?.name ??
    supply?.macrocluster?.name ??
    supply?.macrocluster_name ??
    supply?.storage_warehouse?.cluster_name ??
    supply?.storage_warehouse?.macrocluster_name ??
    supply?.destination_warehouse?.cluster_name ??
    supply?.destination_warehouse?.macrocluster_name ??
    order?.cluster_name ??
    order?.placement_cluster_name ??
    order?.placement_cluster?.name ??
    order?.macrocluster?.name ??
    order?.macrocluster_name ??
    order?.destination_warehouse?.cluster_name ??
    null;
  if (direct != null && String(direct).trim() !== '') return String(direct).trim();

  const whId =
    supply?.storage_warehouse_id ??
    supply?.storage_warehouse?.warehouse_id ??
    supply?.storage_warehouse?.id ??
    null;
  if (whId != null) {
    const fromCluster = clusterByWarehouseId.get(String(whId));
    if (fromCluster) return fromCluster;
    const wh = warehousesById?.get?.(String(whId));
    const whCluster =
      wh?.cluster_name ?? wh?.macrocluster_name ?? wh?.placement_cluster_name ?? null;
    if (whCluster != null && String(whCluster).trim() !== '') return String(whCluster).trim();
  }
  return null;
}

function mapOzonStateToStatus(state) {
  const s = String(state ?? '').toUpperCase();
  if (s.includes('CANCEL') || s.includes('REJECT')) return 'return';
  if (s === 'COMPLETED' || s.includes('REPORTS_CONFIRMATION')) return 'closed';
  if (s.includes('TRANSIT') || s.includes('ACCEPTANCE_AT_STORAGE')) return 'shipped';
  if (s.includes('READY_TO_SUPPLY') || s.includes('ACCEPTED_AT_SUPPLY')) return 'ready_for_supply';
  if (s.includes('DATA_FILLING')) return 'new';
  const low = s.toLowerCase();
  if (low.includes('cancel') || low.includes('return')) return 'return';
  if (low.includes('complete') || low.includes('closed')) return 'closed';
  if (low.includes('transit') || low.includes('delivering')) return 'shipped';
  if (low.includes('ready') || low.includes('awaiting')) return 'ready_for_supply';
  return 'new';
}

function sumSupplyItemsQuantity(items) {
  return (items || []).reduce((sum, it) => sum + (parseInt(it?.quantity, 10) || 0), 0);
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

function ymApiKeyHeader(apiKey) {
  const raw =
    typeof integrationsService?._normalizeYandexApiKey === 'function'
      ? integrationsService._normalizeYandexApiKey(apiKey)
      : String(apiKey || '')
          .replace(/\s+/g, ' ')
          .replace(/\uFEFF/g, '')
          .trim();
  return raw;
}

async function wbFbwRequest(path, { apiKey, method = 'GET', body = null, timeoutMs = 45000 } = {}) {
  const auth = wbAuthHeader(apiKey);
  if (!auth) {
    const err = new Error('Не настроен API-ключ Wildberries (категория «Поставки»)');
    err.statusCode = 400;
    throw err;
  }
  const agent = getFetchProxyAgent();
  const url = path.startsWith('http') ? path : `${WB_SUPPLIES_API}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const opts = {
    method,
    headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    signal: controller.signal,
    ...(agent && { agent }),
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  let response;
  try {
    response = await fetch(url, opts);
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error('Таймаут запроса к Wildberries FBW API. Проверьте сеть или уменьшите период.');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`Wildberries FBW API ${response.status}${text ? `: ${text.substring(0, 200)}` : ''}`);
    err.statusCode = response.status === 401 || response.status === 403 ? 400 : 502;
    throw err;
  }
  return response.json().catch(() => ({}));
}

async function ymRequest(path, { apiKey, method = 'GET', body = null } = {}) {
  const key = ymApiKeyHeader(apiKey);
  if (!key) {
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
      headers: {
        'Api-Key': key,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
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
  if (s.includes('assembl')) return 'packed';
  return 'new';
}

/** Тело POST /api/v1/supplies (FBW) — даты только YYYY-MM-DD. */
function buildWbSuppliesListBody(daysBack) {
  const days = Math.max(1, Math.min(365, Number(daysBack) || 90));
  const till = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const toDateOnly = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fromStr = toDateOnly(from);
  const tillStr = toDateOnly(till);
  // Один тип даты: несколько filters в dates часто дают пустой список (логика AND на стороне WB).
  return {
    dates: [{ from: fromStr, till: tillStr, type: 'createDate' }],
  };
}

/** Параллельная обработка с ограничением (чтобы не зависать на N последовательных запросах к WB). */
async function mapWithConcurrency(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(20, Number(concurrency) || 5));
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => worker()));
  return out;
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

function resolveWbPlacementCluster(row) {
  const candidates = [
    row.clusterName,
    row.cluster_name,
    row.warehouseCluster,
    row.warehouseClusterName,
    row.destinationWarehouseName,
    row.destination_warehouse_name,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
  return null;
}

function resolveYmPlacementCluster(req, target) {
  const candidates = [
    target?.clusterName,
    target?.cluster_name,
    target?.placementCluster,
    target?.placement_cluster,
    req?.placementCluster,
    req?.placement_cluster,
    req?.placementClusterName,
    req?.placement_cluster_name,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
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
        itemCount: sumSupplyItemsQuantity(items),
        alreadyImported: false,
      },
    ];
  }

  async fetchOzonPreview({ profileId, organizationId, daysBack = 90 } = {}) {
    const ozonCfg = await integrationsService.getMarketplaceConfig('ozon', {
      profileId,
      organizationId,
    });
    const clientId = ozonCfg?.client_id ?? ozonCfg?.clientId;
    const apiKey = ozonCfg?.api_key ?? ozonCfg?.apiKey;
    if (!clientId || !apiKey) {
      const err = new Error(
        'Не настроены Client ID и API Key Ozon. Укажите их в «Интеграции» для выбранной организации и выберите ту же организацию в шапке сайта.'
      );
      err.statusCode = 400;
      throw err;
    }

    const ozonApiOpts = { profileId, organizationId, ozonOverride: ozonCfg };

    const imported = await fboSuppliesService.listImportedExternalKeys('ozon', { profileId });
    const listDaysBack = Math.max(1, Math.min(365, Number(daysBack) || 90));

    let orderIds;
    try {
      orderIds = await fetchOzonSupplyOrderIdsForImport(listDaysBack, ozonApiOpts, {
        states: OZON_SUPPLY_IMPORT_STATES,
      });
    } catch (e) {
      const err = new Error(e?.message || 'Не удалось получить список поставок Ozon');
      err.statusCode = 400;
      throw err;
    }

    if (!orderIds.length) return [];

    let ozonOrders;
    let ozonWarehousesById;
    let ozonClusterByWarehouseId;
    try {
      const fetched = await fetchOzonSupplyOrdersByIds(orderIds, ozonApiOpts);
      ozonOrders = fetched.orders;
      ozonWarehousesById = fetched.warehousesById;
      ozonClusterByWarehouseId = await fetchOzonStorageWarehouseClusterMap(ozonApiOpts);
    } catch (e) {
      const err = new Error(e?.message || 'Не удалось загрузить детали поставок Ozon');
      err.statusCode = 400;
      throw err;
    }

    const candidates = [];
    const ozonDetailsCache = new Map();
    for (const { order, supply } of flattenOzonSupplyOrders(ozonOrders)) {
      if (!isOzonSupplyImportable(order, supply)) continue;

      const supplyOrderId = order.supply_order_id ?? order.order_id ?? order.id;
      if (!ozonDetailsCache.has(String(supplyOrderId))) {
        ozonDetailsCache.set(
          String(supplyOrderId),
          await fetchOzonSupplyOrderDetails(supplyOrderId, ozonApiOpts)
        );
      }
      const orderDetails = ozonDetailsCache.get(String(supplyOrderId));

      const supplyId = supply?.supply_id ?? supply?.id;
      const baseNumber = String(
        order.order_number ?? order.supply_order_number ?? supplyOrderId ?? ''
      ).trim();
      const externalNumber =
        baseNumber && supplyId != null ? `${baseNumber}-${supplyId}` : baseNumber || String(supplyId ?? '');
      if (!externalNumber) continue;

      if (ozonSupplyAlreadyImported(imported, externalNumber, supplyId, supplyOrderId)) {
        continue;
      }

      let items = [];
      let itemCount = 0;
      let shippingClusterFromDetails = null;
      try {
        const fetchedItems = await fetchOzonSupplyItems(
          order,
          supply,
          ozonApiOpts,
          profileId,
          orderDetails
        );
        items = fetchedItems.items;
        itemCount = fetchedItems.totalCount;
        shippingClusterFromDetails = fetchedItems.shippingCluster;
      } catch {
        items = [];
        itemCount = orderDetails?.totalQuantity || resolveOzonSupplyMetaCounts(order, supply);
        shippingClusterFromDetails = orderDetails?.shippingCluster ?? null;
      }

      const storageWhId =
        supply?.storage_warehouse_id ??
        supply?.storage_warehouse?.warehouse_id ??
        supply?.storage_warehouse?.id ??
        null;
      const whFromGet =
        storageWhId != null ? ozonWarehousesById.get(String(storageWhId)) : null;
      const wh =
        supply?.storage_warehouse ??
        whFromGet ??
        order.drop_off_warehouse ??
        order.warehouse ??
        order.warehouse_info ??
        {};
      const shippingCluster =
        shippingClusterFromDetails ||
        resolveOzonShippingCluster(order, supply, ozonWarehousesById, ozonClusterByWarehouseId);
      candidates.push({
        importKey: `ozon:${externalNumber}`,
        marketplace: 'ozon',
        name: order.order_number
          ? `Ozon ${order.order_number}${supplyId != null ? ` / ${supplyId}` : ''}`
          : `Ozon ${externalNumber}`,
        readyAt: parseDateOnly(
          order.timeslot?.from ??
            order.timeslot?.timeslot?.from ??
            order.created_date ??
            order.delivery_date ??
            order.planned_date
        ),
        marketplaceWarehouseName: wh.name ?? wh.warehouse_name ?? order.warehouse_name ?? null,
        marketplaceWarehouseId:
          storageWhId != null
            ? String(storageWhId)
            : wh.warehouse_id != null
              ? String(wh.warehouse_id)
              : wh.storage_warehouse_id != null
                ? String(wh.storage_warehouse_id)
                : null,
        shippingCluster,
        externalShipmentNumber: externalNumber,
        externalSupplyId:
          supplyId != null ? String(supplyId) : supplyOrderId != null ? String(supplyOrderId) : null,
        deductionWarehouseId: null,
        organizationId: organizationId != null ? Number(organizationId) : null,
        deductStock: false,
        status: mapOzonStateToStatus(supply?.state ?? order.state ?? order.status),
        ozonState: ozonSupplyRowState(order, supply),
        items,
        itemCount,
        alreadyImported: false,
      });
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

    let rows = parseWbSuppliesListResponse(listData);
    if (!rows.length) {
      const fallbackData = await wbFbwRequest('/api/v1/supplies', {
        apiKey,
        method: 'POST',
        body: {},
      });
      rows = parseWbSuppliesListResponse(fallbackData);
    }

    const built = await mapWithConcurrency(rows, 6, async (row) => {
      const externalNumber = wbExternalShipmentNumber(row);
      const goodsApiId = wbSupplyGoodsApiId(row);
      if (!externalNumber || !goodsApiId) return null;

      let items = [];
      try {
        const goodsData = await wbFbwRequest(
          `/api/v1/supplies/${encodeURIComponent(goodsApiId)}/goods`,
          { apiKey, method: 'GET', timeoutMs: 30000 }
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

      return {
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
        shippingCluster: resolveWbPlacementCluster(row),
        externalShipmentNumber: externalNumber,
        externalSupplyId: supplyId != null ? String(supplyId) : String(preorderId ?? goodsApiId),
        deductionWarehouseId: null,
        organizationId: organizationId != null ? Number(organizationId) : null,
        deductStock: false,
        status: mapWbStateToStatus(row.statusName ?? row.status ?? row.statusID),
        items,
        itemCount: sumSupplyItemsQuantity(items),
        alreadyImported: false,
      };
    });

    const candidates = built.filter(Boolean);

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
    if (!apiKey || !ymApiKeyHeader(apiKey)) {
      const err = new Error(
        'Не настроен API-ключ Яндекс.Маркета (формат ACMA:...). Укажите токен в «Интеграции» для выбранной организации с доступом «Заявки на поставку».'
      );
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
        shippingCluster: resolveYmPlacementCluster(req, target),
        externalShipmentNumber: extNum,
        externalSupplyId: reqId != null ? String(reqId) : null,
        deductionWarehouseId: null,
        organizationId: organizationId != null ? Number(organizationId) : null,
        deductStock: false,
        status: mapYmStateToStatus(req.status),
        items,
        itemCount: sumSupplyItemsQuantity(items),
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
            placementCluster: row.shippingCluster ?? row.placementCluster ?? null,
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
              placementZone: it.placementZone ?? null,
              ozonTags: it.ozonTags ?? [],
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
