/**
 * Финансовые отчёты FBO: загрузка с маркетплейсов (WB, Ozon, Яндекс) и аналитика.
 */

import ExcelJS from 'exceljs';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';
import logger from '../utils/logger.js';
import { getYandexHttpsAgent, formatYandexNetworkError } from '../utils/yandex-https-agent.js';

const YM_API = 'https://api.partner.market.yandex.ru';

function parseDateYmd(raw, fallback) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback;
}

function formatPgDateYmd(value) {
  if (value == null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

/** Дата операции в календаре МСК (YYYY-MM-DD). */
function toDateYmdMoscow(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

function isDateInRangeYmd(ymd, dateFrom, dateTo) {
  if (!ymd || !dateFrom || !dateTo) return false;
  return ymd >= dateFrom && ymd <= dateTo;
}

function mapWbOperationDate(row) {
  return (
    toDateYmdMoscow(row?.sale_dt) ||
    toDateYmdMoscow(row?.order_dt) ||
    toDateYmdMoscow(row?.rr_dt) ||
    toDateYmdMoscow(row?.create_dt) ||
    null
  );
}

/** Ozon finance/transaction/list: не более одного календарного месяца за запрос. */
function splitDateRangeByCalendarMonth(dateFrom, dateTo) {
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const parseYmd = (s) => {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const start = parseYmd(dateFrom);
  const end = parseYmd(dateTo);
  if (start > end) return [{ dateFrom, dateTo }];

  const chunks = [];
  let cur = new Date(start);
  while (cur <= end) {
    const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const chunkTo = monthEnd < end ? monthEnd : end;
    chunks.push({ dateFrom: fmt(cur), dateTo: fmt(chunkTo) });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return chunks;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeMarketplaceFilter(raw) {
  const v = String(raw || 'all').trim().toLowerCase();
  if (!v || v === 'all') return null;
  if (v === 'ozon') return ['ozon'];
  if (v === 'wb' || v === 'wildberries') return ['wb', 'wildberries'];
  if (v === 'ym' || v === 'yandex' || v === 'yandexmarket') return ['ym', 'yandex', 'yandexmarket'];
  return [v];
}

function mpFilterValues(mpFilter) {
  return mpFilter.map((m) => (m === 'wildberries' ? 'wb' : m === 'yandex' || m === 'yandexmarket' ? 'ym' : m));
}

function buildFboReportQueryParams(pid, fromYmd, toYmd, mpFilter, { limit = null } = {}) {
  const params = [pid, fromYmd, toYmd];
  let mpClause = '';
  if (mpFilter) {
    params.push(mpFilterValues(mpFilter));
    mpClause = `AND LOWER(TRIM(l.marketplace)) = ANY($${params.length}::text[])`;
  }
  let limitClause = '';
  if (limit != null) {
    params.push(limit);
    limitClause = `LIMIT $${params.length}`;
  }
  return { params, mpClause, limitClause };
}

function normMpForDb(mp) {
  const m = String(mp || '').toLowerCase();
  if (m === 'wildberries') return 'wb';
  return m;
}

/** WB: офис/регион маркетплейса (FBO), не ПВЗ продавца. */
function isWbMpOffice(office) {
  const o = String(office || '').toLowerCase();
  return /\bмп\b/.test(o) || o.includes('маркетплейс') || o.includes('федеральный округ мп');
}

const WB_FBO_WAREHOUSE_MARKERS = [
  'электросталь',
  'коледино',
  'тула',
  'казань',
  'самара',
  'екатеринбург',
  'краснодар',
  'воронеж',
  'невинномысск',
  'рязань',
  'котовск',
  'владимир',
  'волгоград',
  'тверь',
  'новосемейкино',
  'перспективная',
  'сц ереван',
];

function isWbFboWarehouseOffice(office) {
  const o = String(office || '').toLowerCase().trim();
  if (!o || o.includes('пвз')) return false;
  if (isWbMpOffice(o)) return true;
  return WB_FBO_WAREHOUSE_MARKERS.some((m) => o.includes(m));
}

const WB_FBO_WAREHOUSE_OPERATIONS = [
  'продажа',
  'логистика',
  'хранение',
  'возврат',
  'коррекция продаж',
  'обработка товара',
  'возмещение издержек',
  'штраф',
  'компенсация',
  'добровольная компенсация',
];

/**
 * WB reportDetailByPeriod: FBO = FBW (склад WB).
 * Поле delivery_method (не delivery_method_name), офис склада / «… МП», без ПВЗ и FBS.
 */
function isWbFboReportRow(row) {
  const dm = String(row?.delivery_method_name || row?.delivery_method || '').toLowerCase();
  const office = String(row?.office_name || '').toLowerCase();
  const oper = String(row?.supplier_oper_name || row?.doc_type_name || '').toLowerCase();

  if (dm.includes('fbs') || dm.includes('доставка продавца') || dm.includes('самовывоз продавца')) return false;
  if (dm.includes('dbs') || dm.includes('доставка силами продавца')) return false;
  if (oper.includes('пвз')) return false;

  if (dm.includes('fbw') || dm.includes('fbo')) return true;
  if (dm.includes('маркетплейс') || dm.includes('marketplace')) return true;

  if (isWbFboWarehouseOffice(office)) return true;

  if (!dm && !office && WB_FBO_WAREHOUSE_OPERATIONS.some((k) => oper.includes(k))) {
    return true;
  }

  return false;
}

function mapWbSku(row) {
  const raw =
    row?.sa_name ??
    row?.sa ??
    row?.supplierArticle ??
    row?.vendorCode ??
    row?.vendor_code ??
    null;
  if (raw != null && String(raw).trim()) return String(raw).trim();
  const nmId = row?.nm_id != null ? String(row.nm_id).trim() : '';
  if (nmId && nmId !== '0') return nmId;
  return null;
}

function mapWbProductName(row) {
  const article = String(row?.sa_name ?? row?.sa ?? row?.supplierArticle ?? '').trim();
  const brand = String(row?.brand_name ?? '').trim();
  if (brand && article) return `${brand} ${article}`;
  if (article) return article;
  const subject = row?.subject_name != null ? String(row.subject_name).trim() : '';
  if (subject) return subject;
  return row?.brand_name != null ? String(row.brand_name) : null;
}

function mapWbReportRow(row, profileId, syncId) {
  const qty = toNum(row?.quantity);
  const retail = toNum(row?.retail_amount);
  const commission =
    retail > 0 && row?.commission_percent != null
      ? (retail * toNum(row.commission_percent)) / 100
      : toNum(row?.ppvz_sales_commission);
  const logistics = toNum(row?.delivery_rub ?? row?.delivery_amount);
  const storage = toNum(row?.storage_fee);
  const penalty = toNum(row?.penalty);
  const acquiring = toNum(row?.acquiring_fee);
  const other = toNum(row?.deduction) + toNum(row?.additional_payment);
  const payout = toNum(row?.ppvz_for_pay ?? row?.for_pay);

  const saleDt = row?.sale_dt || row?.order_dt || row?.rr_dt;
  const operationDate = mapWbOperationDate(row);

  return {
    sync_id: syncId,
    profile_id: profileId,
    marketplace: 'wb',
    operation_date: operationDate,
    order_id: row?.srid != null ? String(row.srid) : row?.rid != null ? String(row.rid) : null,
    posting_number: row?.gi_id != null ? String(row.gi_id) : null,
    sku: mapWbSku(row),
    product_name: mapWbProductName(row),
    barcode: row?.barcode != null ? String(row.barcode) : null,
    quantity: qty,
    retail_amount: retail,
    commission_amount: Math.abs(commission),
    logistics_amount: Math.abs(logistics),
    storage_amount: Math.abs(storage),
    penalty_amount: Math.abs(penalty),
    acquiring_amount: Math.abs(acquiring),
    other_deductions: Math.abs(other),
    payout_amount: payout,
    operation_type: row?.supplier_oper_name != null ? String(row.supplier_oper_name) : row?.doc_type_name != null ? String(row.doc_type_name) : null,
    raw_json: row,
  };
}

/** Ozon: операция относится к FBO. */
function isOzonFboOperation(op) {
  const posting = String(op?.posting?.posting_number || op?.posting_number || '').toLowerCase();
  const schema = String(op?.posting?.delivery_schema || op?.delivery_schema || '').toLowerCase();
  if (schema === 'fbo') return true;
  if (posting.includes('fbo')) return true;
  const type = String(op?.operation_type || op?.type || '').toLowerCase();
  if (type.includes('fbo')) return true;
  return false;
}

function mapOzonTransactionRow(op, profileId, syncId) {
  const items = Array.isArray(op?.items) ? op.items : [];
  const firstItem = items[0] || {};
  const amount = toNum(op?.amount);
  const sale = amount > 0 ? amount : Math.abs(amount);

  let operationDate = null;
  const opDate = op?.operation_date || op?.date;
  if (opDate) {
    const d = new Date(opDate);
    if (!Number.isNaN(d.getTime())) operationDate = d.toISOString().slice(0, 10);
  }

  const services = Array.isArray(op?.services) ? op.services : [];
  let commission = 0;
  let logistics = 0;
  let storage = 0;
  let other = 0;
  for (const s of services) {
    const n = Math.abs(toNum(s?.price));
    const name = String(s?.name || '').toLowerCase();
    if (name.includes('комисси')) commission += n;
    else if (name.includes('логист') || name.includes('доставк')) logistics += n;
    else if (name.includes('хранен')) storage += n;
    else other += n;
  }

  return {
    sync_id: syncId,
    profile_id: profileId,
    marketplace: 'ozon',
    operation_date: operationDate,
    order_id: op?.posting?.order_id != null ? String(op.posting.order_id) : null,
    posting_number:
      op?.posting?.posting_number != null
        ? String(op.posting.posting_number)
        : op?.posting_number != null
          ? String(op.posting_number)
          : null,
    sku: firstItem?.sku != null ? String(firstItem.sku) : null,
    product_name: firstItem?.name != null ? String(firstItem.name) : null,
    barcode: null,
    quantity: toNum(firstItem?.quantity) || 1,
    retail_amount: sale,
    commission_amount: commission,
    logistics_amount: logistics,
    storage_amount: storage,
    penalty_amount: 0,
    acquiring_amount: 0,
    other_deductions: other,
    payout_amount: amount,
    operation_type: op?.operation_type != null ? String(op.operation_type) : op?.type != null ? String(op.type) : null,
    raw_json: op,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normSkuKey(sku) {
  return String(sku || '').trim().toLowerCase();
}

function mpToProductSkusMarketplace(mp) {
  const m = normMpForDb(mp);
  if (m === 'wb') return 'wb';
  if (m === 'ozon') return 'ozon';
  if (m === 'ym' || m === 'yandex' || m === 'yandexmarket') return 'ym';
  return m;
}

/** Яндекс: операция относится к FBY (FBO). */
function isYmFbyRow(row) {
  const model = String(row?.model || row?.MODEL || '').toUpperCase();
  if (model === 'FBY') return true;
  if (model === 'FBS' || model === 'DBS' || model === 'LAAS') return false;
  return true;
}

function categorizeYmAmounts(row) {
  const sum = toNum(row?.transactionSum ?? row?.TRANSACTION_SUM);
  const abs = Math.abs(sum);
  const src = String(row?.transactionSource ?? row?.TRANSACTION_SOURCE ?? '').toLowerCase();
  const type = String(row?.transactionType ?? row?.TRANSACTION_TYPE ?? '').toLowerCase();

  const amounts = {
    retail_amount: 0,
    commission_amount: 0,
    logistics_amount: 0,
    storage_amount: 0,
    penalty_amount: 0,
    acquiring_amount: 0,
    other_deductions: 0,
    payout_amount: sum,
  };

  if (src.includes('оплат') && src.includes('покупател')) {
    amounts.retail_amount = abs;
    return amounts;
  }
  if (src.includes('продаж') || (type.includes('начисл') && sum > 0)) {
    amounts.retail_amount = abs;
    return amounts;
  }
  if (src.includes('вознагражден') || src.includes('комисс')) {
    amounts.commission_amount = abs;
    return amounts;
  }
  if (src.includes('доставк') || src.includes('логист') || src.includes('сортиров')) {
    amounts.logistics_amount = abs;
    return amounts;
  }
  if (src.includes('хранен')) {
    amounts.storage_amount = abs;
    return amounts;
  }
  if (src.includes('штраф') || src.includes('претенз')) {
    amounts.penalty_amount = abs;
    return amounts;
  }
  if (src.includes('эквайр') || src.includes('платеж')) {
    amounts.acquiring_amount = abs;
    return amounts;
  }

  if (sum < 0 || type.includes('удерж')) {
    amounts.other_deductions = abs;
  } else if (sum > 0) {
    amounts.retail_amount = abs;
  }
  return amounts;
}

function mapYmNettingRow(row, profileId, syncId) {
  const amounts = categorizeYmAmounts(row);
  const opDateRaw = row?.transactionDate ?? row?.TRANSACTION_DATE ?? row?.orderDeliveryDate ?? row?.ORDER_DELIVERY_DATE;
  let operationDate = null;
  if (opDateRaw) {
    const d = new Date(opDateRaw);
    if (!Number.isNaN(d.getTime())) operationDate = d.toISOString().slice(0, 10);
  }

  const sku = row?.shopSku ?? row?.SHOP_SKU ?? null;
  const orderId = row?.orderId ?? row?.ORDER_ID ?? null;

  return {
    sync_id: syncId,
    profile_id: profileId,
    marketplace: 'ym',
    operation_date: operationDate,
    order_id: orderId != null ? String(orderId) : null,
    posting_number: orderId != null ? String(orderId) : row?.shopOrderId != null ? String(row.shopOrderId) : null,
    sku: sku != null ? String(sku).trim() : null,
    product_name: row?.offerOrServiceName ?? row?.OFFER_OR_SERVICE_NAME ?? null,
    barcode: null,
    quantity: toNum(row?.count ?? row?.COUNT) || (amounts.retail_amount > 0 ? 1 : 0),
    ...amounts,
    operation_type: [row?.transactionType ?? row?.TRANSACTION_TYPE, row?.transactionSource ?? row?.TRANSACTION_SOURCE]
      .filter(Boolean)
      .join(' / '),
    raw_json: row,
  };
}

function normalizeYmCellValue(cell) {
  if (!cell) return '';
  let v = cell.value;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText && Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return normalizeYmCellValue({ value: v.result });
  }
  return String(v).trim();
}

function ymHeaderToField(header) {
  const h = String(header || '').toLowerCase();
  if (h.includes('sku') || h.includes('ваш sku')) return 'shopSku';
  if (h.includes('номер заказа') || h === 'order_id' || h.includes('orderid')) return 'orderId';
  if (h.includes('дата транзакции') || h.includes('transaction_date')) return 'transactionDate';
  if (h.includes('сумма транзакции') || h.includes('transaction_sum')) return 'transactionSum';
  if (h.includes('тип транзакции') || h.includes('transaction_type')) return 'transactionType';
  if (h.includes('источник транзакции') || h.includes('transaction_source')) return 'transactionSource';
  if (h.includes('модел') || h === 'model') return 'model';
  if (h.includes('название товара') || h.includes('offer_or_service')) return 'offerOrServiceName';
  if (h.includes('количество') || h === 'count') return 'count';
  if (h.includes('ваш номер заказа') || h.includes('shop_order')) return 'shopOrderId';
  return null;
}

async function parseYmUnitedNettingXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const rows = [];

  for (const sheet of wb.worksheets) {
    if (!sheet || sheet.rowCount < 2) continue;
    let headerRowNum = 1;
    let fieldByCol = null;

    for (let r = 1; r <= Math.min(8, sheet.rowCount || 8); r += 1) {
      const row = sheet.getRow(r);
      const mapping = {};
      let hits = 0;
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const field = ymHeaderToField(normalizeYmCellValue(cell));
        if (field) {
          mapping[col] = field;
          hits += 1;
        }
      });
      if (hits >= 3) {
        headerRowNum = r;
        fieldByCol = mapping;
        break;
      }
    }

    if (!fieldByCol || Object.keys(fieldByCol).length < 3) continue;

    for (let r = headerRowNum + 1; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      const obj = {};
      for (const [col, field] of Object.entries(fieldByCol)) {
        obj[field] = normalizeYmCellValue(row.getCell(Number(col)));
      }
      if (!obj.transactionSum && !obj.orderId && !obj.shopSku) continue;
      rows.push(obj);
    }
  }

  return rows;
}

async function resolveYandexBusinessId(cfg) {
  let businessId = cfg?.business_id ?? cfg?.businessId ?? null;
  const campaignId = cfg?.campaign_id ?? cfg?.campaignId ?? null;
  const apiKey = integrationsService._normalizeYandexApiKey(cfg?.api_key ?? cfg?.apiKey);
  if ((businessId == null || businessId === '') && campaignId != null && String(campaignId).trim() !== '') {
    try {
      const meta = await integrationsService._fetchYandexCampaignSnapshot(campaignId, apiKey);
      businessId = meta?.businessId ?? businessId;
    } catch (_) {
      /* ignore */
    }
  }
  const bid = businessId != null ? Number(businessId) : NaN;
  if (!Number.isFinite(bid) || bid < 1) {
    throw new Error('Укажите business_id в настройках Яндекс.Маркета');
  }
  return bid;
}

async function fetchYmUnitedNettingReport(apiKey, businessId, dateFrom, dateTo) {
  const agent = getYandexHttpsAgent();
  const headers = { 'Api-Key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
  const generateUrl = `${YM_API}/v2/reports/united-netting/generate?format=FILE&language=RU`;

  let genRes;
  try {
    genRes = await fetch(generateUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        businessId: Number(businessId),
        dateFrom,
        dateTo,
        placementPrograms: ['FBY'],
      }),
      ...(agent ? { agent } : {}),
    });
  } catch (e) {
    throw new Error(`Яндекс.Маркет: не удалось заказать отчёт. ${formatYandexNetworkError(e)}`);
  }

  if (!genRes.ok) {
    throw new Error(`YM united-netting/generate: ${genRes.status} ${(await genRes.text().catch(() => '')).slice(0, 300)}`);
  }

  const genData = await genRes.json();
  const reportId = genData?.result?.reportId;
  if (!reportId) throw new Error('YM: не получен reportId');

  const waitMs = Math.max(5000, Number(genData?.result?.estimatedGenerationTime) || 15000);
  const deadline = Date.now() + Math.min(10 * 60 * 1000, waitMs + 5 * 60 * 1000);

  while (Date.now() < deadline) {
    const infoRes = await (async () => {
      try {
        return await fetch(`${YM_API}/v2/reports/info/${encodeURIComponent(String(reportId))}`, {
          method: 'GET',
          headers,
          ...(agent ? { agent } : {}),
        });
      } catch (e) {
        throw new Error(`Яндекс.Маркет: ошибка статуса отчёта. ${formatYandexNetworkError(e)}`);
      }
    })();

    if (!infoRes.ok) {
      throw new Error(`YM reports/info: ${infoRes.status} ${(await infoRes.text().catch(() => '')).slice(0, 300)}`);
    }

    const info = await infoRes.json();
    const status = String(info?.result?.status || info?.status || '').toUpperCase();
    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(info?.result?.error || info?.errors?.[0]?.message || 'YM: генерация отчёта завершилась с ошибкой');
    }

    const fileUrl = info?.result?.file ?? info?.result?.url ?? info?.result?.downloadUrl;
    if (status === 'DONE' && fileUrl) {
      const fileRes = await fetch(fileUrl, { ...(agent ? { agent } : {}) });
      if (!fileRes.ok) {
        throw new Error(`YM: не удалось скачать отчёт (${fileRes.status})`);
      }
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const rawRows = await parseYmUnitedNettingXlsx(buffer);
      return rawRows;
    }

    const nextWait = Math.min(15000, Math.max(3000, Number(info?.result?.estimatedGenerationTime) || waitMs));
    await sleep(nextWait);
  }

  throw new Error('YM: превышено время ожидания генерации отчёта');
}

async function buildProductSkuLookup(profileId) {
  const map = new Map();
  const res = await query(
    `SELECT ps.marketplace, TRIM(ps.sku) AS sku, ps.product_id,
            ps.marketplace_product_id,
            p.sku AS erp_sku, p.mp_wb_vendor_code
     FROM product_skus ps
     JOIN products p ON p.id = ps.product_id
     WHERE p.profile_id = $1`,
    [profileId]
  );

  for (const row of res.rows || []) {
    const mp = mpToProductSkusMarketplace(row.marketplace);
    if (row.sku) map.set(`${mp}:${normSkuKey(row.sku)}`, row.product_id);
    if (mp === 'wb' && row.mp_wb_vendor_code) map.set(`wb:${normSkuKey(row.mp_wb_vendor_code)}`, row.product_id);
    if (mp === 'ozon' && row.marketplace_product_id != null) {
      map.set(`ozon:${normSkuKey(String(row.marketplace_product_id))}`, row.product_id);
    }
  }

  const direct = await query(
    `SELECT id, sku, mp_wb_vendor_code FROM products WHERE profile_id = $1`,
    [profileId]
  );
  for (const p of direct.rows || []) {
    if (p.sku) {
      map.set(`wb:${normSkuKey(p.sku)}`, p.id);
      map.set(`ozon:${normSkuKey(p.sku)}`, p.id);
      map.set(`ym:${normSkuKey(p.sku)}`, p.id);
    }
    if (p.mp_wb_vendor_code) map.set(`wb:${normSkuKey(p.mp_wb_vendor_code)}`, p.id);
  }

  return map;
}

function resolveLineProductId(lookup, line) {
  const mp = mpToProductSkusMarketplace(line.marketplace);
  if (line.sku) {
    const hit = lookup.get(`${mp}:${normSkuKey(line.sku)}`);
    if (hit) return hit;
  }
  if (mp === 'ozon' && line.sku && /^\d+$/.test(String(line.sku).trim())) {
    const hit = lookup.get(`ozon:${normSkuKey(line.sku)}`);
    if (hit) return hit;
  }
  return null;
}

async function linkReportLinesToProducts(profileId, syncId = null) {
  const params = [profileId];
  const syncFilter = syncId != null ? 'AND l2.sync_id = $2' : '';
  if (syncId != null) params.push(syncId);

  const syncClause = syncId != null ? ' AND l.sync_id = $2' : '';

  await query(
    `UPDATE marketplace_fbo_report_lines l
     SET product_id = matched.product_id
     FROM (
       SELECT DISTINCT ON (line_id) line_id, product_id
       FROM (
         SELECT l2.id AS line_id, ps.product_id
         FROM marketplace_fbo_report_lines l2
         JOIN products p ON p.profile_id = l2.profile_id
         JOIN product_skus ps ON ps.product_id = p.id
           AND ps.marketplace = CASE l2.marketplace
             WHEN 'wb' THEN 'wb'
             WHEN 'ozon' THEN 'ozon'
             WHEN 'ym' THEN 'ym'
             WHEN 'yandex' THEN 'ym'
             ELSE l2.marketplace
           END
         WHERE l2.profile_id = $1
           AND l2.product_id IS NULL
           AND l2.sku IS NOT NULL
           AND TRIM(l2.sku) <> ''
           AND TRIM(ps.sku) = TRIM(l2.sku)
           ${syncFilter}
         UNION ALL
         SELECT l2.id, p.id
         FROM marketplace_fbo_report_lines l2
         JOIN products p ON p.profile_id = l2.profile_id
         WHERE l2.profile_id = $1
           AND l2.product_id IS NULL
           AND l2.sku IS NOT NULL
           AND TRIM(l2.sku) <> ''
           AND l2.marketplace IN ('wb', 'wildberries')
           AND LOWER(TRIM(COALESCE(p.mp_wb_vendor_code, ''))) = LOWER(TRIM(l2.sku))
           ${syncFilter}
         UNION ALL
         SELECT l2.id, b.product_id
         FROM marketplace_fbo_report_lines l2
         JOIN barcodes b ON TRIM(b.barcode) = TRIM(l2.barcode)
         JOIN products p ON p.id = b.product_id AND p.profile_id = l2.profile_id
         WHERE l2.profile_id = $1
           AND l2.product_id IS NULL
           AND l2.barcode IS NOT NULL
           AND TRIM(l2.barcode) <> ''
           ${syncFilter}
         UNION ALL
         SELECT l2.id, ps.product_id
         FROM marketplace_fbo_report_lines l2
         JOIN product_skus ps ON ps.marketplace = 'ozon'
           AND ps.marketplace_product_id IS NOT NULL
           AND TRIM(CAST(ps.marketplace_product_id AS TEXT)) = TRIM(l2.sku)
         JOIN products p ON p.id = ps.product_id AND p.profile_id = l2.profile_id
         WHERE l2.profile_id = $1
           AND l2.marketplace = 'ozon'
           AND l2.product_id IS NULL
           AND l2.sku IS NOT NULL
           AND TRIM(l2.sku) <> ''
           ${syncFilter}
       ) all_matches
       ORDER BY line_id, product_id
     ) matched
     WHERE l.id = matched.line_id
       AND l.profile_id = $1
       ${syncClause}`,
    params
  );
}

async function insertReportLines(lines, productLookup = null) {
  if (!lines.length) return 0;
  const cols = [
    'sync_id',
    'profile_id',
    'marketplace',
    'operation_date',
    'order_id',
    'posting_number',
    'sku',
    'product_name',
    'barcode',
    'product_id',
    'quantity',
    'retail_amount',
    'commission_amount',
    'logistics_amount',
    'storage_amount',
    'penalty_amount',
    'acquiring_amount',
    'other_deductions',
    'payout_amount',
    'operation_type',
    'raw_json',
  ];
  const batchSize = 200;
  let inserted = 0;
  for (let i = 0; i < lines.length; i += batchSize) {
    const batch = lines.slice(i, i + batchSize);
    const values = [];
    const params = [];
    let p = 1;
    for (const row of batch) {
      const productId = row.product_id ?? (productLookup ? resolveLineProductId(productLookup, row) : null);
      values.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
      );
      params.push(
        row.sync_id,
        row.profile_id,
        row.marketplace,
        row.operation_date,
        row.order_id,
        row.posting_number,
        row.sku,
        row.product_name,
        row.barcode,
        productId,
        row.quantity,
        row.retail_amount,
        row.commission_amount,
        row.logistics_amount,
        row.storage_amount,
        row.penalty_amount,
        row.acquiring_amount,
        row.other_deductions,
        row.payout_amount,
        row.operation_type,
        JSON.stringify(row.raw_json ?? {})
      );
    }
    await query(
      `INSERT INTO marketplace_fbo_report_lines (${cols.join(', ')}) VALUES ${values.join(', ')}`,
      params
    );
    inserted += batch.length;
  }
  return inserted;
}

