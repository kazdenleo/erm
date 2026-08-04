/**
 * Импорт поставок FBO: Excel и API маркетплейсов (preview + confirm).
 */

import ExcelJS from 'exceljs';
import { query } from '../config/database.js';
import integrationsService from './integrations.service.js';
import fboSuppliesService from './fboSupplies.service.js';
import fboSupplyReserveService from './fboSupplyReserve.service.js';
import { syncSupplyStatusForPacking } from '../utils/fboSupplyPackingCheck.js';
import { getFetchProxyAgent } from '../utils/fetchAgent.js';
import { getYandexHttpsAgent, formatYandexNetworkError } from '../utils/yandex-https-agent.js';
import { parseOzonBundleRowMeta } from '../constants/ozonPlacementZones.js';
import { runWithDbRetry } from '../utils/dbRetry.js';
import { ozonApiPostWithRetry } from '../utils/ozonSellerApi.js';
import { isFboSupplyTerminalStatus, pickStatusAfterMarketplaceSync } from '../constants/fboSupplyStatuses.js';

const WB_SUPPLIES_API = 'https://supplies-api.wildberries.ru';
const YM_API = 'https://api.partner.market.yandex.ru';

const ITEMS_SHEET = 'Товары';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOzonRateLimitError(err) {
  const msg = String(err?.message ?? '');
  return msg.includes('429') || /rate limit/i.test(msg);
}

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
  const maps = await batchResolveProductIds([{ sku, barcode }], profileId);
  return resolveProductIdFromMaps({ sku, barcode }, maps);
}

/** Пакетное сопоставление артикулов/штрихкодов с товарами ERM (1–2 запроса вместо N). */
async function batchResolveProductIds(entries, profileId) {
  const pid = profileId != null ? Number(profileId) : null;
  const skus = [
    ...new Set(
      (entries || [])
        .map((e) => (e?.sku != null ? String(e.sku).trim() : ''))
        .filter(Boolean)
    ),
  ];
  const barcodes = [
    ...new Set(
      (entries || [])
        .map((e) => (e?.barcode != null ? String(e.barcode).trim() : ''))
        .filter(Boolean)
    ),
  ];
  const bySku = new Map();
  const byBarcode = new Map();

  if (skus.length) {
    const r = await query(
      `SELECT p.id,
              TRIM(p.sku) AS product_sku,
              TRIM(ps.sku) AS alias_sku
       FROM products p
       LEFT JOIN product_skus ps ON ps.product_id = p.id AND TRIM(ps.sku) = ANY($2::text[])
       WHERE ($1::bigint IS NULL OR p.profile_id = $1)
         AND (TRIM(p.sku) = ANY($2::text[]) OR ps.id IS NOT NULL)`,
      [pid, skus]
    );
    for (const row of r.rows || []) {
      const id = row.id;
      const productSku = row.product_sku ? String(row.product_sku).trim() : '';
      const aliasSku = row.alias_sku ? String(row.alias_sku).trim() : '';
      if (productSku) bySku.set(productSku, id);
      if (aliasSku) bySku.set(aliasSku, id);
    }
  }

  if (barcodes.length) {
    const r = await query(
      `SELECT DISTINCT p.id, TRIM(bc.barcode) AS barcode
       FROM products p
       INNER JOIN barcodes bc ON bc.product_id = p.id
       WHERE ($1::bigint IS NULL OR p.profile_id = $1)
         AND TRIM(bc.barcode) = ANY($2::text[])`,
      [pid, barcodes]
    );
    for (const row of r.rows || []) {
      const bc = row.barcode ? String(row.barcode).trim() : '';
      if (bc) byBarcode.set(bc, row.id);
    }
  }

  return { bySku, byBarcode };
}

function resolveProductIdFromMaps({ sku, barcode }, maps) {
  const b = barcode != null ? String(barcode).trim() : '';
  const s = sku != null ? String(sku).trim() : '';
  if (b && maps?.byBarcode?.has(b)) return maps.byBarcode.get(b);
  if (s && maps?.bySku?.has(s)) return maps.bySku.get(s);
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

function ozonSupplyContentBundleId(supplyOrDetail) {
  if (!supplyOrDetail || typeof supplyOrDetail !== 'object') return null;
  const fromContent = supplyOrDetail.content?.bundle_id ?? supplyOrDetail.content?.bundleId;
  if (fromContent != null && String(fromContent).trim() !== '') return String(fromContent).trim();
  const direct = supplyOrDetail.bundle_id ?? supplyOrDetail.bundleId;
  if (direct != null && String(direct).trim() !== '') return String(direct).trim();
  return null;
}

function resolveOzonBundleId(order, supply) {
  const fromSupply = ozonSupplyContentBundleId(supply);
  if (fromSupply) return fromSupply;

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

function ozonSupplyOrderId(order) {
  if (!order || typeof order !== 'object') return null;
  const v = order.order_id ?? order.supply_order_id ?? order.id;
  return v != null && String(v).trim() !== '' ? v : null;
}

function ozonDetailsSuppliesList(result) {
  if (!result || typeof result !== 'object') return [];
  const nested = result.order ?? result.supply_order ?? result.supplyOrder;
  return result.supplies ?? result.supply ?? nested?.supplies ?? nested?.supply ?? [];
}

function isLikelyOzonHubWarehouseName(name) {
  const s = String(name ?? '').trim();
  if (!s) return true;
  if (/(_ХАБ|_HUB|ХАБ_|CROSSDOCK|КРОСС)/i.test(s)) return true;
  if (/^(МСК|MSK|SPB|СПБ)_/i.test(s) && s.includes('_')) return true;
  return false;
}

/** Рекурсивный поиск названия кластера размещения в ответе Ozon. */
function findOzonClusterNameInTree(node, depth = 0, seen = null) {
  if (node == null || depth > 8) return null;
  const set = seen ?? new Set();
  if (typeof node !== 'object') return null;
  if (set.has(node)) return null;
  set.add(node);

  if (Array.isArray(node)) {
    for (const el of node) {
      const hit = findOzonClusterNameInTree(el, depth + 1, set);
      if (hit) return hit;
    }
    return null;
  }

  const directKeys = [
    'macrocluster_name',
    'macroclusterName',
    'placement_cluster_name',
    'placementClusterName',
    'cluster_name',
    'clusterName',
    'cluster_to',
    'cluster_from',
  ];
  for (const key of directKeys) {
    const v = node[key];
    if (v != null && String(v).trim() !== '' && !isLikelyOzonHubWarehouseName(v)) {
      return String(v).trim();
    }
  }
  const mc = node.macrocluster ?? node.placement_cluster ?? node.placementCluster ?? node.cluster;
  if (mc && typeof mc === 'object') {
    const name = mc.name ?? mc.title ?? mc.label;
    if (name != null && String(name).trim() !== '' && !isLikelyOzonHubWarehouseName(name)) {
      return String(name).trim();
    }
  }

  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') {
      const hit = findOzonClusterNameInTree(val, depth + 1, set);
      if (hit) return hit;
    }
  }
  return null;
}

function collectOzonOperationIdCandidates(...nodes) {
  const ids = new Set();
  const push = (v) => {
    if (v == null) return;
    const s = String(v).trim();
    if (s && s !== '0') ids.add(s);
  };
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    push(node.operation_id);
    push(node.draft_operation_id);
    push(node.order_draft_id);
    push(node.draft_id);
  }
  return [...ids];
}

function matchOzonDraftClusters(clusters, bundleIds) {
  const bundles = new Set((bundleIds || []).map(String).filter(Boolean));
  const matched = new Set();
  for (const cl of clusters || []) {
    const cname = String(cl?.cluster_name ?? cl?.name ?? '').trim();
    if (!cname) continue;
    if (!bundles.size) {
      matched.add(cname);
      continue;
    }
    for (const wh of cl?.warehouses ?? []) {
      for (const b of wh?.bundle_ids ?? []) {
        const bid = b?.bundle_id ?? b?.id ?? b;
        if (bundles.has(String(bid))) matched.add(cname);
      }
      const restricted = wh?.restricted_bundle_id;
      if (restricted && bundles.has(String(restricted))) matched.add(cname);
    }
  }
  return matched.size ? [...matched].join(', ') : null;
}

