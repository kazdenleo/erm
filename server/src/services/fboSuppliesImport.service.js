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

const WB_SUPPLIES_API = 'https://supplies-api.wildberries.ru';
const YM_API = 'https://api.partner.market.yandex.ru';

const ITEMS_SHEET = 'Товары';

const OZON_SELLER_API_MIN_GAP_MS = 450;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let ozonSellerApiLastAt = 0;

function isOzonRateLimitError(err) {
  const msg = String(err?.message ?? '');
  return msg.includes('429') || /rate limit/i.test(msg);
}

async function ozonApiPostWithRetry(path, body, ozonApiOpts, { maxAttempts = 5, minGapMs = OZON_SELLER_API_MIN_GAP_MS } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (minGapMs > 0) {
      const wait = ozonSellerApiLastAt + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    ozonSellerApiLastAt = Date.now();
    try {
      return await integrationsService._ozonApiPost(path, body, ozonApiOpts);
    } catch (e) {
      if (!isOzonRateLimitError(e) || attempt >= maxAttempts - 1) throw e;
      await sleep(800 * 2 ** attempt);
    }
  }
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

async function fetchOzonBundleItems(bundleId, ozonApiOpts, profileId, { withTags = false } = {}) {
  let items = [];
  let reportedLineCount = 0;
  let reportedQtySum = 0;
  const clusterQty = new Map();

  const loadPages = async () => {
    const batch = [];
    let lastId = '';
    let lineCount = 0;
    let qtySum = 0;
    const localClusterQty = new Map();

    for (let page = 0; page < 20; page++) {
      const body = { bundle_ids: [String(bundleId)], limit: 100 };
      // item_tags_calculation: true — Ozon API 400 (proto unexpected token true); теги не запрашиваем.
      if (lastId) body.last_id = lastId;
      const bundleData = await ozonApiPostWithRetry('/v1/supply-order/bundle', body, ozonApiOpts);
      const parsed = parseOzonBundleResponse(bundleData);
      if (parsed.totalCount > lineCount) lineCount = parsed.totalCount;
      for (const row of parsed.rows) {
        qtySum += parseOzonBundleRowQuantity(row);
      }

      for (const row of parsed.rows) {
        const qty = parseOzonBundleRowQuantity(row);
        const rowCluster = ozonClusterFromBundleRow(row);
        if (rowCluster && qty > 0) {
          localClusterQty.set(rowCluster, (localClusterQty.get(rowCluster) || 0) + qty);
        }
        if (!qty || qty <= 0) continue;
        const offerId = parseOzonBundleRowOfferId(row);
        const barcode = row.barcode ?? row.bar_code ?? null;
        const productId = await resolveProductId({
          sku: offerId,
          barcode,
          profileId,
        });
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

      if (!parsed.hasNext) break;
      if (!parsed.lastId || parsed.lastId === lastId) break;
      lastId = parsed.lastId;
    }

    return { batch, lineCount, qtySum, localClusterQty };
  };

  try {
    const loaded = await loadPages();
    items = loaded.batch;
    reportedLineCount = loaded.lineCount;
    reportedQtySum = loaded.qtySum;
    for (const [name, qty] of loaded.localClusterQty) {
      clusterQty.set(name, (clusterQty.get(name) || 0) + qty);
    }
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
  { warehousesById = null, clusterByWarehouseId = null, macrolocalById = null } = {}
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
      const fetched = await fetchOzonBundleItems(bundleId, ozonApiOpts, profileId, { withTags: false });
      if (fetched.items.length > items.length) items = fetched.items;
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

function buildOzonOrderIdCandidates(ermSupply) {
  const candidates = new Set();
  const extNum =
    ermSupply.externalShipmentNumber != null ? String(ermSupply.externalShipmentNumber).trim() : '';
  const extSupply =
    ermSupply.externalSupplyId != null ? String(ermSupply.externalSupplyId).trim() : '';

  if (extNum) {
    candidates.add(extNum);
    const dash = extNum.lastIndexOf('-');
    if (dash > 0) {
      const left = extNum.slice(0, dash).trim();
      const right = extNum.slice(dash + 1).trim();
      if (left) candidates.add(left);
      if (right) candidates.add(right);
    }
  }
  if (extSupply) candidates.add(extSupply);
  return [...candidates];
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

async function resolveOzonOrderSupplyForErmSupply(ermSupply, ozonApiOpts) {
  const candidates = buildOzonOrderIdCandidates(ermSupply);
  if (candidates.length) {
    try {
      const { orders } = await fetchOzonSupplyOrdersByIds(candidates, ozonApiOpts);
      const match = findOzonOrderSupplyMatch(orders, ermSupply);
      if (match) return match;
    } catch {
      /* попробуем поиск по списку */
    }
  }

  const daysBack = 180;
  const orderIds = await fetchOzonSupplyOrderIds(daysBack, ozonApiOpts, {
    states: OZON_SUPPLY_LIST_STATES,
    useTimeslotFilter: false,
  });
  for (let i = 0; i < orderIds.length; i += 50) {
    const chunk = orderIds.slice(i, i + 50);
    const { orders } = await fetchOzonSupplyOrdersByIds(chunk, ozonApiOpts);
    const match = findOzonOrderSupplyMatch(orders, ermSupply);
    if (match) return match;
  }

  const err = new Error(
    'Не удалось найти поставку в Ozon по сохранённому номеру отгрузки. Проверьте номер в карточке и настройки интеграции.'
  );
  err.statusCode = 400;
  throw err;
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
  const ozKeys = new Set(ozonItemMatchKeys(ozonItem));
  return ermItemMatchKeys(ermRow).some((k) => ozKeys.has(k));
}

function findOzonItemForErm(ozonItems, ermRow, usedIndices) {
  for (let i = 0; i < ozonItems.length; i++) {
    if (usedIndices.has(i)) continue;
    if (ozonItemMatchesErm(ozonItems[i], ermRow)) {
      usedIndices.add(i);
      return ozonItems[i];
    }
  }
  return null;
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
          }
        );
        items = fetchedItems.items;
        itemCount = resolveOzonPreviewItemCount({
          items,
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
        name: null,
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
            deductStock: row.deductStock !== false,
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
          { profileId, userId, deferReserveRebalance: true, lightReturn: true }
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
   * Подтянуть состав поставки (количества и новые строки) с Ozon в ERM.
   */
  async pullOzonSupplyContentFromMarketplace(supplyId, { profileId } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, { profileId });
    const mp = String(supply.marketplace || 'ozon').trim().toLowerCase();
    if (mp === 'wb' || mp === 'ym' || mp === 'yandex') {
      const err = new Error('Загрузка состава с маркетплейса доступна только для поставок Ozon');
      err.statusCode = 400;
      throw err;
    }

    const extSupply =
      supply.externalSupplyId != null ? String(supply.externalSupplyId).trim() : '';
    const extNum =
      supply.externalShipmentNumber != null ? String(supply.externalShipmentNumber).trim() : '';
    if (!extSupply && !extNum) {
      const err = new Error('У поставки нет номера отгрузки Ozon — загрузить состав нельзя');
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
      const err = new Error('Ozon не вернул товары поставки — состав не обновлён');
      err.statusCode = 400;
      throw err;
    }

    const ozonItems = fetched.items.filter((it) => (parseInt(it.quantity, 10) || 0) > 0);
    const itemsR = await query(
      `SELECT id, product_id, quantity, mp_quantity, sku, barcode, mp_offer_id, mp_product_id, placement_zone, ozon_tags
       FROM fbo_supply_items
       WHERE fbo_supply_id = $1
       ORDER BY id`,
      [supplyId]
    );

    const usedOzon = new Set();
    let updated = 0;
    let unchanged = 0;
    let removed = 0;
    let shrinkPacked = 0;

    for (const row of itemsR.rows || []) {
      const ozonItem = findOzonItemForErm(ozonItems, row, usedOzon);
      if (!ozonItem) {
        const packed = await getSupplyItemPackedQty(row.id);
        if (packed <= 0) {
          await query(`DELETE FROM fbo_supply_items WHERE id = $1`, [row.id]);
          removed += 1;
        } else {
          const curQty = parseInt(row.quantity, 10) || 0;
          if (curQty !== packed) {
            await query(
              `UPDATE fbo_supply_items
               SET quantity = $1, mp_quantity = $1, updated_at = CURRENT_TIMESTAMP
               WHERE id = $2`,
              [packed, row.id]
            );
            shrinkPacked += 1;
          } else {
            unchanged += 1;
          }
        }
        continue;
      }

      const ozQty = parseInt(ozonItem.quantity, 10) || 0;
      const curQty = parseInt(row.quantity, 10) || 0;
      const newZone = ozonItem.placementZone ?? null;
      const newTagsJson = JSON.stringify(ozonItem.ozonTags || []);
      const oldZone = row.placement_zone != null ? String(row.placement_zone).trim() : null;
      const zoneEqual = (oldZone || null) === (newZone || null);
      const tagsEqual = parseOzonTagsForCompare(row.ozon_tags) === newTagsJson;

      if (ozQty === curQty && zoneEqual && tagsEqual) {
        if ((parseInt(row.mp_quantity, 10) || 0) !== ozQty) {
          await query(
            `UPDATE fbo_supply_items SET mp_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [ozQty, row.id]
          );
          updated += 1;
        } else {
          unchanged += 1;
        }
        continue;
      }

      await query(
        `UPDATE fbo_supply_items
         SET quantity = $1,
             mp_quantity = $1,
             placement_zone = $2,
             ozon_tags = $3::jsonb,
             sku = COALESCE(NULLIF(TRIM(sku), ''), $4),
             barcode = COALESCE(NULLIF(TRIM(barcode), ''), $5),
             mp_offer_id = COALESCE(NULLIF(TRIM(mp_offer_id), ''), $6),
             mp_product_id = COALESCE(NULLIF(TRIM(mp_product_id), ''), $7),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $8`,
        [
          ozQty,
          newZone,
          newTagsJson,
          ozonItem.sku ?? ozonItem.mpOfferId ?? null,
          ozonItem.barcode ?? null,
          ozonItem.mpOfferId ?? ozonItem.sku ?? null,
          ozonItem.mpProductId ?? null,
          row.id,
        ]
      );
      updated += 1;
    }

    let added = 0;
    for (let i = 0; i < ozonItems.length; i++) {
      if (usedOzon.has(i)) continue;
      const ozonItem = ozonItems[i];
      const ozQty = parseInt(ozonItem.quantity, 10) || 0;
      if (ozQty <= 0) continue;

      let productId = ozonItem.productId ?? null;
      if (!productId) {
        productId = await resolveProductId({
          sku: ozonItem.sku ?? ozonItem.mpOfferId,
          barcode: ozonItem.barcode,
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
          ozQty,
          ozQty,
          ozonItem.barcode ?? null,
          ozonItem.sku ?? ozonItem.mpOfferId ?? null,
          ozonItem.mpOfferId ?? ozonItem.sku ?? null,
          ozonItem.mpProductId ?? null,
          ozonItem.name ?? null,
          ozonItem.placementZone ?? null,
          JSON.stringify(ozonItem.ozonTags || []),
        ]
      );
      added += 1;
    }

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
      totalOzon: ozonItems.length,
      supply: updatedSupply,
      supplyStatus: sync.status,
      packingAllMatch: sync.allMatch,
      statusReverted: sync.reverted,
    };
  }
}

export default new FboSuppliesImportService();