async function createSyncRun({ profileId, marketplace, dateFrom, dateTo }) {
  const res = await query(
    `INSERT INTO marketplace_fbo_report_syncs (profile_id, marketplace, date_from, date_to, status)
     VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
    [profileId, marketplace, dateFrom, dateTo]
  );
  return res.rows[0]?.id;
}

async function finishSyncRun(syncId, { status, rowsImported = 0, errorMessage = null }) {
  await query(
    `UPDATE marketplace_fbo_report_syncs
     SET status = $2, rows_imported = $3, error_message = $4, finished_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [syncId, status, rowsImported, errorMessage]
  );
}

async function enrichWbLinesFromOrderSale(profileId) {
  await query(
    `UPDATE marketplace_fbo_report_lines child
     SET
       sku = sale.sku,
       product_name = sale.product_name,
       product_id = COALESCE(child.product_id, sale.product_id)
     FROM (
       SELECT DISTINCT ON (profile_id, order_id)
         profile_id,
         order_id,
         sku,
         product_name,
         product_id
       FROM marketplace_fbo_report_lines
       WHERE marketplace = 'wb'
         AND profile_id = $1
         AND operation_type = 'Продажа'
         AND order_id IS NOT NULL
         AND TRIM(order_id) <> ''
         AND sku IS NOT NULL
         AND TRIM(sku) <> ''
         AND sku <> '0'
       ORDER BY profile_id, order_id, id DESC
     ) sale
     WHERE child.marketplace = 'wb'
       AND child.profile_id = sale.profile_id
       AND child.order_id = sale.order_id
       AND child.profile_id = $1
       AND (
         child.sku IS NULL OR TRIM(child.sku) = '' OR child.sku = '0'
         OR child.product_name IS NULL OR TRIM(child.product_name) = ''
         OR child.product_id IS NULL
       )`,
    [profileId]
  );
}