async function resolveOzonClusterFromDraftInfo(operationIds, bundleIds, ozonApiOpts) {
  const ids = [...new Set((operationIds || []).map(String).filter(Boolean))];
  if (!ids.length) return null;

  for (const opId of ids) {
    const requests = [
      { path: '/v1/draft/create/info', body: { operation_id: opId } },
      { path: '/v2/draft/create/info', body: { operation_id: opId } },
    ];
    const draftNum = Number(opId);
    if (Number.isFinite(draftNum) && draftNum > 0) {
      requests.push({ path: '/v2/draft/create/info', body: { draft_id: draftNum } });
    }
    for (const { path, body } of requests) {
      try {
        const data = await integrationsService._ozonApiPost(path, body, ozonApiOpts);
        const hit = matchOzonDraftClusters(
          data?.result?.clusters ?? data?.clusters,
          bundleIds
        );
        if (hit) return hit;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

function ozonClusterFromBundleRow(row) {
  const candidates = [
    row?.macrocluster?.name,
    row?.macrocluster_name,
    row?.destination_cluster_name,
    row?.destination_cluster?.name,
    row?.placement_cluster_name,
    row?.cluster_name,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '' && !isLikelyOzonHubWarehouseName(c)) {
      return String(c).trim();
    }
  }
  return null;
}

function pickDominantOzonCluster(clusterQty) {
  let best = null;
  let max = 0;
  for (const [name, qty] of clusterQty.entries()) {
    if (qty > max) {
      max = qty;
      best = name;
    }
  }
  return best;
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
  const candidates = [
    row?.quantity,
    row?.quant,
    row?.count,
    row?.amount,
    row?.total_quantity,
    row?.planned_quantity,
    row?.item_quantity,
    row?.supply_quantity,
  ];
  for (const v of candidates) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
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

async function ozonPostSupplyOrderDetails(orderId, ozonApiOpts) {
  const id = Number(orderId) || orderId;
  if (id == null || String(id).trim() === '' || Number(id) <= 0) {
    const err = new Error('Invalid Ozon supply order id');
    err.statusCode = 400;
    throw err;
  }
  const bodies = [{ order_id: id }, { supply_order_id: id }];
  let lastError = null;
  for (const body of bodies) {
    try {
      return await integrationsService._ozonApiPost('/v1/supply-order/details', body, ozonApiOpts);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('Ozon supply-order/details failed');
}

function getOzonDetailsSupplyEntry(supply, orderDetails) {
  const supplyId = supply?.supply_id ?? supply?.id;
  if (supplyId == null || !orderDetails?.raw) return null;
  for (const s of ozonDetailsSuppliesList(orderDetails.raw)) {
    if (String(s?.supply_id ?? s?.id) === String(supplyId)) return s;
  }
  return null;
}

function parseOzonPositiveInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function fetchOzonSupplyOrderDetails(supplyOrderId, ozonApiOpts) {
  if (supplyOrderId == null || String(supplyOrderId).trim() === '') {
    return { bundleIds: [], shippingCluster: null, totalQuantity: 0, operationIds: [] };
  }
  try {
    const data = await ozonPostSupplyOrderDetails(supplyOrderId, ozonApiOpts);
    const result = data?.result ?? data ?? {};
    const supplies = ozonDetailsSuppliesList(result);
    const ids = [];
    const pushId = (v) => {
      if (v != null && String(v).trim() !== '') ids.push(String(v).trim());
    };
    for (const entry of result.bundle_ids ?? []) {
      pushId(typeof entry === 'object' ? entry?.bundle_id ?? entry?.bundleId : entry);
    }
    pushId(result.bundle_id ?? result.bundleId);
    for (const s of supplies) {
      pushId(ozonSupplyContentBundleId(s));
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
      result.cluster_to,
      result.cluster_from,
      result.destination_warehouse?.cluster_name,
      result.destination_warehouse?.macrocluster_name,
      result.storage_warehouse?.cluster_name,
      findOzonClusterNameInTree(result),
      ...supplies.flatMap((s) => [
        s?.macrocluster?.name,
        s?.macrocluster_name,
        s?.cluster_name,
        s?.placement_cluster_name,
        s?.cluster_to,
        s?.cluster_from,
        s?.destination_warehouse?.cluster_name,
        s?.destination_warehouse?.macrocluster_name,
        s?.storage_warehouse?.cluster_name,
        s?.storage_warehouse?.macrocluster_name,
      ]),
    ];
    let shippingCluster = null;
    for (const c of clusterCandidates) {
      if (c != null && String(c).trim() !== '' && !isLikelyOzonHubWarehouseName(c)) {
        shippingCluster = String(c).trim();
        break;
      }
    }

    const qtyCandidates = [
      result.total_quantity,
      result.total_item_count,
      result.total_items_count,
      result.items_count,
      ...supplies.flatMap((s) => [
        s?.total_quantity,
        s?.total_item_count,
        s?.total_items_count,
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
      operationIds: collectOzonOperationIdCandidates(result, ...supplies),
      raw: result,
    };
  } catch {
    return { bundleIds: [], shippingCluster: null, totalQuantity: 0, operationIds: [], raw: null };
  }
}

function resolveOzonSupplyMetaCounts(order, supply, orderDetails = null) {
  const values = [];
  const detailSupply = getOzonDetailsSupplyEntry(supply, orderDetails);
  if (detailSupply) {
    values.push(
      detailSupply.total_quantity,
      detailSupply.total_item_count,
      detailSupply.total_items_count,
      detailSupply.items_count,
      detailSupply.quantity,
      detailSupply.planned_quantity,
      detailSupply.total_items,
      detailSupply.package_units_count
    );
  }

  values.push(
    supply?.total_quantity,
    supply?.total_item_count,
    supply?.total_items_count,
    supply?.items_count,
    supply?.quantity,
    supply?.total_items,
    supply?.planned_quantity,
    supply?.package_units_count,
    order?.total_quantity,
    order?.total_item_count,
    order?.total_items_count,
    order?.items_count
  );

  const supplyId = supply?.supply_id ?? supply?.id;
  if (supplyId != null && orderDetails?.raw) {
    for (const s of ozonDetailsSuppliesList(orderDetails.raw)) {
      if (String(s?.supply_id ?? s?.id) !== String(supplyId)) continue;
      values.push(
        s?.total_quantity,
        s?.total_item_count,
        s?.total_items_count,
        s?.items_count,
        s?.quantity,
        s?.planned_quantity,
        s?.total_items,
        s?.package_units_count
      );
    }
  }

  for (const v of values) {
    const n = parseOzonPositiveInt(v);
    if (n > 0) return n;
  }

  for (const lines of [detailSupply?.items, supply?.items, supply?.lines, supply?.products]) {
    if (!Array.isArray(lines) || !lines.length) continue;
    const sum = lines.reduce((s, row) => s + parseOzonBundleRowQuantity(row), 0);
    if (sum > 0) return sum;
  }

  return 0;
}

function collectOzonBundleIdsForSupply(order, supply, orderDetails = null) {
  const ids = [];
  const push = (v) => {
    if (v != null && String(v).trim() !== '') ids.push(String(v).trim());
  };

  push(resolveOzonBundleId(order, supply));

  const supplyId = supply?.supply_id ?? supply?.id;
  for (const s of ozonDetailsSuppliesList(orderDetails?.raw ?? {})) {
    if (supplyId != null && String(s?.supply_id ?? s?.id) !== String(supplyId)) continue;
    push(ozonSupplyContentBundleId(s));
    push(s?.bundle_id ?? s?.bundleId);
    for (const entry of s?.bundle_ids ?? []) {
      push(typeof entry === 'object' ? entry?.bundle_id ?? entry?.bundleId : entry);
    }
  }

  if (!ids.length) {
    const detailSupplies = ozonDetailsSuppliesList(orderDetails?.raw ?? {});
    const orderSupplies = order?.supplies ?? [];
    const onlyOneSupply = detailSupplies.length <= 1 && orderSupplies.length <= 1;
    if (onlyOneSupply) {
      for (const id of orderDetails?.bundleIds ?? []) push(id);
    }
  }

  return [...new Set(ids)];
}

function resolveOzonPreviewItemCount({ items, totalCount, order, supply, orderDetails }) {
  const fromItems = sumSupplyItemsQuantity(items);
  if (fromItems > 0) return fromItems;

  const fromMeta = resolveOzonSupplyMetaCounts(order, supply, orderDetails);
  if (fromMeta > 0) return fromMeta;

  const parsedTotal = parseOzonPositiveInt(totalCount);
  if (parsedTotal > 0) return parsedTotal;

  const detailSupplies = ozonDetailsSuppliesList(orderDetails?.raw ?? {});
  const orderSupplies = order?.supplies ?? [];
  const supplyCount = Math.max(detailSupplies.length, orderSupplies.length, 1);
  if (supplyCount <= 1) {
    const fromDetails = parseOzonPositiveInt(orderDetails?.totalQuantity);
    if (fromDetails > 0) return fromDetails;
  }

  return 0;
}

async function fetchOzonBundleItems(
  bundleId,
  ozonApiOpts,
  profileId,
  { withTags = false, summaryOnly = false } = {}
) {
  const clusterQty = new Map();
  const addClusterQty = (localClusterQty) => {
    for (const [name, qty] of localClusterQty.entries()) {
      clusterQty.set(name, (clusterQty.get(name) || 0) + qty);
    }
  };

  if (summaryOnly) {
    try {
      const bundleData = await ozonApiPostWithRetry(
        '/v1/supply-order/bundle',
        { bundle_ids: [String(bundleId)], limit: 100 },
        ozonApiOpts
      );
      const parsed = parseOzonBundleResponse(bundleData);
      let qtySum = 0;
      const localClusterQty = new Map();
      for (const row of parsed.rows) {
        const qty = parseOzonBundleRowQuantity(row);
        qtySum += qty;
        const rowCluster = ozonClusterFromBundleRow(row);
        if (rowCluster && qty > 0) {
          localClusterQty.set(rowCluster, (localClusterQty.get(rowCluster) || 0) + qty);
        }
      }
      addClusterQty(localClusterQty);
      return {
        items: [],
        totalCount: Math.max(parsed.totalCount, qtySum),
        shippingCluster: pickDominantOzonCluster(clusterQty),
      };
    } catch {
      return { items: [], totalCount: 0, shippingCluster: null };
    }
  }

  let items = [];
  let reportedLineCount = 0;
  let reportedQtySum = 0;
  const rawRows = [];

  try {
    let lastId = '';
    for (let page = 0; page < 20; page++) {
      const body = { bundle_ids: [String(bundleId)], limit: 100 };
      if (lastId) body.last_id = lastId;
      const bundleData = await ozonApiPostWithRetry('/v1/supply-order/bundle', body, ozonApiOpts);
      const parsed = parseOzonBundleResponse(bundleData);
      if (parsed.totalCount > reportedLineCount) reportedLineCount = parsed.totalCount;
      for (const row of parsed.rows) {
        reportedQtySum += parseOzonBundleRowQuantity(row);
        if (parseOzonBundleRowQuantity(row) > 0) rawRows.push(row);
        const rowCluster = ozonClusterFromBundleRow(row);
        const qty = parseOzonBundleRowQuantity(row);
        if (rowCluster && qty > 0) {
          clusterQty.set(rowCluster, (clusterQty.get(rowCluster) || 0) + qty);
        }
      }
      if (!parsed.hasNext) break;
      if (!parsed.lastId || parsed.lastId === lastId) break;
      lastId = parsed.lastId;
    }

    const lookupEntries = rawRows.map((row) => ({
      sku: parseOzonBundleRowOfferId(row),
      barcode: row.barcode ?? row.bar_code ?? null,
    }));
    const productMaps = await batchResolveProductIds(lookupEntries, profileId);
    const batch = [];
    for (const row of rawRows) {
      const qty = parseOzonBundleRowQuantity(row);
      const offerId = parseOzonBundleRowOfferId(row);
      const barcode = row.barcode ?? row.bar_code ?? null;
      const productId = resolveProductIdFromMaps({ sku: offerId, barcode }, productMaps);
      const { placementZone, ozonTags } = parseOzonBundleRowMeta(row);
      batch.push({
        productId,
        quantity: qty,
        sku: offerId,
        barcode,
        mpOfferId: offerId,
        mpProductId: row.product_id != null ? String(row.product_id) : null,
        name: row.name ?? row.product_name ?? null,
        placementZone,
        ozonTags: withTags ? ozonTags : [],
        unresolved: productId == null,
      });
    }
    items = batch;
  } catch {
    /* bundle failed */
  }

  const qtyTotal = sumSupplyItemsQuantity(items);
  return {
    items,
    totalCount: Math.max(qtyTotal, reportedQtySum, reportedLineCount),
    shippingCluster: pickDominantOzonCluster(clusterQty),
  };
}

async function fetchOzonSupplyItems(
  order,
  supply,
  ozonApiOpts,
  profileId,
  orderDetails = null,
  {
    warehousesById = null,
    clusterByWarehouseId = null,
    macrolocalById = null,
    summaryOnly = false,
  } = {}
) {
  const supplyOrderId = ozonSupplyOrderId(order);
  const details =
    orderDetails ?? (await fetchOzonSupplyOrderDetails(supplyOrderId, ozonApiOpts));

  const bundleIds = collectOzonBundleIdsForSupply(order, supply, details);

  const detailSupplyEntry = getOzonDetailsSupplyEntry(supply, details);
  let totalCount = detailSupplyEntry
    ? parseOzonPositiveInt(
        detailSupplyEntry.total_quantity ??
          detailSupplyEntry.total_item_count ??
          detailSupplyEntry.total_items_count ??
          detailSupplyEntry.items_count
      )
    : 0;
  if (!totalCount) {
    const detailSupplies = ozonDetailsSuppliesList(details?.raw ?? {});
    const orderSupplies = order?.supplies ?? [];
    if (detailSupplies.length <= 1 && orderSupplies.length <= 1) {
      totalCount = parseOzonPositiveInt(details.totalQuantity);
    }
  }

  let items = [];
  const clusterQty = new Map();
  const addCluster = (name, qty = 1) => {
    if (!name) return;
    clusterQty.set(name, (clusterQty.get(name) || 0) + qty);
  };
  if (details.shippingCluster) addCluster(details.shippingCluster, 1000);

  const macrolocalCluster = resolveOzonMacrolocalClusterName(
    supply,
    order,
    details?.raw,
    macrolocalById
  );
  if (macrolocalCluster) addCluster(macrolocalCluster, 5000);

  for (const bundleId of bundleIds) {
    try {
      const fetched = await fetchOzonBundleItems(bundleId, ozonApiOpts, profileId, {
        withTags: false,
        summaryOnly,
      });
      if (!summaryOnly && fetched.items.length > items.length) items = fetched.items;
      const bundleQty = fetched.totalCount || sumSupplyItemsQuantity(fetched.items);
      if (bundleQty > totalCount) totalCount = bundleQty;
      if (fetched.shippingCluster) addCluster(fetched.shippingCluster, fetched.totalCount || 1);
    } catch {
      /* try next bundle_id */
    }
  }

  const detailSupply = detailSupplyEntry;
  const detailQty = detailSupply
    ? parseOzonPositiveInt(
        detailSupply.total_quantity ??
          detailSupply.total_item_count ??
          detailSupply.total_items_count ??
          detailSupply.items_count
      )
    : 0;
  if (detailQty > totalCount) totalCount = detailQty;

  if (!totalCount) totalCount = resolveOzonSupplyMetaCounts(order, supply, details);
  if (!totalCount && items.length) totalCount = sumSupplyItemsQuantity(items);

  const operationIds = [
    ...collectOzonOperationIdCandidates(order, supply),
    ...(details.operationIds ?? []),
  ];
  const draftCluster = await resolveOzonClusterFromDraftInfo(operationIds, bundleIds, ozonApiOpts);
  if (draftCluster) addCluster(draftCluster, 2000);

  const fromWarehouse = resolveOzonShippingCluster(
    order,
    supply,
    warehousesById,
    clusterByWarehouseId,
    details?.raw
  );
  if (fromWarehouse) addCluster(fromWarehouse, 500);

  const treeCluster =
    findOzonClusterNameInTree(supply) ||
    findOzonClusterNameInTree(order) ||
    findOzonClusterNameInTree(details?.raw);
  if (treeCluster) addCluster(treeCluster, 300);

  const shippingCluster =
    pickDominantOzonCluster(clusterQty) ||
    macrolocalCluster ||
    resolveOzonShippingCluster(order, supply, warehousesById, clusterByWarehouseId, details?.raw);

  return {
    items,
    totalCount,
    shippingCluster,
  };
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

function collectMacrolocalClusterIds(...nodes) {
  const ids = [];
  const push = (v) => {
    if (v == null) return;
    const s = String(v).trim();
    if (s && s !== '0') ids.push(s);
  };
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    push(node.macrolocal_cluster_id);
    push(node.macrolocalClusterId);
    const mc = node.macrolocal_cluster ?? node.macrolocalCluster;
    if (mc && typeof mc === 'object') {
      push(mc.id);
      push(mc.cluster_id);
      push(mc.macrolocal_cluster_id);
    }
  }
  return ids;
}

function resolveOzonMacrolocalClusterName(supply, order, detailsRaw, macrolocalById) {
  if (!macrolocalById?.size) return null;
  const supplyKey = supply?.supply_id ?? supply?.id;
  const detailSupplies = ozonDetailsSuppliesList(detailsRaw ?? {});
  const matchedDetail =
    supplyKey != null
      ? detailSupplies.find((s) => String(s?.supply_id ?? s?.id) === String(supplyKey))
      : detailSupplies[0];

  const idCandidates = collectMacrolocalClusterIds(
    matchedDetail,
    supply,
    order,
    ...(detailsRaw ? [detailsRaw] : []),
    ...detailSupplies
  );
  for (const id of idCandidates) {
    const name = macrolocalById.get(String(id));
    if (name) return name;
  }
  return null;
}

async function fetchOzonClusterMaps(ozonApiOpts) {
  const warehouseById = new Map();
  const macrolocalById = new Map();
  const addWarehouse = (clusterName, wh) => {
    const name = String(clusterName ?? '').trim();
    if (!name) return;
    const id = wh?.warehouse_id ?? wh?.id;
    if (id != null) warehouseById.set(String(id), name);
  };
  const addMacrolocal = (clusterName, mlId) => {
    const name = String(clusterName ?? '').trim();
    if (!name || mlId == null) return;
    const id = String(mlId).trim();
    if (id && id !== '0') macrolocalById.set(id, name);
  };
  const ingestClusters = (clusters) => {
    for (const cluster of clusters || []) {
      const clusterName = String(cluster?.name ?? cluster?.cluster_name ?? '').trim();
      if (!clusterName) continue;
      addMacrolocal(clusterName, cluster?.macrolocal_cluster_id ?? cluster?.macrolocalClusterId);
      const logistic = cluster?.logistic_clusters ?? cluster?.logisticClusters ?? [];
      for (const lc of logistic) {
        const lcName = String(lc?.name ?? clusterName).trim() || clusterName;
        addMacrolocal(lcName, lc?.macrolocal_cluster_id ?? lc?.macrolocalClusterId ?? cluster?.macrolocal_cluster_id);
        for (const wh of lc?.warehouses ?? []) {
          addWarehouse(lcName, wh);
        }
      }
      for (const wh of cluster?.warehouses ?? []) {
        addWarehouse(clusterName, wh);
      }
    }
  };
  for (const cluster_type of ['CLUSTER_TYPE_OZON', 'CLUSTER_TYPE_CIS']) {
    for (const path of ['/v1/cluster/list', '/v2/cluster/list']) {
      try {
        const data = await integrationsService._ozonApiPost(path, { cluster_type }, ozonApiOpts);
        ingestClusters(data?.result?.clusters ?? data?.clusters ?? []);
      } catch {
        /* v2 или тип кластера может быть недоступен */
      }
    }
  }
  return { warehouseById, macrolocalById };
}

async function fetchOzonStorageWarehouseClusterMap(ozonApiOpts) {
  const maps = await fetchOzonClusterMaps(ozonApiOpts);
  return maps.warehouseById;
}

function ozonWarehouseClusterName(wh, clusterByWarehouseId) {
  if (!wh || typeof wh !== 'object') return null;
  const whId = wh.warehouse_id ?? wh.id;
  if (whId != null && clusterByWarehouseId?.get) {
    const fromMap = clusterByWarehouseId.get(String(whId));
    if (fromMap) return fromMap;
  }
  const direct =
    wh.macrocluster?.name ??
    wh.macrocluster_name ??
    wh.placement_cluster_name ??
    wh.cluster?.name ??
    wh.cluster_name ??
    null;
  return direct != null && String(direct).trim() !== '' && !isLikelyOzonHubWarehouseName(direct)
    ? String(direct).trim()
    : null;
}

function resolveOzonShippingCluster(order, supply, warehousesById, clusterByWarehouseId, orderDetails = null) {
  const direct =
    supply?.cluster_name ??
    supply?.cluster?.name ??
    supply?.placement_cluster_name ??
    supply?.placement_cluster?.name ??
    supply?.macrocluster?.name ??
    supply?.macrocluster_name ??
    supply?.destination_warehouse?.cluster_name ??
    supply?.destination_warehouse?.macrocluster_name ??
    order?.cluster_name ??
    order?.placement_cluster_name ??
    order?.placement_cluster?.name ??
    order?.macrocluster?.name ??
    order?.macrocluster_name ??
    order?.destination_warehouse?.cluster_name ??
    null;
  if (direct != null && String(direct).trim() !== '' && !isLikelyOzonHubWarehouseName(direct)) {
    return String(direct).trim();
  }

  const supplyId = supply?.supply_id ?? supply?.id;
  const allDetailsSupplies = ozonDetailsSuppliesList(orderDetails ?? {});
  const detailsSupplies =
    supplyId != null
      ? allDetailsSupplies.filter((s) => String(s?.supply_id ?? s?.id) === String(supplyId))
      : allDetailsSupplies;
  const whCandidates = [
    supply?.destination_warehouse,
    supply?.destination_warehouse_id,
    supply?.supply_warehouse,
    supply?.supply_warehouse_id,
    order?.destination_warehouse,
    order?.destination_warehouse_id,
    ...detailsSupplies.flatMap((s) => [
      s?.destination_warehouse,
      s?.destination_warehouse_id,
      s?.supply_warehouse,
      s?.supply_warehouse?.warehouse_id,
      s?.final_warehouse_id,
    ]),
    supply?.storage_warehouse,
    supply?.storage_warehouse_id ?? supply?.storage_warehouse?.warehouse_id ?? supply?.storage_warehouse?.id,
    order?.storage_warehouse,
    order?.storage_warehouse_id,
  ];

  for (const whRef of whCandidates) {
    if (whRef == null) continue;
    if (typeof whRef === 'object') {
      const fromWh = ozonWarehouseClusterName(whRef, clusterByWarehouseId);
      if (fromWh) return fromWh;
      continue;
    }
    const whId = String(whRef);
    const fromCluster = clusterByWarehouseId?.get?.(whId);
    if (fromCluster) return fromCluster;
    const wh = warehousesById?.get?.(whId);
    const whCluster = ozonWarehouseClusterName(wh, clusterByWarehouseId);
    if (whCluster) return whCluster;
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

/** supply-requests API Яндекса принимает только FBY и LAAS (не FBS/DBS). */
const YM_SUPPLY_CAMPAIGN_TYPES = new Set(['FBY', 'LAAS']);

function ymCampaignNumericId(camp) {
  const id = camp?.id ?? camp?.campaignId;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ymIsSupplyCapableCampaign(camp) {
  const t = String(camp?.placementType ?? camp?.placement_type ?? '')
    .trim()
    .toUpperCase();
  return YM_SUPPLY_CAMPAIGN_TYPES.has(t);
}

/**
 * В интеграции часто сохранён FBS campaign_id (заказы/этикетки).
 * Для заявок на поставку берём FBY/LAAS из GET /v2/campaigns.
 * @returns {Promise<number[]>}
 */
async function resolveYmSupplyCampaignIds(apiKey, preferredCampaignId = null) {
  const data = await ymRequest('/v2/campaigns', { apiKey, method: 'GET' });
  const campaigns = data?.campaigns ?? data?.result?.campaigns ?? [];
  const supplyCapable = campaigns.filter(ymIsSupplyCapableCampaign);
  const ids = [];
  const seen = new Set();
  const preferRaw =
    preferredCampaignId != null && String(preferredCampaignId).trim() !== ''
      ? Number(preferredCampaignId)
      : NaN;

  const push = (id) => {
    if (!Number.isFinite(id) || id < 1 || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  if (Number.isFinite(preferRaw) && preferRaw > 0) {
    const preferCamp = campaigns.find((c) => ymCampaignNumericId(c) === preferRaw);
    if (preferCamp && ymIsSupplyCapableCampaign(preferCamp)) push(preferRaw);
  }
  for (const c of supplyCapable) push(ymCampaignNumericId(c));

  if (!ids.length) {
    const available = campaigns
      .map((c) => {
        const id = ymCampaignNumericId(c);
        const t = String(c?.placementType ?? '').trim() || '?';
        return id != null ? `${id}(${t})` : null;
      })
      .filter(Boolean)
      .join(', ');
    const err = new Error(
      'Не найдена кампания FBY/LAAS для поставок Яндекс.Маркета. ' +
        'В настройках интеграции указан кабинет FBS — поставки доступны только у FBO-магазина (FBY). ' +
        (available ? `Доступные кампании: ${available}.` : 'Проверьте Api-Key и доступ к кабинету FBY.')
    );
    err.statusCode = 400;
    throw err;
  }
  return ids;
}

/** Дата заявки для локального фильтра (API date-фильтр смотрит на requestedDate и часто пуст у VDC). */
function ymSupplyRequestActivityAt(req) {
  const raw =
    req?.updatedAt ??
    req?.plannedDate ??
    req?.createdAt ??
    req?.targetLocation?.requestedDate ??
    req?.transitLocation?.requestedDate ??
    null;
  if (raw == null || raw === '') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymSupplyRequestWithinDaysBack(req, daysBack) {
  const n = Number(daysBack);
  if (!Number.isFinite(n) || n <= 0) return true;
  const at = ymSupplyRequestActivityAt(req);
  if (!at) return true;
  const sinceMs = Date.now() - Math.max(1, Math.min(365, n)) * 24 * 60 * 60 * 1000;
  return at.getTime() >= sinceMs;
}

/**
 * Родительские VDC-заявки без номера отгрузки в кабинете дублируют child —
 * для импорта берём child (с warehouseRequestId / marketplaceRequestId).
 */
function ymSupplyRequestIsImportable(req) {
  const subtype = String(req?.subtype ?? '').trim().toUpperCase();
  if (subtype !== 'VIRTUAL_DISTRIBUTION_CENTER') return true;
  const mpId = req?.id?.marketplaceRequestId ?? req?.marketplaceRequestId;
  const whId = req?.id?.warehouseRequestId ?? req?.warehouseRequestId;
  return (mpId != null && String(mpId).trim() !== '') || (whId != null && String(whId).trim() !== '');
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

function firstNonEmptyWbString(...values) {
  for (const v of values) {
    const s = v != null ? String(v).trim() : '';
    if (s) return s;
  }
  return null;
}

/** Убираем префикс «СЦ » для колонки кластера — в UI WB часто «Абакан 2». */
export function normalizeWbSupplyClusterLabel(name) {
  const s = firstNonEmptyWbString(name);
  if (!s) return null;
  const trimmed = s.replace(/^СЦ\s+/i, '').trim();
  return trimmed || s;
}

export function resolveWbPlacementCluster(row) {
  const candidates = [
    row?.clusterName,
    row?.cluster_name,
    row?.warehouseCluster,
    row?.warehouseClusterName,
    row?.destinationWarehouseName,
    row?.destination_warehouse_name,
    row?.warehouseName,
    row?.warehouse_name,
    row?.actualWarehouseName,
    row?.actual_warehouse_name,
    row?.transitWarehouseName,
    row?.transit_warehouse_name,
    row?.virtualTypeName,
    row?.virtual_type_name,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
  return null;
}

/** Склад и кластер из строки списка + деталей GET /api/v1/supplies/{ID}. */
export function resolveWbSupplyWarehouseFields(row, details = null) {
  const merged =
    details && typeof details === 'object' && !Array.isArray(details)
      ? { ...row, ...details }
      : row || {};

  const marketplaceWarehouseName = firstNonEmptyWbString(
    merged.actualWarehouseName,
    merged.actual_warehouse_name,
    merged.warehouseName,
    merged.warehouse_name,
    merged.warehouse,
    merged.warehouseAddress,
    merged.transitWarehouseName,
    merged.transit_warehouse_name
  );

  const marketplaceWarehouseId = firstNonEmptyWbString(
    merged.actualWarehouseID,
    merged.actualWarehouseId,
    merged.actual_warehouse_id,
    merged.warehouseID,
    merged.warehouseId,
    merged.warehouse_id
  );

  const clusterRaw =
    resolveWbPlacementCluster(merged) ||
    firstNonEmptyWbString(merged.warehouseName, merged.warehouse_name) ||
    marketplaceWarehouseName;

  return {
    marketplaceWarehouseName,
    marketplaceWarehouseId,
    shippingCluster: normalizeWbSupplyClusterLabel(clusterRaw) || clusterRaw,
  };
}

async function fetchWbSupplyDetails(apiKey, supplyApiId) {
  const id = supplyApiId != null ? String(supplyApiId).trim() : '';
  if (!id) return null;
  try {
    const data = await wbFbwRequest(`/api/v1/supplies/${encodeURIComponent(id)}`, {
      apiKey,
      method: 'GET',
      timeoutMs: 30000,
    });
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
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
  if (s.includes('FINISH') || s.includes('COMPLET')) return 'closed';
  if (s.includes('TRANSIT') || s.includes('DELIVER') || s.includes('SHIPPED')) return 'shipped';
  // ACCEPTED_BY_WAREHOUSE_* — активная поставка, не путать с общим «ACCEPT»
  if (s.includes('ACCEPTED_BY_WAREHOUSE') || s.includes('READY') || s.includes('PREPAR')) {
    return 'ready_for_supply';
  }
  if (s.includes('PACK')) return 'packed';
  if (s.includes('ACCEPT')) return 'closed';
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

/** ID заявок для /v3/supply-order/get (внутренний order_id, не номер отгрузки из ЛК). */
function buildOzonApiOrderIds(ermSupply) {
  const ids = new Set();
  const extOrderId =
    ermSupply?.externalOrderId != null ? String(ermSupply.externalOrderId).trim() : '';
  if (extOrderId) ids.add(extOrderId);
  return [...ids];
}

function mergeOzonOrderLists(existing, incoming) {
  const byId = new Map();
  for (const order of [...(existing || []), ...(incoming || [])]) {
    const id = ozonSupplyOrderId(order);
    if (id != null) byId.set(String(id), order);
  }
  return [...byId.values()];
}

async function fetchOzonOrdersViaImportList(ozonApiOpts, { daysBack = 90 } = {}) {
  const orderIds = await fetchOzonSupplyOrderIdsForImport(daysBack, ozonApiOpts, {
    states: OZON_SUPPLY_IMPORT_STATES,
  });
  let orders = [];
  const warehousesById = new Map();
  for (let i = 0; i < orderIds.length; i += 50) {
    const chunk = orderIds.slice(i, i + 50);
    try {
      const fetched = await fetchOzonSupplyOrdersByIds(chunk, ozonApiOpts);
      orders = mergeOzonOrderLists(orders, fetched.orders);
      for (const [k, v] of fetched.warehousesById) warehousesById.set(k, v);
    } catch (e) {
      console.warn('[FboImport] Ozon get import list chunk:', e?.message || e);
    }
  }
  return { orders, warehousesById };
}

function ozonImportOrdersCacheKey(ozonApiOpts) {
  return `${ozonApiOpts?.profileId ?? 'null'}:${ozonApiOpts?.organizationId ?? 'null'}`;
}

async function getOzonImportOrdersCached(ozonApiOpts, cache, { daysBack = 90 } = {}) {
  const key = ozonImportOrdersCacheKey(ozonApiOpts);
  if (!cache.has(key)) {
    cache.set(key, await fetchOzonOrdersViaImportList(ozonApiOpts, { daysBack }));
  }
  return cache.get(key);
}

async function resolveOzonOrderSupplyForErmSupply(ermSupply, ozonApiOpts, { ozonOrdersCache = null } = {}) {
  const apiOrderIds = buildOzonApiOrderIds(ermSupply);
  if (apiOrderIds.length) {
    try {
      const { orders } = await fetchOzonSupplyOrdersByIds(apiOrderIds, ozonApiOpts);
      const match = findOzonOrderSupplyMatch(orders, ermSupply);
      if (match) return match;
    } catch {
      /* поиск по списку ниже */
    }
  }

  const { orders } =
    ozonOrdersCache != null
      ? await getOzonImportOrdersCached(ozonApiOpts, ozonOrdersCache, { daysBack: 90 })
      : await fetchOzonOrdersViaImportList(ozonApiOpts, { daysBack: 90 });
  const match = findOzonOrderSupplyMatch(orders, ermSupply);
  if (match) return match;

  const err = new Error(
    'Не удалось найти поставку в Ozon по сохранённому номеру отгрузки. Проверьте номер в карточке и настройки интеграции.'
  );
  err.statusCode = 400;
  throw err;
}

function ermOzonExternalNumber(order, supply) {
  const supplyOrderId = ozonSupplyOrderId(order);
  const supplyId = supply?.supply_id ?? supply?.id;
  const supplyIdStr = supplyId != null ? String(supplyId).trim() : '';
  const baseNumber = String(
    order?.order_number ?? order?.supply_order_number ?? supplyOrderId ?? ''
  ).trim();
  return baseNumber && supplyIdStr && baseNumber !== supplyIdStr
    ? `${baseNumber}-${supplyIdStr}`
    : baseNumber || supplyIdStr;
}

function findOzonOrderSupplyMatch(orders, ermSupply) {
  const targetSupplyId =
    ermSupply.externalSupplyId != null ? String(ermSupply.externalSupplyId).trim() : '';
  const targetExtNum =
    ermSupply.externalShipmentNumber != null ? String(ermSupply.externalShipmentNumber).trim() : '';

  for (const { order, supply } of flattenOzonSupplyOrders(orders)) {
    const supplyId = supply?.supply_id ?? supply?.id;
    const supplyIdStr = supplyId != null ? String(supplyId).trim() : '';
    const externalNumber = ermOzonExternalNumber(order, supply);
    const supplyOrderId = ozonSupplyOrderId(order);
    const baseNumber = String(
      order?.order_number ?? order?.supply_order_number ?? supplyOrderId ?? ''
    ).trim();

    if (targetSupplyId && supplyIdStr && supplyIdStr === targetSupplyId) {
      return { order, supply };
    }
    if (targetExtNum && externalNumber === targetExtNum) {
      return { order, supply };
    }
    if (targetExtNum && baseNumber === targetExtNum) {
      return { order, supply };
    }
    if (targetSupplyId && supplyOrderId != null && String(supplyOrderId) === targetSupplyId) {
      return { order, supply };
    }
  }
  return null;
}

function buildOzonItemZoneLookup(ozonItems) {
  const map = new Map();
  const put = (key, meta) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, meta);
  };
  for (const it of ozonItems || []) {
    const meta = {
      placementZone: it.placementZone ?? null,
      ozonTags: Array.isArray(it.ozonTags) ? it.ozonTags : [],
    };
    const sku = it.sku ?? it.mpOfferId;
    if (sku != null && String(sku).trim()) {
      put(String(sku).trim().toUpperCase(), meta);
    }
    if (it.barcode != null && String(it.barcode).trim()) {
      put(String(it.barcode).trim(), meta);
    }
    if (it.mpProductId != null && String(it.mpProductId).trim()) {
      put(`mp:${String(it.mpProductId).trim()}`, meta);
    }
  }
  return map;
}

function lookupOzonItemZone(lookup, ermItem) {
  const keys = [
    ermItem.sku ? String(ermItem.sku).trim().toUpperCase() : '',
    ermItem.barcode ? String(ermItem.barcode).trim() : '',
    ermItem.mpOfferId ? String(ermItem.mpOfferId).trim().toUpperCase() : '',
    ermItem.mpProductId ? `mp:${String(ermItem.mpProductId).trim()}` : '',
  ].filter(Boolean);
  for (const k of keys) {
    const hit = lookup.get(k);
    if (hit) return hit;
  }
  return null;
}

function ozonItemMatchKeys(ozonItem) {
  const keys = [];
  const sku = ozonItem.sku ?? ozonItem.mpOfferId;
  if (sku != null && String(sku).trim()) keys.push(String(sku).trim().toUpperCase());
  if (ozonItem.mpOfferId != null && String(ozonItem.mpOfferId).trim()) {
    keys.push(String(ozonItem.mpOfferId).trim().toUpperCase());
  }
  if (ozonItem.barcode != null && String(ozonItem.barcode).trim()) {
    keys.push(String(ozonItem.barcode).trim());
  }
  if (ozonItem.mpProductId != null && String(ozonItem.mpProductId).trim()) {
    keys.push(`mp:${String(ozonItem.mpProductId).trim()}`);
  }
  return [...new Set(keys)];
}

function ermItemMatchKeys(ermRow) {
  const keys = [];
  if (ermRow.sku != null && String(ermRow.sku).trim()) {
    keys.push(String(ermRow.sku).trim().toUpperCase());
  }
  if (ermRow.mp_offer_id != null && String(ermRow.mp_offer_id).trim()) {
    keys.push(String(ermRow.mp_offer_id).trim().toUpperCase());
  }
  if (ermRow.barcode != null && String(ermRow.barcode).trim()) {
    keys.push(String(ermRow.barcode).trim());
  }
  if (ermRow.mp_product_id != null && String(ermRow.mp_product_id).trim()) {
    keys.push(`mp:${String(ermRow.mp_product_id).trim()}`);
  }
  return keys;
}

function ozonItemMatchesErm(ozonItem, ermRow) {
  const ermPid = ermRow.product_id != null ? Number(ermRow.product_id) : NaN;
  const ozPid = ozonItem.productId != null ? Number(ozonItem.productId) : NaN;
  if (Number.isFinite(ermPid) && ermPid > 0 && ermPid === ozPid) return true;
  const ermMpPid =
    ermRow.mp_product_id != null && String(ermRow.mp_product_id).trim() !== ''
      ? String(ermRow.mp_product_id).trim()
      : null;
  const ozMpPid =
    ozonItem.mpProductId != null && String(ozonItem.mpProductId).trim() !== ''
      ? String(ozonItem.mpProductId).trim()
      : null;
  if (ermMpPid && ozMpPid && ermMpPid === ozMpPid) return true;
  const ozKeys = new Set(ozonItemMatchKeys(ozonItem));
  return ermItemMatchKeys(ermRow).some((k) => ozKeys.has(k));
}

function findOzonItemIndexForErm(ozonItems, ermRow, usedIndices) {
  for (let i = 0; i < ozonItems.length; i++) {
    if (usedIndices.has(i)) continue;
    if (ozonItemMatchesErm(ozonItems[i], ermRow)) return i;
  }
  return -1;
}

function findOzonItemIndexByProductId(ozonItems, productId, usedIndices) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return -1;
  for (let i = 0; i < ozonItems.length; i++) {
    if (usedIndices.has(i)) continue;
    const ozPid = Number(ozonItems[i].productId);
    if (ozPid === pid) return i;
  }
  return -1;
}

function findUnusedErmRowForOzon(ermRows, usedErm, ozonItem) {
  const ozPid = ozonItem.productId != null ? Number(ozonItem.productId) : NaN;
  const ozBc = ozonItem.barcode != null ? String(ozonItem.barcode).trim() : '';
  const ozSkuRaw = ozonItem.sku ?? ozonItem.mpOfferId;
  const ozSku = ozSkuRaw != null ? String(ozSkuRaw).trim().toUpperCase() : '';

  if (Number.isFinite(ozPid) && ozPid > 0) {
    for (const row of ermRows) {
      if (usedErm.has(row.id)) continue;
      const ermPid = row.product_id != null ? Number(row.product_id) : NaN;
      if (ermPid === ozPid) return row;
    }
  }
  if (ozBc) {
    for (const row of ermRows) {
      if (usedErm.has(row.id)) continue;
      if (row.barcode != null && String(row.barcode).trim() === ozBc) return row;
    }
  }
  if (ozSku) {
    for (const row of ermRows) {
      if (usedErm.has(row.id)) continue;
      if (ermItemMatchKeys(row).some((k) => k === ozSku)) return row;
    }
  }
  return null;
}

function ozonItemReservedForErm(ozonItems, ermRow, usedOzon) {
  const pid = ermRow.product_id != null ? Number(ermRow.product_id) : NaN;
  if (!Number.isFinite(pid) || pid <= 0) return false;
  for (let i = 0; i < ozonItems.length; i++) {
    if (usedOzon.has(i)) continue;
    if (Number(ozonItems[i].productId) === pid) return true;
  }
  return false;
}

async function getSupplyItemPackedQty(itemId) {
  const r = await query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS packed
     FROM fbo_supply_cargo_contents
     WHERE fbo_supply_item_id = $1`,
    [itemId]
  );
  return r.rows?.[0]?.packed ?? 0;
}

async function transferCargoContentsBetweenItems(fromItemId, toItemId) {
  const fromId = Number(fromItemId);
  const toId = Number(toItemId);
  if (!Number.isFinite(fromId) || !Number.isFinite(toId) || fromId === toId) return;

  const contentsR = await query(
    `SELECT id, cargo_unit_id, quantity
     FROM fbo_supply_cargo_contents
     WHERE fbo_supply_item_id = $1
     ORDER BY id`,
    [fromId]
  );
  for (const cc of contentsR.rows || []) {
    const existingR = await query(
      `SELECT id, quantity FROM fbo_supply_cargo_contents
       WHERE cargo_unit_id = $1 AND fbo_supply_item_id = $2
       LIMIT 1`,
      [cc.cargo_unit_id, toId]
    );
    if (existingR.rows?.length) {
      const merged = (Number(existingR.rows[0].quantity) || 0) + (Number(cc.quantity) || 0);
      await query(`UPDATE fbo_supply_cargo_contents SET quantity = $1 WHERE id = $2`, [
        merged,
        existingR.rows[0].id,
      ]);
      await query(`DELETE FROM fbo_supply_cargo_contents WHERE id = $1`, [cc.id]);
    } else {
      await query(`UPDATE fbo_supply_cargo_contents SET fbo_supply_item_id = $1 WHERE id = $2`, [
        toId,
        cc.id,
      ]);
    }
  }
}

async function applyMpItemToErmSupplyRow(row, mpItem, { updatePlacement = false } = {}) {
  const packed = await getSupplyItemPackedQty(row.id);
  const mpQty = parseInt(mpItem.quantity, 10) || 0;
  const planQty = Math.max(mpQty, packed);
  const curQty = parseInt(row.quantity, 10) || 0;
  const curMpQty = parseInt(row.mp_quantity, 10) || 0;
  const newZone = updatePlacement ? (mpItem.placementZone ?? null) : row.placement_zone ?? null;
  const newTagsJson = updatePlacement
    ? JSON.stringify(mpItem.ozonTags || [])
    : parseOzonTagsForCompare(row.ozon_tags);
  const oldZone = row.placement_zone != null ? String(row.placement_zone).trim() : null;
  const zoneEqual = updatePlacement ? (oldZone || null) === (newZone || null) : true;
  const tagsEqual = updatePlacement
    ? parseOzonTagsForCompare(row.ozon_tags) === newTagsJson
    : true;
  const resolvedProductId = mpItem.productId ?? row.product_id ?? null;

  if (
    planQty === curQty &&
    curMpQty === mpQty &&
    zoneEqual &&
    tagsEqual &&
    (resolvedProductId == null || Number(row.product_id) === Number(resolvedProductId))
  ) {
    return { changed: false };
  }

  await query(
    `UPDATE fbo_supply_items
     SET quantity = $1,
         mp_quantity = $2,
         placement_zone = $3,
         ozon_tags = $4::jsonb,
         product_id = COALESCE($5, product_id),
         sku = COALESCE(NULLIF(TRIM(sku), ''), $6),
         barcode = COALESCE(NULLIF(TRIM(barcode), ''), $7),
         mp_offer_id = COALESCE(NULLIF(TRIM(mp_offer_id), ''), $8),
         mp_product_id = COALESCE(NULLIF(TRIM(mp_product_id), ''), $9),
         name = COALESCE(NULLIF(TRIM(name), ''), $10),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $11`,
    [
      planQty,
      mpQty,
      newZone,
      newTagsJson,
      resolvedProductId,
      mpItem.sku ?? mpItem.mpOfferId ?? null,
      mpItem.barcode ?? null,
      mpItem.mpOfferId ?? mpItem.sku ?? null,
      mpItem.mpProductId ?? null,
      mpItem.name ?? null,
      row.id,
    ]
  );
  return { changed: true };
}

async function ensureErmSupplyRowProductIds(ermRows, { profileId } = {}) {
  for (const row of ermRows) {
    const cur = row.product_id != null ? Number(row.product_id) : NaN;
    if (Number.isFinite(cur) && cur > 0) continue;
    const pid = await resolveProductId({
      sku: row.sku ?? row.mp_offer_id,
      barcode: row.barcode,
      profileId,
    });
    if (!pid) continue;
    row.product_id = pid;
    await query(
      `UPDATE fbo_supply_items SET product_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [pid, row.id]
    );
  }
}

async function consolidateDuplicateSupplyItemsByProduct(supplyId) {
  const dupsR = await query(
    `SELECT product_id, array_agg(id ORDER BY id) AS ids
     FROM fbo_supply_items
     WHERE fbo_supply_id = $1 AND product_id IS NOT NULL
     GROUP BY product_id
     HAVING COUNT(*) > 1`,
    [supplyId]
  );
  let merged = 0;
  for (const group of dupsR.rows || []) {
    const ids = group.ids || [];
    if (ids.length < 2) continue;
    let keeperId = ids[0];
    let keeperPacked = await getSupplyItemPackedQty(keeperId);
    for (const id of ids.slice(1)) {
      const packed = await getSupplyItemPackedQty(id);
      if (packed > keeperPacked) {
        keeperId = id;
        keeperPacked = packed;
      }
    }
    for (const id of ids) {
      if (id === keeperId) continue;
      await transferCargoContentsBetweenItems(id, keeperId);
      await query(`DELETE FROM fbo_supply_items WHERE id = $1`, [id]);
      merged += 1;
    }
  }
  return merged;
}

function parseOzonTagsForCompare(v) {
  if (!v) return '[]';
  if (Array.isArray(v)) return JSON.stringify(v.map((t) => String(t).trim()).filter(Boolean));
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parseOzonTagsForCompare(parsed);
    } catch {
      /* ignore */
    }
  }
  return '[]';
}

function wbGoodRowToMpItem(g) {
  const qty = parseInt(
    g.quantity ?? g.count ?? g.amount ?? g.readyForSaleQuantity ?? 0,
    10
  );
  const sku =
    g.vendorCode ?? g.supplierArticle ?? g.supplierVendorCode ?? g.sku ?? null;
  const barcode = g.barcode ?? g.barCode ?? g.barcodes?.[0] ?? null;
  return {
    quantity: qty,
    sku,
    barcode,
    mpOfferId: sku,
    mpProductId:
      g.nmID != null ? String(g.nmID) : g.nmId != null ? String(g.nmId) : null,
    name: g.name ?? g.subject ?? g.brand ?? null,
    productId: null,
  };
}

async function mapWbGoodsToMpItems(list, { profileId } = {}) {
  const items = [];
  for (const g of list || []) {
    const row = wbGoodRowToMpItem(g);
    if (!row.quantity || row.quantity <= 0) continue;
    row.productId = await resolveProductId({
      sku: row.sku,
      barcode: row.barcode,
      profileId,
    });
    items.push(row);
  }
  return items;
}

async function fetchWbSuppliesListRows(apiKey, daysBack = 365) {
  const listData = await wbFbwRequest('/api/v1/supplies', {
    apiKey,
    method: 'POST',
    body: buildWbSuppliesListBody(daysBack),
  });
  let rows = parseWbSuppliesListResponse(listData);
  if (!rows.length) {
    const fallbackData = await wbFbwRequest('/api/v1/supplies', { apiKey, method: 'POST', body: {} });
    rows = parseWbSuppliesListResponse(fallbackData);
  }
  return rows;
}

async function resolveWbSupplyRowForErmSupply(supply, apiKey) {
  const extId = supply.externalSupplyId != null ? String(supply.externalSupplyId).trim() : '';
  const extNum =
    supply.externalShipmentNumber != null ? String(supply.externalShipmentNumber).trim() : '';
  if (!extId && !extNum) return null;

  const rows = await fetchWbSuppliesListRows(apiKey);
  if (extId) {
    const byId = rows.find((row) => {
      const gid = wbSupplyGoodsApiId(row);
      return gid && gid === extId;
    });
    if (byId) return byId;
  }
  if (extNum) {
    return rows.find((row) => wbExternalShipmentNumber(row) === extNum) || null;
  }
  return null;
}

async function resolveYmSupplyRequestForErmSupply(supply, { profileId } = {}) {
  const ymConfig = await integrationsService.getMarketplaceConfig('yandex', {
    profileId,
    organizationId: supply.organizationId ?? null,
  });
  const apiKey = ymConfig?.api_key ?? ymConfig?.apiKey;
  const preferredCampaignId = ymConfig?.campaign_id ?? ymConfig?.campaignId;
  if (!apiKey || !ymApiKeyHeader(apiKey)) return null;

  const targetId = supply.externalSupplyId != null ? String(supply.externalSupplyId).trim() : '';
  const targetNum =
    supply.externalShipmentNumber != null ? String(supply.externalShipmentNumber).trim() : '';
  if (!targetId && !targetNum) return null;

  let campaignIds;
  try {
    campaignIds = await resolveYmSupplyCampaignIds(apiKey, preferredCampaignId);
  } catch {
    return null;
  }

  for (const campaignId of campaignIds) {
    let listData;
    try {
      // Без requestDateFrom/To: API фильтрует по requestedDate, у VDC-поставок она часто пустая.
      listData = await ymRequest(
        `/v2/campaigns/${encodeURIComponent(String(campaignId))}/supply-requests?limit=100`,
        {
          apiKey,
          method: 'POST',
          body: { requestTypes: ['SUPPLY'] },
        }
      );
    } catch {
      continue;
    }
    const requests = listData?.result?.requests ?? listData?.requests ?? [];
    for (const req of requests) {
      if (!ymSupplyRequestIsImportable(req)) continue;
      if (!ymSupplyRequestWithinDaysBack(req, 365)) continue;
      const reqId = req.id?.id ?? req.id ?? req.requestId;
      const reqIdStr = reqId != null ? String(reqId).trim() : '';
      const extNum = String(
        req.id?.warehouseRequestId ?? req.warehouseRequestId ?? reqIdStr ?? ''
      ).trim();
      if (targetId && reqIdStr === targetId) return { req, campaignId };
      if (targetNum && (extNum === targetNum || reqIdStr === targetNum)) {
        return { req, campaignId };
      }
      const mpNum = String(req.id?.marketplaceRequestId ?? req.marketplaceRequestId ?? '').trim();
      if (targetNum && mpNum && mpNum === targetNum) return { req, campaignId };
    }
  }
  return null;
}

async function fetchMarketplaceStatusForSupply(supply, { profileId, ozonOrdersCache = null } = {}) {
  const mp = String(supply.marketplace || 'ozon').trim().toLowerCase();
  const organizationId = supply.organizationId ?? null;

  if (mp === 'ozon') {
    const ozonCfg = await integrationsService.getMarketplaceConfig('ozon', { profileId, organizationId });
    const clientId = ozonCfg?.client_id ?? ozonCfg?.clientId;
    const apiKey = ozonCfg?.api_key ?? ozonCfg?.apiKey;
    if (!clientId || !apiKey) {
      const err = new Error('Не настроены Client ID и API Key Ozon');
      err.statusCode = 400;
      throw err;
    }
    const ozonApiOpts = { profileId, organizationId, ozonOverride: ozonCfg };
    const { order, supply: ozonSupply } = await resolveOzonOrderSupplyForErmSupply(supply, ozonApiOpts, {
      ozonOrdersCache,
    });
    const rawState = ozonSupply?.state ?? order?.state ?? order?.status ?? null;
    return { status: mapOzonStateToStatus(rawState), rawState: rawState != null ? String(rawState) : null };
  }

  if (mp === 'wb' || mp.includes('wild')) {
    const wbConfig = await integrationsService.getMarketplaceConfig('wildberries', { profileId, organizationId });
    const apiKey = wbConfig?.api_key ?? wbConfig?.apiKey;
    if (!apiKey || !String(apiKey).trim()) {
      const err = new Error('Не настроен API-ключ Wildberries (FBW)');
      err.statusCode = 400;
      throw err;
    }
    const row = await resolveWbSupplyRowForErmSupply(supply, apiKey);
    if (!row) {
      const err = new Error('Поставка не найдена в Wildberries по номеру отгрузки');
      err.statusCode = 404;
      throw err;
    }
    const rawState = row.statusName ?? row.status ?? row.statusID ?? null;
    return {
      status: mapWbStateToStatus(rawState),
      rawState: rawState != null ? String(rawState) : null,
    };
  }

  if (mp === 'ym' || mp.includes('yandex')) {
    const hit = await resolveYmSupplyRequestForErmSupply(supply, { profileId });
    if (!hit?.req) {
      const err = new Error('Заявка не найдена в Яндекс.Маркете по номеру отгрузки');
      err.statusCode = 404;
      throw err;
    }
    const rawState = hit.req.status ?? null;
    return {
      status: mapYmStateToStatus(rawState),
      rawState: rawState != null ? String(rawState) : null,
    };
  }

  const err = new Error(`Синхронизация статуса не поддерживается для маркетплейса: ${mp}`);
  err.statusCode = 400;
  throw err;
}

async function resolveWbGoodsApiIdForSupply(supply, apiKey) {
  const row = await resolveWbSupplyRowForErmSupply(supply, apiKey);
  return row ? wbSupplyGoodsApiId(row) : null;
}

async function fetchWbMpItemsForSupply(supply, { profileId } = {}) {
  const wbConfig = await integrationsService.getMarketplaceConfig('wildberries', {
    profileId,
    organizationId: supply.organizationId ?? null,
  });
  const apiKey = wbConfig?.api_key ?? wbConfig?.apiKey;
  if (!apiKey || !String(apiKey).trim()) {
    const err = new Error(
      'Не настроен API-ключ Wildberries. Укажите токен категории «Поставки» (FBW) в «Интеграции».'
    );
    err.statusCode = 400;
    throw err;
  }

  const goodsApiId = await resolveWbGoodsApiIdForSupply(supply, apiKey);
  if (!goodsApiId) {
    const err = new Error(
      'Не удалось определить ID поставки WB — укажите номер отгрузки или ID поставки в карточке'
    );
    err.statusCode = 400;
    throw err;
  }

  const goodsData = await wbFbwRequest(
    `/api/v1/supplies/${encodeURIComponent(goodsApiId)}/goods`,
    { apiKey, method: 'GET', timeoutMs: 30000 }
  );
  return mapWbGoodsToMpItems(parseWbGoodsResponse(goodsData), { profileId });
}

async function fetchYmMpItemsForSupply(supply, { profileId } = {}) {
  const ymConfig = await integrationsService.getMarketplaceConfig('yandex', {
    profileId,
    organizationId: supply.organizationId ?? null,
  });
  const apiKey = ymConfig?.api_key ?? ymConfig?.apiKey;
  const preferredCampaignId = ymConfig?.campaign_id ?? ymConfig?.campaignId;
  if (!apiKey || !ymApiKeyHeader(apiKey)) {
    const err = new Error('Не настроен API-ключ Яндекс Маркета в «Интеграции».');
    err.statusCode = 400;
    throw err;
  }

  const requestIdRaw =
    supply.externalSupplyId != null ? String(supply.externalSupplyId).trim() : '';
  if (!requestIdRaw) {
    const err = new Error('У поставки не указан ID заявки на маркетплейсе');
    err.statusCode = 400;
    throw err;
  }
  const requestId = Number.isFinite(Number(requestIdRaw)) ? Number(requestIdRaw) : requestIdRaw;

  const hit = await resolveYmSupplyRequestForErmSupply(supply, { profileId });
  const campaignIds = hit?.campaignId
    ? [hit.campaignId]
    : await resolveYmSupplyCampaignIds(apiKey, preferredCampaignId);

  let rows = [];
  let lastErr = null;
  for (const campaignId of campaignIds) {
    try {
      const itemsData = await ymRequest(
        `/v2/campaigns/${encodeURIComponent(String(campaignId))}/supply-requests/items?limit=500`,
        {
          apiKey,
          method: 'POST',
          body: { requestId, supplyRequestId: requestId },
        }
      );
      rows = itemsData?.result?.items ?? itemsData?.items ?? [];
      if (rows.length) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!rows.length && lastErr) throw lastErr;

  const items = [];
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
    });
  }
  return items;
}

async function mergeMarketplaceItemsIntoSupply(
  supplyId,
  mpItems,
  { profileId, updatePlacement = false } = {}
) {
  const filtered = (mpItems || []).filter((it) => (parseInt(it.quantity, 10) || 0) > 0);
  for (const mpItem of filtered) {
    if (mpItem.productId != null && Number(mpItem.productId) > 0) continue;
    mpItem.productId = await resolveProductId({
      sku: mpItem.sku ?? mpItem.mpOfferId,
      barcode: mpItem.barcode,
      profileId,
    });
  }

  const itemsR = await query(
    `SELECT id, product_id, quantity, mp_quantity, sku, barcode, mp_offer_id, mp_product_id, placement_zone, ozon_tags
     FROM fbo_supply_items
     WHERE fbo_supply_id = $1
     ORDER BY id`,
    [supplyId]
  );

  const ermRows = itemsR.rows || [];
  await ensureErmSupplyRowProductIds(ermRows, { profileId });

  const usedMp = new Set();
  const usedErm = new Set();
  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  let shrinkPacked = 0;

  const applyMatch = async (row, mpItem) => {
    const { changed } = await applyMpItemToErmSupplyRow(row, mpItem, { updatePlacement });
    if (changed) updated += 1;
    else unchanged += 1;
  };

  for (const row of ermRows) {
    let mpIdx = findOzonItemIndexForErm(filtered, row, usedMp);
    if (mpIdx < 0) {
      mpIdx = findOzonItemIndexByProductId(filtered, row.product_id, usedMp);
    }
    if (mpIdx < 0) continue;
    usedMp.add(mpIdx);
    usedErm.add(row.id);
    await applyMatch(row, filtered[mpIdx]);
  }

  for (const row of ermRows) {
    if (usedErm.has(row.id)) continue;
    const packed = await getSupplyItemPackedQty(row.id);
    if (packed > 0) {
      if (ozonItemReservedForErm(filtered, row, usedMp)) {
        unchanged += 1;
        continue;
      }
      const curQty = parseInt(row.quantity, 10) || 0;
      const keepQty = Math.max(curQty, packed);
      const curMpQty = parseInt(row.mp_quantity, 10) || 0;
      if (curQty !== keepQty || curMpQty !== 0) {
        await query(
          `UPDATE fbo_supply_items
           SET quantity = $1, mp_quantity = 0, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [keepQty, row.id]
        );
        shrinkPacked += 1;
      } else {
        unchanged += 1;
      }
      continue;
    }
    if (ozonItemReservedForErm(filtered, row, usedMp)) {
      continue;
    }
    await query(`DELETE FROM fbo_supply_items WHERE id = $1`, [row.id]);
    removed += 1;
  }

  let added = 0;
  for (let i = 0; i < filtered.length; i++) {
    if (usedMp.has(i)) continue;
    const mpItem = filtered[i];
    const mpQty = parseInt(mpItem.quantity, 10) || 0;
    if (mpQty <= 0) continue;

    const reuseRow = findUnusedErmRowForOzon(ermRows, usedErm, mpItem);
    if (reuseRow) {
      usedErm.add(reuseRow.id);
      usedMp.add(i);
      await applyMatch(reuseRow, mpItem);
      continue;
    }

    let productId = mpItem.productId ?? null;
    if (!productId) {
      productId = await resolveProductId({
        sku: mpItem.sku ?? mpItem.mpOfferId,
        barcode: mpItem.barcode,
        profileId,
      });
    }

    await query(
      `INSERT INTO fbo_supply_items (
          fbo_supply_id, product_id, quantity, mp_quantity, barcode, sku, mp_offer_id, mp_product_id, name,
          placement_zone, ozon_tags
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        supplyId,
        productId,
        mpQty,
        mpQty,
        mpItem.barcode ?? null,
        mpItem.sku ?? mpItem.mpOfferId ?? null,
        mpItem.mpOfferId ?? mpItem.sku ?? null,
        mpItem.mpProductId ?? null,
        mpItem.name ?? null,
        updatePlacement ? (mpItem.placementZone ?? null) : null,
        JSON.stringify(updatePlacement ? mpItem.ozonTags || [] : []),
      ]
    );
    added += 1;
  }

  const mergedDuplicates = await consolidateDuplicateSupplyItemsByProduct(supplyId);
  if (mergedDuplicates > 0) updated += mergedDuplicates;

  await query(
    `UPDATE fbo_supplies
     SET pending_mp_content_update = FALSE,
         marketplace_content_synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [supplyId]
  );

  await fboSupplyReserveService.rebalanceReservesForSupply(supplyId, { profileId }).catch(() => {});
  const sync = await syncSupplyStatusForPacking(supplyId);
  const updatedSupply = await fboSuppliesService.getById(supplyId, { profileId });

  return {
    updated,
    added,
    removed,
    unchanged,
    shrinkPacked,
    totalMp: filtered.length,
    supply: updatedSupply,
    supplyStatus: sync.status,
    packingAllMatch: sync.allMatch,
    statusReverted: sync.reverted,
  };
}

function mpLabelRu(mp) {
  if (mp === 'wb') return 'Wildberries';
  if (mp === 'ym') return 'Яндекс Маркет';
  return 'Ozon';
}

function assertSupplyHasExternalRef(supply, mp) {
  const extSupply =
    supply.externalSupplyId != null ? String(supply.externalSupplyId).trim() : '';
  const extNum =
    supply.externalShipmentNumber != null ? String(supply.externalShipmentNumber).trim() : '';
  if (!extSupply && !extNum) {
    const err = new Error(
      `У поставки нет номера отгрузки или ID на ${mpLabelRu(mp)} — загрузить состав нельзя`
    );
    err.statusCode = 400;
    throw err;
  }
}

function ozonImportOrgKey(organizationId) {
  return organizationId != null ? String(organizationId) : '__null__';
}

function needsOzonHydrate(row) {
  const mp = String(row?.marketplace || '').trim().toLowerCase();
  if (mp !== 'ozon') return false;
  const hasItems = (row.items || []).some((it) => (Number(it?.quantity) || 0) > 0);
  return row.ozonPreviewOnly === true || !hasItems;
}

async function getOzonOrderDetailsCached(supplyOrderId, ozonApiOpts, cache) {
  const key = String(supplyOrderId);
  if (!cache.has(key)) {
    cache.set(key, await fetchOzonSupplyOrderDetails(supplyOrderId, ozonApiOpts));
  }
  return cache.get(key);
}

/** Пакетная подготовка контекста Ozon для confirm (один get orders + cluster maps на организацию). */
async function buildOzonConfirmContexts(supplies, profileId) {
  const rowsByOrg = new Map();
  for (const row of supplies || []) {
    if (!needsOzonHydrate(row)) continue;
    const orgKey = ozonImportOrgKey(row.organizationId);
    if (!rowsByOrg.has(orgKey)) rowsByOrg.set(orgKey, []);
    rowsByOrg.get(orgKey).push(row);
  }

  const contexts = new Map();
  for (const [orgKey, rows] of rowsByOrg) {
    const organizationId = orgKey === '__null__' ? null : Number(orgKey);
    const ozonCfg = await integrationsService.getMarketplaceConfig('ozon', {
      profileId,
      organizationId,
    });
    const clientId = ozonCfg?.client_id ?? ozonCfg?.clientId;
    const apiKey = ozonCfg?.api_key ?? ozonCfg?.apiKey;
    if (!clientId || !apiKey) {
      const err = new Error(
        'Не настроены Client ID и API Key Ozon. Укажите их в «Интеграции» для организации поставки.'
      );
      err.statusCode = 400;
      throw err;
    }

    const ozonApiOpts = { profileId, organizationId, ozonOverride: ozonCfg };
    const idSet = new Set();
    for (const r of rows) {
      for (const oid of buildOzonApiOrderIds(r)) idSet.add(oid);
    }

    let orders = [];
    let warehousesById = new Map();
    if (idSet.size) {
      try {
        const fetched = await fetchOzonSupplyOrdersByIds([...idSet], ozonApiOpts);
        orders = fetched.orders;
        warehousesById = fetched.warehousesById;
      } catch (e) {
        console.warn('[FboImport] Ozon confirm get by order_ids:', e?.message || e);
      }
    }

    const unmatched = rows.filter((r) => !findOzonOrderSupplyMatch(orders, r));
    if (unmatched.length) {
      const fromList = await fetchOzonOrdersViaImportList(ozonApiOpts, { daysBack: 90 });
      orders = mergeOzonOrderLists(orders, fromList.orders);
      for (const [k, v] of fromList.warehousesById) warehousesById.set(k, v);
    }

    const clusterMaps = await fetchOzonClusterMaps(ozonApiOpts).catch(() => ({
      warehouseById: new Map(),
      macrolocalById: new Map(),
    }));
    contexts.set(orgKey, {
      ozonApiOpts,
      orders,
      warehousesById,
      clusterMaps,
      detailsCache: new Map(),
    });
  }
  return contexts;
}

async function hydrateOzonImportRow(row, { profileId, ozonCtx = null } = {}) {
  const mp = String(row?.marketplace || 'ozon').trim().toLowerCase();
  if (mp !== 'ozon') return row;
  if (!needsOzonHydrate(row)) return row;

  const organizationId = row.organizationId ?? null;
  let ozonApiOpts = ozonCtx?.ozonApiOpts ?? null;
  if (!ozonApiOpts) {
    const ozonCfg = await integrationsService.getMarketplaceConfig('ozon', {
      profileId,
      organizationId,
    });
    const clientId = ozonCfg?.client_id ?? ozonCfg?.clientId;
    const apiKey = ozonCfg?.api_key ?? ozonCfg?.apiKey;
    if (!clientId || !apiKey) {
      const err = new Error(
        'Не настроены Client ID и API Key Ozon. Укажите их в «Интеграции» для организации поставки.'
      );
      err.statusCode = 400;
      throw err;
    }
    ozonApiOpts = { profileId, organizationId, ozonOverride: ozonCfg };
  }

  let order = null;
  let supply = null;
  if (ozonCtx?.orders?.length) {
    const match = findOzonOrderSupplyMatch(ozonCtx.orders, row);
    if (match) {
      order = match.order;
      supply = match.supply;
    }
  }
  const externalOrderId = row.externalOrderId != null ? String(row.externalOrderId).trim() : '';
  if (!order && externalOrderId) {
    try {
      const { orders } = ozonCtx?.orders?.length
        ? { orders: ozonCtx.orders }
        : await fetchOzonSupplyOrdersByIds([externalOrderId], ozonApiOpts);
      const match = findOzonOrderSupplyMatch(orders, row);
      if (match) {
        order = match.order;
        supply = match.supply;
      }
    } catch {
      /* fallback below */
    }
  }
  if (!order) {
    const resolved = await resolveOzonOrderSupplyForErmSupply(row, ozonApiOpts);
    order = resolved.order;
    supply = resolved.supply;
  }

  const supplyOrderId = ozonSupplyOrderId(order);
  const detailsCache = ozonCtx?.detailsCache ?? new Map();
  const orderDetails = await getOzonOrderDetailsCached(supplyOrderId, ozonApiOpts, detailsCache);
  const clusterMaps = ozonCtx?.clusterMaps ?? (await fetchOzonClusterMaps(ozonApiOpts).catch(() => ({
    warehouseById: new Map(),
    macrolocalById: new Map(),
  })));
  const fetched = await fetchOzonSupplyItems(
    order,
    supply,
    ozonApiOpts,
    profileId,
    orderDetails,
    {
      warehousesById: ozonCtx?.warehousesById ?? new Map(),
      clusterByWarehouseId: clusterMaps.warehouseById,
      macrolocalById: clusterMaps.macrolocalById,
      summaryOnly: false,
    }
  );
  if (!fetched.items?.length) {
    const err = new Error(
      `Ozon не вернул состав поставки ${String(row.externalShipmentNumber || '').trim()}`.trim()
    );
    err.statusCode = 400;
    throw err;
  }
  return {
    ...row,
    items: fetched.items,
    itemCount: sumSupplyItemsQuantity(fetched.items),
    shippingCluster: row.shippingCluster || fetched.shippingCluster || row.placementCluster,
    ozonPreviewOnly: false,
  };
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
        name: null,
        readyAt: null,
        marketplaceWarehouseName: null,
        externalShipmentNumber,
        deductionWarehouseId: null,
        organizationId: null,
        deductStock: true,
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
    let ozonMacrolocalById;
    try {
      const fetched = await fetchOzonSupplyOrdersByIds(orderIds, ozonApiOpts);
      ozonOrders = fetched.orders;
      ozonWarehousesById = fetched.warehousesById;
      const clusterMaps = await fetchOzonClusterMaps(ozonApiOpts);
      ozonClusterByWarehouseId = clusterMaps.warehouseById;
      ozonMacrolocalById = clusterMaps.macrolocalById;
    } catch (e) {
      const err = new Error(e?.message || 'Не удалось загрузить детали поставок Ozon');
      err.statusCode = 400;
      throw err;
    }

    const candidates = [];
    const ozonDetailsCache = new Map();
    for (const { order, supply } of flattenOzonSupplyOrders(ozonOrders)) {
      if (!isOzonSupplyImportable(order, supply)) continue;

      const supplyOrderId = ozonSupplyOrderId(order);
      if (!ozonDetailsCache.has(String(supplyOrderId))) {
        ozonDetailsCache.set(
          String(supplyOrderId),
          await fetchOzonSupplyOrderDetails(supplyOrderId, ozonApiOpts)
        );
      }
      const orderDetails = ozonDetailsCache.get(String(supplyOrderId));

      const supplyId = supply?.supply_id ?? supply?.id;
      const supplyIdStr = supplyId != null ? String(supplyId).trim() : '';
      const baseNumber = String(
        order.order_number ?? order.supply_order_number ?? supplyOrderId ?? ''
      ).trim();
      const externalNumber =
        baseNumber && supplyIdStr && baseNumber !== supplyIdStr
          ? `${baseNumber}-${supplyIdStr}`
          : baseNumber || supplyIdStr;
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
          orderDetails,
          {
            warehousesById: ozonWarehousesById,
            clusterByWarehouseId: ozonClusterByWarehouseId,
            macrolocalById: ozonMacrolocalById,
            summaryOnly: true,
          }
        );
        items = [];
        itemCount = resolveOzonPreviewItemCount({
          items: [],
          totalCount: fetchedItems.totalCount,
          order,
          supply,
          orderDetails,
        });
        shippingClusterFromDetails = fetchedItems.shippingCluster;
        } catch {
          items = [];
        itemCount = resolveOzonPreviewItemCount({
          items: [],
          totalCount: 0,
          order,
          supply,
          orderDetails,
        });
        shippingClusterFromDetails =
          resolveOzonMacrolocalClusterName(supply, order, orderDetails?.raw, ozonMacrolocalById) ||
          orderDetails?.shippingCluster ||
          resolveOzonShippingCluster(
            order,
            supply,
            ozonWarehousesById,
            ozonClusterByWarehouseId,
            orderDetails?.raw
          );
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
        resolveOzonMacrolocalClusterName(supply, order, orderDetails?.raw, ozonMacrolocalById) ||
        resolveOzonShippingCluster(
          order,
          supply,
          ozonWarehousesById,
          ozonClusterByWarehouseId,
          orderDetails?.raw
        );

      candidates.push({
        importKey: `ozon:${externalNumber}`,
        marketplace: 'ozon',
        name: null,
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
        externalOrderId: supplyOrderId != null ? String(supplyOrderId) : null,
        ozonPreviewOnly: true,
        deductionWarehouseId: null,
        organizationId: organizationId != null ? Number(organizationId) : null,
        deductStock: true,
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
      let details = null;
      try {
        const [goodsData, detailsData] = await Promise.all([
          wbFbwRequest(
          `/api/v1/supplies/${encodeURIComponent(goodsApiId)}/goods`,
          { apiKey, method: 'GET', timeoutMs: 30000 }
          ),
          fetchWbSupplyDetails(apiKey, goodsApiId),
        ]);
        details = detailsData;
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
        details = await fetchWbSupplyDetails(apiKey, goodsApiId).catch(() => null);
      }

      const whFields = resolveWbSupplyWarehouseFields(row, details);
      const supplyId = row.supplyID ?? row.supplyId;
      const preorderId = row.preorderID ?? row.preorderId;

      return {
        importKey: `wb:${externalNumber}`,
        marketplace: 'wb',
        name: null,
        readyAt: parseDateOnly(
          row.supplyDate ?? row.factDate ?? row.createDate ?? row.updatedDate ?? row.date
        ),
        marketplaceWarehouseName: whFields.marketplaceWarehouseName,
        marketplaceWarehouseId: whFields.marketplaceWarehouseId,
        shippingCluster: whFields.shippingCluster,
        externalShipmentNumber: externalNumber,
        externalSupplyId: supplyId != null ? String(supplyId) : String(preorderId ?? goodsApiId),
        deductionWarehouseId: null,
        organizationId: organizationId != null ? Number(organizationId) : null,
        deductStock: true,
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
    const preferredCampaignId = ymConfig?.campaign_id ?? ymConfig?.campaignId;
    if (!apiKey || !ymApiKeyHeader(apiKey)) {
      const err = new Error(
        'Не настроен API-ключ Яндекс.Маркета (формат ACMA:...). Укажите токен в «Интеграции» для выбранной организации с доступом «Заявки на поставку».'
      );
      err.statusCode = 400;
      throw err;
    }

    const campaignIds = await resolveYmSupplyCampaignIds(apiKey, preferredCampaignId);
    const days = Math.max(1, Math.min(365, Number(daysBack) || 90));

    const candidates = [];
    const seenExt = new Set();

    for (const campaignId of campaignIds) {
      let listData;
      try {
        // Без requestDateFrom/To: API фильтрует по requestedDate, у VDC-поставок она часто пустая → 0 строк.
        listData = await ymRequest(
          `/v2/campaigns/${encodeURIComponent(String(campaignId))}/supply-requests?limit=100`,
          {
            apiKey,
            method: 'POST',
            body: { requestTypes: ['SUPPLY'] },
          }
        );
      } catch (e) {
        if (campaignIds.length === 1) throw e;
        continue;
      }

      const requests = listData?.result?.requests ?? listData?.requests ?? [];

      for (const req of requests) {
        if (!ymSupplyRequestIsImportable(req)) continue;
        if (!ymSupplyRequestWithinDaysBack(req, days)) continue;

        const reqId = req.id?.id ?? req.id ?? req.requestId;
        const externalNumber = String(
          req.id?.warehouseRequestId ??
            req.warehouseRequestId ??
            req.id?.marketplaceRequestId ??
            req.marketplaceRequestId ??
            reqId ??
            ''
        ).trim();
        if (!externalNumber && reqId == null) continue;
        const extNum = externalNumber || String(reqId);
        if (seenExt.has(extNum)) continue;
        seenExt.add(extNum);

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
          name: null,
          readyAt: parseDateOnly(req.updatedAt ?? req.plannedDate ?? req.createdAt),
          marketplaceWarehouseName: target.name ?? target.warehouseName ?? null,
          marketplaceWarehouseId: target.id != null ? String(target.id) : null,
          shippingCluster: resolveYmPlacementCluster(req, target),
          externalShipmentNumber: extNum,
          externalSupplyId: reqId != null ? String(reqId) : null,
          deductionWarehouseId: null,
          organizationId: organizationId != null ? Number(organizationId) : null,
          deductStock: true,
          status: mapYmStateToStatus(req.status),
          items,
          itemCount: sumSupplyItemsQuantity(items),
          alreadyImported: false,
        });
      }
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

    const productIdsToRebalance = new Set();
    const ozonContexts = await buildOzonConfirmContexts(supplies, profileId);

    const result = await runWithDbRetry(
      async () => {
    const created = [];
    const skipped = [];

    for (const row of supplies) {
      if (row.alreadyImported) {
        skipped.push({ externalShipmentNumber: row.externalShipmentNumber, reason: 'already_imported' });
        continue;
      }
      try {
            const mp = String(row.marketplace || '').trim().toLowerCase();
            const ozonCtx = mp === 'ozon' ? ozonContexts.get(ozonImportOrgKey(row.organizationId)) ?? null : null;
            const importRow =
              mp === 'ozon' && needsOzonHydrate(row)
                ? await hydrateOzonImportRow(row, { profileId, ozonCtx })
                : row;
        const doc = await fboSuppliesService.create(
          {
                marketplace: importRow.marketplace,
                name: importRow.name,
                readyAt: importRow.readyAt,
                marketplaceWarehouseName: importRow.marketplaceWarehouseName,
                marketplaceWarehouseId: importRow.marketplaceWarehouseId,
                placementCluster: importRow.shippingCluster ?? importRow.placementCluster ?? null,
                externalShipmentNumber: importRow.externalShipmentNumber,
                externalSupplyId: importRow.externalSupplyId,
                deductionWarehouseId: importRow.deductionWarehouseId,
                organizationId: importRow.organizationId,
                deductStock: importRow.deductStock !== false,
                status: importRow.status || 'new',
                source: importRow.source || 'api',
                items: (importRow.items || []).map((it) => ({
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
              { profileId, userId, skipReserveRebalance: true, lightReturn: true }
        );
        created.push(doc);
            for (const it of importRow.items || []) {
              const pid = it.productId != null ? Number(it.productId) : NaN;
              if (Number.isFinite(pid) && pid > 0) productIdsToRebalance.add(pid);
            }
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
      },
      { label: 'fbo-import-confirm', attempts: 3, delayMs: 5000 }
    );

    if (productIdsToRebalance.size) {
      const uniqueProductIds = [...productIdsToRebalance];
      const pid = profileId;
      setImmediate(() => {
        (async () => {
          for (const productId of uniqueProductIds) {
            await fboSupplyReserveService
              .rebalanceReservesForProduct(productId, { profileId: pid, skipMarketplaceSync: true })
              .catch((e) => {
                console.warn('[FboImport] background reserve rebalance:', e?.message || e);
              });
          }
        })().catch(() => {});
      });
    }

    return result;
  }

  /**
   * Подтянуть зоны размещения (сортируемый / несортируемый) с Ozon для уже импортированной поставки.
   */
  async syncOzonPlacementZones(supplyId, { profileId } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, { profileId });
    const mp = String(supply.marketplace || 'ozon').trim().toLowerCase();
    if (mp === 'wb' || mp === 'ym' || mp === 'yandex') {
      const err = new Error('Обновление зон размещения доступно только для поставок Ozon');
      err.statusCode = 400;
      throw err;
    }

    const extSupply =
      supply.externalSupplyId != null ? String(supply.externalSupplyId).trim() : '';
    const extNum =
      supply.externalShipmentNumber != null ? String(supply.externalShipmentNumber).trim() : '';
    if (!extSupply && !extNum) {
      const err = new Error('У поставки нет номера отгрузки Ozon — обновить зоны нельзя');
      err.statusCode = 400;
      throw err;
    }

    const organizationId = supply.organizationId ?? null;
    const ozonCfg = await integrationsService.getMarketplaceConfig('ozon', {
      profileId,
      organizationId,
    });
    const clientId = ozonCfg?.client_id ?? ozonCfg?.clientId;
    const apiKey = ozonCfg?.api_key ?? ozonCfg?.apiKey;
    if (!clientId || !apiKey) {
      const err = new Error(
        'Не настроены Client ID и API Key Ozon для организации поставки. Укажите их в «Интеграции».'
      );
      err.statusCode = 400;
      throw err;
    }

    const ozonApiOpts = { profileId, organizationId, ozonOverride: ozonCfg };
    const { order, supply: ozonSupply } = await resolveOzonOrderSupplyForErmSupply(supply, ozonApiOpts);
    const supplyOrderId = ozonSupplyOrderId(order);
    const orderDetails = await fetchOzonSupplyOrderDetails(supplyOrderId, ozonApiOpts);
    const fetched = await fetchOzonSupplyItems(
      order,
      ozonSupply,
      ozonApiOpts,
      profileId,
      orderDetails,
      {}
    );

    if (!fetched.items?.length) {
      const err = new Error('Ozon не вернул товары поставки — зоны не обновлены');
      err.statusCode = 400;
      throw err;
    }

    const lookup = buildOzonItemZoneLookup(fetched.items);
    const itemsR = await query(
      `SELECT id, sku, barcode, mp_offer_id, mp_product_id, placement_zone, ozon_tags
       FROM fbo_supply_items
       WHERE fbo_supply_id = $1
       ORDER BY id`,
      [supplyId]
    );

    let updated = 0;
    let unchanged = 0;
    let missing = 0;

    for (const row of itemsR.rows || []) {
      const zoneMeta = lookupOzonItemZone(lookup, {
        sku: row.sku,
        barcode: row.barcode,
        mpOfferId: row.mp_offer_id,
        mpProductId: row.mp_product_id,
      });
      if (!zoneMeta) {
        missing += 1;
        continue;
      }

      const newZone = zoneMeta.placementZone;
      const newTagsJson = JSON.stringify(zoneMeta.ozonTags || []);
      const oldZone = row.placement_zone != null ? String(row.placement_zone).trim() : null;
      const oldTagsJson = parseOzonTagsForCompare(row.ozon_tags);
      const tagsEqual = oldTagsJson === newTagsJson;
      const zoneEqual = (oldZone || null) === (newZone || null);
      if (zoneEqual && tagsEqual) {
        unchanged += 1;
        continue;
      }

      await query(
        `UPDATE fbo_supply_items
         SET placement_zone = $1, ozon_tags = $2::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [newZone, newTagsJson, row.id]
      );
      updated += 1;
    }

    const updatedSupply = await fboSuppliesService.getById(supplyId, { profileId });
    return {
      updated,
      unchanged,
      missing,
      total: (itemsR.rows || []).length,
      supply: updatedSupply,
    };
  }

  /**
   * Подтянуть состав поставки (количества и новые строки) с маркетплейса в ERM.
   */
  async pullMarketplaceContentFromMarketplace(supplyId, { profileId } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, { profileId });
    const mp = normalizeMarketplaceImport(supply.marketplace);
    assertSupplyHasExternalRef(supply, mp);

    if (mp === 'wb') {
      const mpItems = await fetchWbMpItemsForSupply(supply, { profileId });
      if (!mpItems.length) {
        const err = new Error('Wildberries не вернул товары поставки — состав не обновлён');
        err.statusCode = 400;
        throw err;
      }
      return mergeMarketplaceItemsIntoSupply(supplyId, mpItems, {
        profileId,
        updatePlacement: false,
      });
    }

    if (mp === 'ym') {
      const mpItems = await fetchYmMpItemsForSupply(supply, { profileId });
      if (!mpItems.length) {
        const err = new Error('Яндекс Маркет не вернул товары заявки — состав не обновлён');
        err.statusCode = 400;
        throw err;
      }
      return mergeMarketplaceItemsIntoSupply(supplyId, mpItems, {
        profileId,
        updatePlacement: false,
      });
    }

    return this.pullOzonSupplyContentFromMarketplace(supplyId, { profileId });
  }

  /**
   * Подтянуть состав поставки (количества и новые строки) с Ozon в ERM.
   */
  async pullOzonSupplyContentFromMarketplace(supplyId, { profileId } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, { profileId });
    assertSupplyHasExternalRef(supply, 'ozon');

    const organizationId = supply.organizationId ?? null;
    const ozonCfg = await integrationsService.getMarketplaceConfig('ozon', {
      profileId,
      organizationId,
    });
    const clientId = ozonCfg?.client_id ?? ozonCfg?.clientId;
    const apiKey = ozonCfg?.api_key ?? ozonCfg?.apiKey;
    if (!clientId || !apiKey) {
      const err = new Error(
        'Не настроены Client ID и API Key Ozon для организации поставки. Укажите их в «Интеграции».'
      );
      err.statusCode = 400;
      throw err;
    }

    const ozonApiOpts = { profileId, organizationId, ozonOverride: ozonCfg };
    const { order, supply: ozonSupply } = await resolveOzonOrderSupplyForErmSupply(supply, ozonApiOpts);
    const supplyOrderId = ozonSupplyOrderId(order);
    const orderDetails = await fetchOzonSupplyOrderDetails(supplyOrderId, ozonApiOpts);
    const fetched = await fetchOzonSupplyItems(
      order,
      ozonSupply,
      ozonApiOpts,
      profileId,
      orderDetails,
      {}
    );

    if (!fetched.items?.length) {
      const err = new Error('Ozon не вернул товары поставки — состав не обновлён');
      err.statusCode = 400;
      throw err;
    }

    const ozonItems = fetched.items.filter((it) => (parseInt(it.quantity, 10) || 0) > 0);
    return mergeMarketplaceItemsIntoSupply(supplyId, ozonItems, {
      profileId,
      updatePlacement: true,
    });
  }

  /**
   * Фоновый прогон: все поставки не в финальном статусе — подтянуть статус с МП.
   * «Закрыт» и «Возврат» пропускаются.
   */
  async syncAllActiveStatusesFromMarketplace({ limit = 50 } = {}) {
    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const r = await query(
      `SELECT id, profile_id
       FROM fbo_supplies
       WHERE status IN ('ready_for_supply', 'shipped')
         AND (
           NULLIF(TRIM(COALESCE(external_shipment_number, '')), '') IS NOT NULL
           OR NULLIF(TRIM(COALESCE(external_supply_id::text, '')), '') IS NOT NULL
         )
       ORDER BY updated_at ASC NULLS FIRST, id ASC
       LIMIT $1`,
      [lim]
    );
    const rows = r.rows || [];
    let updated = 0;
    let errors = 0;
    let skippedTerminal = 0;
    const ozonOrdersCache = new Map();
    for (const row of rows) {
      const supplyId = Number(row.id);
      const profileId = row.profile_id != null ? Number(row.profile_id) : null;
      if (!Number.isFinite(supplyId) || supplyId < 1) continue;
      try {
        const result = await this.syncSupplyStatusFromMarketplace(supplyId, {
          profileId,
          ozonOrdersCache,
        });
        if (result?.skippedTerminal) skippedTerminal += 1;
        else if (result?.updated) updated += 1;
      } catch (e) {
        errors += 1;
        console.warn('[FboSupplyStatusSync] supply failed', {
          supplyId,
          profileId,
          message: e?.message || String(e),
        });
      }
    }
    return { total: rows.length, updated, errors, skippedTerminal, skipped: false };
  }

  /** @deprecated используйте syncAllActiveStatusesFromMarketplace */
  async syncAllShippedStatusesFromMarketplace(opts = {}) {
    return this.syncAllActiveStatusesFromMarketplace(opts);
  }

  /**
   * Синхронизировать статус поставки с маркетплейсом (только продвижение вперёд или «Возврат»).
   */
  async syncSupplyStatusFromMarketplace(supplyId, { profileId, ozonOrdersCache = null } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, {
      profileId,
      skipReserveEnrichment: true,
      skipPackingEval: true,
    });
    if (isFboSupplyTerminalStatus(supply.status)) {
      return {
        updated: false,
        skippedTerminal: true,
        supply,
        previousStatus: supply.status,
        marketplaceStatus: null,
        marketplaceState: null,
        message: 'Поставка в финальном статусе — синхронизация не требуется',
      };
    }
    const mpInfo = await fetchMarketplaceStatusForSupply(supply, { profileId, ozonOrdersCache });
    const previousStatus = supply.status;
    const targetStatus = pickStatusAfterMarketplaceSync(previousStatus, mpInfo?.status);

    if (targetStatus === previousStatus) {
      return {
        updated: false,
        supply,
        previousStatus,
        marketplaceStatus: mpInfo?.status ?? null,
        marketplaceState: mpInfo?.rawState ?? null,
        message: 'Статус совпадает с маркетплейсом или на МП ещё не продвинулся',
      };
    }

    const updated = await fboSuppliesService.update(
      supplyId,
      { status: targetStatus },
      { profileId, deferReserveRebalance: true, skipMarketplaceSync: true, lightReturn: true }
    );
    return {
      updated: true,
      supply: updated,
      previousStatus,
      marketplaceStatus: mpInfo?.status ?? null,
      marketplaceState: mpInfo?.rawState ?? null,
      message: `Статус обновлён: ${previousStatus} → ${targetStatus}`,
    };
  }

  /**
   * ID заявки (order_id) и поставки (supply_id) Ozon для API обновления состава / грузомест.
   */
  async resolveOzonSupplyApiIds(supplyId, { profileId } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, { profileId });
    const organizationId = supply.organizationId ?? null;
    const ozonCfg = await integrationsService.getMarketplaceConfig('ozon', {
      profileId,
      organizationId,
    });
    const clientId = ozonCfg?.client_id ?? ozonCfg?.clientId;
    const apiKey = ozonCfg?.api_key ?? ozonCfg?.apiKey;
    if (!clientId || !apiKey) {
      const err = new Error(
        'Не настроены Client ID и API Key Ozon для организации поставки. Укажите их в «Интеграции».'
      );
      err.statusCode = 400;
      throw err;
    }

    const ozonApiOpts = { profileId, organizationId, ozonOverride: ozonCfg };
    const { order, supply: ozonSupply } = await resolveOzonOrderSupplyForErmSupply(supply, ozonApiOpts);
    const orderId = Number(ozonSupplyOrderId(order));
    const supplyIdRaw = ozonSupply?.supply_id ?? ozonSupply?.id;
    const ozonSupplyId = Number(supplyIdRaw);

    if (!Number.isFinite(orderId) || orderId <= 0) {
      const err = new Error(
        'Не удалось определить order_id заявки Ozon — проверьте номер отгрузки и ID поставки в карточке'
      );
      err.statusCode = 400;
      throw err;
    }
    if (!Number.isFinite(ozonSupplyId) || ozonSupplyId <= 0) {
      const err = new Error(
        'Не удалось определить supply_id поставки Ozon — проверьте ID поставки в карточке'
      );
      err.statusCode = 400;
      throw err;
    }

    return { orderId, supplyId: ozonSupplyId, order, ozonSupply };
  }
}

export default new FboSuppliesImportService();