async function backfillWbLineIdentity(profileId) {
  await query(
    `UPDATE marketplace_fbo_report_lines
     SET sku = COALESCE(
           NULLIF(TRIM(raw_json->>'sa_name'), ''),
           NULLIF(TRIM(raw_json->>'sa'), ''),
           NULLIF(TRIM(raw_json->>'supplierArticle'), ''),
           NULLIF(TRIM(raw_json->>'nm_id'), ''),
           sku
         ),
         product_name = CASE
           WHEN NULLIF(TRIM(COALESCE(raw_json->>'sa_name', raw_json->>'sa', raw_json->>'supplierArticle')), '') IS NOT NULL
           THEN TRIM(CONCAT_WS(' ',
             NULLIF(TRIM(raw_json->>'brand_name'), ''),
             TRIM(COALESCE(raw_json->>'sa_name', raw_json->>'sa', raw_json->>'supplierArticle'))
           ))
           ELSE product_name
         END,
         operation_date = COALESCE(
           ((NULLIF(TRIM(raw_json->>'sale_dt'), ''))::timestamptz AT TIME ZONE 'Europe/Moscow')::date,
           NULLIF(TRIM(raw_json->>'rr_dt'), '')::date,
           NULLIF(TRIM(raw_json->>'create_dt'), '')::date,
           operation_date
         )
     WHERE profile_id = $1 AND marketplace = 'wb'`,
    [profileId]
  );
  await enrichWbLinesFromOrderSale(profileId);
  try {
    await linkReportLinesToProducts(profileId);
  } catch (e) {
    logger.warn('[FBO Reports] WB backfill product link failed:', e?.message || e);
  }
}

async function deleteFboLinesForPeriod(profileId, marketplace, dateFrom, dateTo) {
  await query(
    `DELETE FROM marketplace_fbo_report_lines
     WHERE profile_id = $1
       AND marketplace = $2
       AND operation_date >= $3::date
       AND operation_date <= $4::date`,
    [profileId, marketplace, dateFrom, dateTo]
  );
}

async function fetchWbReportDetailByPeriod(apiKey, dateFrom, dateTo) {
  const token = String(apiKey || '').trim();
  if (!token) throw new Error('Не настроен API-ключ Wildberries');

  const allRows = [];
  let rrdid = 0;
  const limit = 100000;

  for (let page = 0; page < 50; page += 1) {
    const url = new URL('https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod');
    url.searchParams.set('dateFrom', dateFrom);
    url.searchParams.set('dateTo', dateTo);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('rrdid', String(rrdid));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: token, Accept: 'application/json' },
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 404 || page === 0) {
        const fallbackUrl = `https://statistics-api.wildberries.ru/api/v1/supplier/reportDetailByPeriod?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`;
        const r2 = await fetch(fallbackUrl, {
          method: 'GET',
          headers: { Authorization: token, Accept: 'application/json' },
        });
        if (!r2.ok) {
          throw new Error(`WB reportDetailByPeriod: ${r2.status} ${await r2.text().catch(() => '')}`);
        }
        const data2 = await r2.json();
        return Array.isArray(data2) ? data2 : [];
      }
      throw new Error(`WB reportDetailByPeriod: ${response.status} ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const chunk = Array.isArray(data) ? data : [];
    if (!chunk.length) break;
    allRows.push(...chunk);
    const last = chunk[chunk.length - 1];
    const nextRrdid = last?.rrd_id ?? last?.rrdid;
    if (nextRrdid == null || nextRrdid === rrdid || chunk.length < limit) break;
    rrdid = nextRrdid;
  }

  return allRows;
}

async function fetchOzonFinanceTransactionsChunk({ clientId, apiKey, dateFrom, dateTo }) {
  const cid = String(clientId || '').trim();
  const key = String(apiKey || '').trim();
  if (!cid || !key) throw new Error('Не настроены Client-Id / Api-Key Ozon');

  const allOps = [];
  let page = 1;
  const pageSize = 1000;

  for (let guard = 0; guard < 100; guard += 1) {
    const response = await fetch('https://api-seller.ozon.ru/v3/finance/transaction/list', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Client-Id': cid,
        'Api-Key': key,
      },
      body: JSON.stringify({
        filter: {
          date: { from: `${dateFrom}T00:00:00.000Z`, to: `${dateTo}T23:59:59.999Z` },
          operation_type: [],
          posting_number: '',
          transaction_type: 'all',
        },
        page,
        page_size: pageSize,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ozon finance/transaction/list: ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`);
    }

    const data = await response.json();
    const ops = data?.result?.operations;
    const chunk = Array.isArray(ops) ? ops : [];
    allOps.push(...chunk);
    if (chunk.length < pageSize) break;
    page += 1;
  }

  return allOps;
}

async function fetchOzonFinanceTransactions({ clientId, apiKey, dateFrom, dateTo }) {
  const monthChunks = splitDateRangeByCalendarMonth(dateFrom, dateTo);
  const allOps = [];
  for (const chunk of monthChunks) {
    const ops = await fetchOzonFinanceTransactionsChunk({ clientId, apiKey, ...chunk });
    allOps.push(...ops);
  }
  return allOps;
}

class MarketplaceFboReportsService {
  async syncWb({ profileId, dateFrom, dateTo }) {
    const cfg = await integrationsService.getMarketplaceConfig('wildberries', { profileId });
    const apiKey = cfg?.api_key || cfg?.apiKey;
    const syncId = await createSyncRun({
      profileId,
      marketplace: 'wb',
      dateFrom,
      dateTo,
    });

    try {
      const productLookup = await buildProductSkuLookup(profileId);
      await deleteFboLinesForPeriod(profileId, 'wb', dateFrom, dateTo);
      const rawRows = await fetchWbReportDetailByPeriod(apiKey, dateFrom, dateTo);
      const fboRows = rawRows.filter(isWbFboReportRow);
      const mapped = fboRows
        .map((row) => mapWbReportRow(row, profileId, syncId))
        .filter((row) => isDateInRangeYmd(row.operation_date, dateFrom, dateTo));
      const inserted = await insertReportLines(mapped, productLookup);
      try {
        await linkReportLinesToProducts(profileId, syncId);
      } catch (linkErr) {
        logger.warn('[FBO Reports] product link failed (wb):', linkErr?.message || linkErr);
      }
      await backfillWbLineIdentity(profileId);
      await finishSyncRun(syncId, { status: 'done', rowsImported: inserted });
      return { syncId, marketplace: 'wb', rowsImported: inserted, totalFetched: rawRows.length, fboFiltered: fboRows.length };
    } catch (e) {
      await finishSyncRun(syncId, { status: 'error', errorMessage: e.message || String(e) });
      throw e;
    }
  }

  async syncOzon({ profileId, dateFrom, dateTo }) {
    const cfg = await integrationsService.getMarketplaceConfig('ozon', { profileId });
    const clientId = cfg?.client_id || cfg?.clientId;
    const apiKey = cfg?.api_key || cfg?.apiKey;
    const syncId = await createSyncRun({
      profileId,
      marketplace: 'ozon',
      dateFrom,
      dateTo,
    });

    try {
      const productLookup = await buildProductSkuLookup(profileId);
      await deleteFboLinesForPeriod(profileId, 'ozon', dateFrom, dateTo);
      const ops = await fetchOzonFinanceTransactions({ clientId, apiKey, dateFrom, dateTo });
      const fboOps = ops.filter(isOzonFboOperation);
      const mapped = fboOps.map((op) => mapOzonTransactionRow(op, profileId, syncId));
      const inserted = await insertReportLines(mapped, productLookup);
      try {
        await linkReportLinesToProducts(profileId, syncId);
      } catch (linkErr) {
        logger.warn('[FBO Reports] product link failed (ozon):', linkErr?.message || linkErr);
      }
      await finishSyncRun(syncId, { status: 'done', rowsImported: inserted });
      return { syncId, marketplace: 'ozon', rowsImported: inserted, totalFetched: ops.length, fboFiltered: fboOps.length };
    } catch (e) {
      await finishSyncRun(syncId, { status: 'error', errorMessage: e.message || String(e) });
      throw e;
    }
  }

  async syncYm({ profileId, dateFrom, dateTo }) {
    const cfg = await integrationsService.getMarketplaceConfig('yandex', { profileId });
    const apiKey = integrationsService._normalizeYandexApiKey(cfg?.api_key ?? cfg?.apiKey);
    if (!apiKey) throw new Error('Не настроен Api-Key Яндекс.Маркета');

    const businessId = await resolveYandexBusinessId(cfg);
    const syncId = await createSyncRun({
      profileId,
      marketplace: 'ym',
      dateFrom,
      dateTo,
    });

    try {
      const productLookup = await buildProductSkuLookup(profileId);
      await deleteFboLinesForPeriod(profileId, 'ym', dateFrom, dateTo);
      const rawRows = await fetchYmUnitedNettingReport(apiKey, businessId, dateFrom, dateTo);
      const fbyRows = rawRows.filter(isYmFbyRow);
      const mapped = fbyRows.map((row) => mapYmNettingRow(row, profileId, syncId));
      const inserted = await insertReportLines(mapped, productLookup);
      try {
        await linkReportLinesToProducts(profileId, syncId);
      } catch (linkErr) {
        logger.warn('[FBO Reports] product link failed (ym):', linkErr?.message || linkErr);
      }
      await finishSyncRun(syncId, { status: 'done', rowsImported: inserted });
      return { syncId, marketplace: 'ym', rowsImported: inserted, totalFetched: rawRows.length, fboFiltered: fbyRows.length };
    } catch (e) {
      await finishSyncRun(syncId, { status: 'error', errorMessage: e.message || String(e) });
      throw e;
    }
  }

  /**
   * Синхронизация FBO-отчётов с маркетплейсов за период.
   */
  async sync({ profileId, dateFrom = null, dateTo = null, marketplace = 'all' } = {}) {
    const pid = profileId != null ? Number(profileId) : null;
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Доступно только с PostgreSQL');
      err.statusCode = 501;
      throw err;
    }

    const defaults = defaultDateRange();
    const fromYmd = parseDateYmd(dateFrom, defaults.dateFrom);
    const toYmd = parseDateYmd(dateTo, defaults.dateTo);
    const mp = String(marketplace || 'all').toLowerCase();

    const results = [];
    const errors = [];

    const runMp = async (code, fn) => {
      try {
        return { ok: true, code, data: await fn() };
      } catch (e) {
        logger.warn(`[FBO Reports] sync ${code} failed:`, e.message);
        return { ok: false, code, message: e.message || String(e) };
      }
    };

    const tasks = [];
    if (mp === 'all' || mp === 'wb' || mp === 'wildberries') {
      tasks.push(runMp('wb', () => this.syncWb({ profileId: pid, dateFrom: fromYmd, dateTo: toYmd })));
    }
    if (mp === 'all' || mp === 'ozon') {
      tasks.push(runMp('ozon', () => this.syncOzon({ profileId: pid, dateFrom: fromYmd, dateTo: toYmd })));
    }
    if (mp === 'all' || mp === 'ym' || mp === 'yandex' || mp === 'yandexmarket') {
      tasks.push(runMp('ym', () => this.syncYm({ profileId: pid, dateFrom: fromYmd, dateTo: toYmd })));
    }

    const settled = await Promise.all(tasks);
    for (const item of settled) {
      if (item.ok) results.push(item.data);
      else errors.push({ marketplace: item.code, message: item.message });
    }

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd },
      marketplace: mp,
      results,
      errors: errors.length ? errors : undefined,
    };
  }

  /**
   * Аналитика FBO по товарам из загруженных финансовых строк.
   */
  async getFboByProduct({ profileId, dateFrom = null, dateTo = null, marketplace = 'all', limit = 500 } = {}) {
    const pid = profileId != null ? Number(profileId) : null;
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Доступно только с PostgreSQL');
      err.statusCode = 501;
      throw err;
    }

    const defaults = defaultDateRange();
    const fromYmd = parseDateYmd(dateFrom, defaults.dateFrom);
    const toYmd = parseDateYmd(dateTo, defaults.dateTo);
    const mpFilter = normalizeMarketplaceFilter(marketplace);
    const rowLimit = Math.min(1000, Math.max(1, parseInt(limit, 10) || 500));

    const itemsQuery = buildFboReportQueryParams(pid, fromYmd, toYmd, mpFilter, { limit: rowLimit });
    const summaryQuery = buildFboReportQueryParams(pid, fromYmd, toYmd, mpFilter);

    if (!mpFilter || mpFilter.includes('wb') || mpFilter.includes('wildberries')) {
      await backfillWbLineIdentity(pid);
    }

    const itemsSql = `
      SELECT
        COALESCE(l.product_id, 0) AS product_id,
        COALESCE(NULLIF(TRIM(l.sku), ''), '—') AS sku,
        MAX(COALESCE(p.name, l.product_name)) AS product_name,
        MAX(p.sku) AS erp_sku,
        SUM(
          CASE
            WHEN l.marketplace IN ('wb', 'wildberries') AND l.operation_type = 'Продажа' THEN GREATEST(l.quantity, 0)
            WHEN l.marketplace NOT IN ('wb', 'wildberries') THEN GREATEST(l.quantity, 0)
            ELSE 0
          END
        )::int AS sold_qty,
        SUM(l.retail_amount)::numeric AS sold_amount,
        SUM(l.commission_amount)::numeric AS commission_amount,
        SUM(l.logistics_amount)::numeric AS logistics_amount,
        SUM(l.storage_amount)::numeric AS storage_amount,
        SUM(l.penalty_amount)::numeric AS penalty_amount,
        SUM(l.acquiring_amount)::numeric AS acquiring_amount,
        SUM(l.other_deductions)::numeric AS other_deductions,
        SUM(l.payout_amount)::numeric AS payout_amount
      FROM marketplace_fbo_report_lines l
      LEFT JOIN products p ON p.id = l.product_id
      WHERE l.profile_id = $1
        AND l.operation_date >= $2::date AND l.operation_date <= $3::date
        ${itemsQuery.mpClause}
      GROUP BY COALESCE(l.product_id, 0), COALESCE(NULLIF(TRIM(l.sku), ''), '—')
      ORDER BY SUM(l.retail_amount) DESC, sku ASC
      ${itemsQuery.limitClause}
    `;

    const summarySql = `
      SELECT
        SUM(
          CASE
            WHEN l.marketplace IN ('wb', 'wildberries') AND l.operation_type = 'Продажа' THEN GREATEST(l.quantity, 0)
            WHEN l.marketplace NOT IN ('wb', 'wildberries') THEN GREATEST(l.quantity, 0)
            ELSE 0
          END
        )::int AS sold_qty,
        SUM(l.retail_amount)::numeric AS sold_amount,
        SUM(l.commission_amount)::numeric AS commission_amount,
        SUM(l.logistics_amount)::numeric AS logistics_amount,
        SUM(l.storage_amount)::numeric AS storage_amount,
        SUM(l.penalty_amount)::numeric AS penalty_amount,
        SUM(l.acquiring_amount)::numeric AS acquiring_amount,
        SUM(l.other_deductions)::numeric AS other_deductions,
        SUM(l.payout_amount)::numeric AS payout_amount,
        COUNT(
          DISTINCT CASE
            WHEN l.marketplace IN ('wb', 'wildberries') AND l.operation_type = 'Продажа'
              THEN NULLIF(TRIM(l.order_id), '')
            WHEN l.marketplace NOT IN ('wb', 'wildberries')
              THEN COALESCE(NULLIF(TRIM(l.posting_number), ''), NULLIF(TRIM(l.order_id), ''))
          END
        )::int AS orders_count
      FROM marketplace_fbo_report_lines l
      WHERE l.profile_id = $1
        AND l.operation_date >= $2::date AND l.operation_date <= $3::date
        ${summaryQuery.mpClause}
    `;

    const [itemsRes, summaryRes, lastSyncRes] = await Promise.all([
      query(itemsSql, itemsQuery.params),
      query(summarySql, summaryQuery.params),
      query(
        `SELECT marketplace, status, rows_imported, finished_at, error_message
         FROM marketplace_fbo_report_syncs
         WHERE profile_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [pid]
      ),
    ]);

    const summaryRow = summaryRes.rows?.[0] || {};
    const items = (itemsRes.rows || []).map((row) => ({
      productId: Number(row.product_id) || null,
      sku: row.sku || '—',
      erpSku: row.erp_sku || null,
      productName: row.product_name || '',
      soldQty: Number(row.sold_qty) || 0,
      soldAmount: Number(row.sold_amount) || 0,
      commissionAmount: Number(row.commission_amount) || 0,
      logisticsAmount: Number(row.logistics_amount) || 0,
      storageAmount: Number(row.storage_amount) || 0,
      penaltyAmount: Number(row.penalty_amount) || 0,
      acquiringAmount: Number(row.acquiring_amount) || 0,
      otherDeductions: Number(row.other_deductions) || 0,
      payoutAmount: Number(row.payout_amount) || 0,
      expensesTotal:
        Number(row.commission_amount) +
          Number(row.logistics_amount) +
          Number(row.storage_amount) +
          Number(row.penalty_amount) +
          Number(row.acquiring_amount) +
          Number(row.other_deductions) || 0,
    }));

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd },
      marketplace: mpFilter ? marketplace : 'all',
      summary: {
        soldQty: Number(summaryRow.sold_qty) || 0,
        soldAmount: Number(summaryRow.sold_amount) || 0,
        commissionAmount: Number(summaryRow.commission_amount) || 0,
        logisticsAmount: Number(summaryRow.logistics_amount) || 0,
        storageAmount: Number(summaryRow.storage_amount) || 0,
        penaltyAmount: Number(summaryRow.penalty_amount) || 0,
        acquiringAmount: Number(summaryRow.acquiring_amount) || 0,
        otherDeductions: Number(summaryRow.other_deductions) || 0,
        payoutAmount: Number(summaryRow.payout_amount) || 0,
        ordersCount: Number(summaryRow.orders_count) || 0,
        expensesTotal:
          Number(summaryRow.commission_amount) +
            Number(summaryRow.logistics_amount) +
            Number(summaryRow.storage_amount) +
            Number(summaryRow.penalty_amount) +
            Number(summaryRow.acquiring_amount) +
            Number(summaryRow.other_deductions) || 0,
      },
      items,
      recentSyncs: (lastSyncRes.rows || []).map((r) => ({
        marketplace: normMpForDb(r.marketplace),
        status: r.status,
        rowsImported: Number(r.rows_imported) || 0,
        finishedAt: r.finished_at,
        errorMessage: r.error_message,
      })),
    };
  }

  /**
   * Детализация FBO по заказам: одна строка на отправление, все операции отчёта свёрнуты.
   */
  async getFboByOrder({ profileId, dateFrom = null, dateTo = null, marketplace = 'all', limit = 500 } = {}) {
    const pid = profileId != null ? Number(profileId) : null;
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }

    const defaults = defaultDateRange();
    const fromYmd = parseDateYmd(dateFrom, defaults.dateFrom);
    const toYmd = parseDateYmd(dateTo, defaults.dateTo);
    const mpFilter = normalizeMarketplaceFilter(marketplace);
    const rowLimit = Math.min(1000, Math.max(1, parseInt(limit, 10) || 500));

    if (!mpFilter || mpFilter.includes('wb') || mpFilter.includes('wildberries')) {
      await enrichWbLinesFromOrderSale(pid);
      await linkReportLinesToProducts(pid);
    }

    const orderQuery = buildFboReportQueryParams(pid, fromYmd, toYmd, mpFilter, { limit: rowLimit });

    const sql = `
      WITH filtered AS (
        SELECT
          l.*,
          COALESCE(NULLIF(TRIM(l.order_id), ''), NULLIF(TRIM(l.posting_number), '')) AS order_key
        FROM marketplace_fbo_report_lines l
        WHERE l.profile_id = $1
          AND l.operation_date >= $2::date AND l.operation_date <= $3::date
          ${orderQuery.mpClause}
      ),
      sales AS (
        SELECT DISTINCT ON (f.marketplace, f.order_key)
          f.marketplace,
          f.order_key AS canonical_key,
          f.order_id,
          f.posting_number,
          f.product_id,
          NULLIF(TRIM(f.sku), '') AS sku,
          NULLIF(TRIM(f.product_name), '') AS product_name,
          f.barcode,
          f.operation_date
        FROM filtered f
        WHERE f.order_key IS NOT NULL
          AND (
            (f.marketplace IN ('wb', 'wildberries') AND f.operation_type = 'Продажа')
            OR f.marketplace NOT IN ('wb', 'wildberries')
          )
        ORDER BY f.marketplace, f.order_key, f.id DESC
      ),
      barcode_to_sale AS (
        SELECT DISTINCT ON (marketplace, barcode)
          marketplace,
          barcode,
          canonical_key
        FROM sales
        WHERE NULLIF(TRIM(barcode), '') IS NOT NULL
        ORDER BY marketplace, barcode, operation_date DESC
      ),
      mapped AS (
        SELECT
          f.*,
          COALESCE(
            CASE
              WHEN f.marketplace IN ('wb', 'wildberries') AND f.operation_type = 'Продажа' THEN f.order_key
              WHEN f.marketplace NOT IN ('wb', 'wildberries') THEN f.order_key
            END,
            s_same.canonical_key,
            bts.canonical_key
          ) AS canonical_key
        FROM filtered f
        LEFT JOIN sales s_same
          ON s_same.marketplace = f.marketplace
         AND s_same.canonical_key = f.order_key
        LEFT JOIN barcode_to_sale bts
          ON bts.marketplace = f.marketplace
         AND f.marketplace IN ('wb', 'wildberries')
         AND NULLIF(TRIM(f.barcode), '') IS NOT NULL
         AND bts.barcode = f.barcode
      ),
      identity AS (
        SELECT DISTINCT ON (marketplace, canonical_key)
          marketplace,
          canonical_key,
          order_id,
          posting_number,
          product_id,
          sku,
          product_name,
          erp_sku
        FROM (
          SELECT
            s.marketplace,
            s.canonical_key,
            s.order_id,
            s.posting_number,
            s.product_id,
            s.sku,
            COALESCE(p.name, s.product_name) AS product_name,
            p.sku AS erp_sku,
            0 AS prio
          FROM sales s
          LEFT JOIN products p ON p.id = s.product_id
          UNION ALL
          SELECT
            m.marketplace,
            m.canonical_key,
            m.order_id,
            m.posting_number,
            m.product_id,
            NULLIF(TRIM(m.sku), '') AS sku,
            COALESCE(p.name, NULLIF(TRIM(m.product_name), '')) AS product_name,
            p.sku AS erp_sku,
            CASE
              WHEN m.sku IS NOT NULL AND TRIM(m.sku) <> '' AND m.sku <> '0' THEN 1
              ELSE 9
            END AS prio
          FROM mapped m
          LEFT JOIN products p ON p.id = m.product_id
          WHERE m.canonical_key IS NOT NULL
        ) ranked
        ORDER BY marketplace, canonical_key, prio ASC, product_name NULLS LAST
      ),
      agg AS (
        SELECT
          m.marketplace,
          m.canonical_key,
          MAX(m.order_id) FILTER (WHERE NULLIF(TRIM(m.order_id), '') IS NOT NULL) AS order_id,
          MAX(m.posting_number) FILTER (
            WHERE NULLIF(TRIM(m.posting_number), '') IS NOT NULL AND TRIM(m.posting_number) <> '0'
          ) AS posting_number,
          COALESCE(
            MAX(m.operation_date) FILTER (WHERE m.operation_type = 'Продажа'),
            MAX(m.operation_date),
            MIN(m.operation_date)
          ) AS operation_date,
          SUM(CASE WHEN m.operation_type = 'Продажа' THEN GREATEST(m.quantity, 0) ELSE 0 END)::int AS quantity,
          SUM(m.retail_amount)::numeric AS retail_amount,
          SUM(m.commission_amount)::numeric AS commission_amount,
          SUM(m.logistics_amount)::numeric AS logistics_amount,
          SUM(m.storage_amount)::numeric AS storage_amount,
          SUM(m.penalty_amount)::numeric AS penalty_amount,
          SUM(m.acquiring_amount)::numeric AS acquiring_amount,
          SUM(m.other_deductions)::numeric AS other_deductions,
          SUM(m.payout_amount)::numeric AS payout_amount,
          COUNT(*)::int AS line_count
        FROM mapped m
        WHERE m.canonical_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM sales s
            WHERE s.marketplace = m.marketplace AND s.canonical_key = m.canonical_key
          )
        GROUP BY m.marketplace, m.canonical_key
      )
      SELECT
        a.marketplace,
        a.operation_date,
        a.order_id,
        a.posting_number,
        i.sku,
        i.product_id,
        i.product_name,
        i.erp_sku,
        a.quantity,
        a.retail_amount,
        a.commission_amount,
        a.logistics_amount,
        a.storage_amount,
        a.penalty_amount,
        a.acquiring_amount,
        a.other_deductions,
        a.payout_amount,
        a.line_count
      FROM agg a
      JOIN identity i ON i.marketplace = a.marketplace AND i.canonical_key = a.canonical_key
      ORDER BY a.operation_date DESC NULLS LAST, a.order_id DESC NULLS LAST
      ${orderQuery.limitClause}
    `;

    const res = await query(sql, orderQuery.params);
    const items = (res.rows || []).map((row) => ({
      marketplace: normMpForDb(row.marketplace),
      operationDate: formatPgDateYmd(row.operation_date),
      orderId: row.order_id,
      postingNumber: row.posting_number,
      sku: row.sku,
      productId: Number(row.product_id) || null,
      erpSku: row.erp_sku || null,
      productName: row.product_name,
      quantity: Number(row.quantity) || 0,
      retailAmount: Number(row.retail_amount) || 0,
      commissionAmount: Number(row.commission_amount) || 0,
      logisticsAmount: Number(row.logistics_amount) || 0,
      storageAmount: Number(row.storage_amount) || 0,
      penaltyAmount: Number(row.penalty_amount) || 0,
      acquiringAmount: Number(row.acquiring_amount) || 0,
      otherDeductions: Number(row.other_deductions) || 0,
      payoutAmount: Number(row.payout_amount) || 0,
      lineCount: Number(row.line_count) || 0,
      expensesTotal:
        Number(row.commission_amount) +
          Number(row.logistics_amount) +
          Number(row.storage_amount) +
          Number(row.penalty_amount) +
          Number(row.acquiring_amount) +
          Number(row.other_deductions) || 0,
    }));

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd },
      marketplace: mpFilter ? marketplace : 'all',
      items,
    };
  }
}

export default new MarketplaceFboReportsService();
