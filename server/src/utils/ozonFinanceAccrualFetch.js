/**
 * Ozon Finance: загрузка начислений через /v1/finance/accrual/*
 * (замена отключённого /v3/finance/transaction/list).
 *
 * Нормализуем ответ by-day к «плоским» operation-объектам старого API,
 * чтобы mapOzonTransactionRow / extractOzonFinanceAmounts продолжали работать.
 *
 * Категории accrued_category:
 * - POSTING — отправление (commission + delivery внутри posting.products[])
 * - ITEM — сборы по товару (item_fees, часто эквайринг)
 * - NON_ITEM — прочее без товара
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Money-объект { amount, currency } или число/строка. */
export function moneyAmount(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'object' && v.amount != null) return toNum(v.amount);
  return toNum(v);
}

function ymd(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d))) return String(d);
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Список YYYY-MM-DD включительно. */
export function eachUtcDateInclusive(dateFrom, dateTo) {
  const from = ymd(dateFrom);
  const to = ymd(dateTo);
  if (!from || !to) return [];
  const out = [];
  const cur = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  for (let guard = 0; guard < 400 && cur <= end; guard += 1) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function ozonPostJson({ clientId, apiKey, path, body }) {
  const res = await fetch(`https://api-seller.ozon.ru${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Client-Id': String(clientId),
      'Api-Key': String(apiKey),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Справочник типов начислений: id/code → { id, code, name }.
 */
export async function fetchOzonAccrualTypes({ clientId, apiKey }) {
  const { ok, status, json, text } = await ozonPostJson({
    clientId,
    apiKey,
    path: '/v1/finance/accrual/types',
    body: {},
  });
  if (!ok) {
    throw new Error(`Ozon finance/accrual/types: ${status} ${String(text).slice(0, 300)}`);
  }
  const root = json?.result ?? json ?? {};
  const list =
    (Array.isArray(json?.accrual_types) && json.accrual_types) ||
    (Array.isArray(root.accrual_types) && root.accrual_types) ||
    (Array.isArray(root) && root) ||
    (Array.isArray(root.types) && root.types) ||
    (Array.isArray(root.accruals) && root.accruals) ||
    (Array.isArray(json?.types) && json.types) ||
    [];
  const map = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id ?? item.accrual_id ?? item.type_id;
    const code = String(item.code || item.name || item.operation_type || item.accrued_category || id || '').trim();
    const name = String(item.name || item.title || item.operation_type_name || item.description || code).trim();
    const rec = { id, code, name };
    if (id != null) map.set(String(id), rec);
    if (code) map.set(code, rec);
  }
  return map;
}

function typeById(typesMap, typeId) {
  if (typeId == null) return null;
  return typesMap.get(String(typeId)) || null;
}

function servicesFromTypeFees(fees, typesMap) {
  const out = [];
  for (const fee of fees || []) {
    const hit = typeById(typesMap, fee?.type_id);
    const name = hit?.code || hit?.name || (fee?.type_id != null ? `type_${fee.type_id}` : 'fee');
    out.push({ name, price: moneyAmount(fee?.accrued ?? fee?.amount ?? fee?.price) });
  }
  return out;
}

function productItemsFromPosting(products) {
  return (Array.isArray(products) ? products : []).map((p) => ({
    sku: p?.sku ?? p?.offer_id ?? p?.product_id ?? null,
    name: p?.name ?? p?.product_name ?? null,
    quantity: toNum(p?.quantity) || 1,
  }));
}

function productItemsFromItemFees(itemFees) {
  const fees = itemFees?.fees;
  if (!Array.isArray(fees)) return [];
  return fees.map((f) => ({
    sku: f?.sku ?? null,
    name: null,
    quantity: toNum(f?.quantity) || 1,
  }));
}

/**
 * POSTING → продажа/сторно в формате старого transaction/list.
 */
function normalizePostingAccrual(accrual, typesMap, fallbackDate) {
  const products = Array.isArray(accrual?.posting?.products) ? accrual.posting.products : [];
  const first = products[0] || {};
  const commission = first.commission && typeof first.commission === 'object' ? first.commission : {};
  const sellerPrice = moneyAmount(commission.seller_price);
  const saleAmount = moneyAmount(commission.sale_amount ?? commission.seller_price);
  const saleCommission = moneyAmount(commission.sale_commission ?? commission.commission);
  const retailSigned = sellerPrice !== 0 ? sellerPrice : saleAmount;
  const total = moneyAmount(accrual.total_amount ?? accrual.amount);

  const deliveryServices = [];
  for (const p of products) {
    const services = p?.delivery?.services;
    if (!Array.isArray(services)) continue;
    deliveryServices.push(...servicesFromTypeFees(services, typesMap));
  }

  // Знак seller_price/sale_amount: плюс — продажа, минус — сторно/возврат (как в кабинете Ozon).
  const isSale = retailSigned > 0 || (retailSigned === 0 && total > 0);
  const isStorno = retailSigned < 0 || (retailSigned === 0 && total < 0 && saleCommission !== 0);
  let operationType = 'POSTING';
  if (isSale) operationType = 'OperationAgentDeliveredToCustomer';
  else if (isStorno) operationType = 'OperationAgentStornoDeliveredToCustomer';

  const unit = accrual.unit_number != null ? String(accrual.unit_number) : null;

  return {
    operation_id: accrual.accrual_id ?? accrual.operation_id ?? accrual.id ?? null,
    operation_type: operationType,
    operation_type_name: isSale ? 'Продажа' : isStorno ? 'Сторно продажи' : 'POSTING',
    operation_date: accrual.date || accrual.operation_date || fallbackDate,
    amount: total,
    accruals_for_sale: retailSigned,
    sale_commission: saleCommission,
    delivery_charge: 0,
    return_delivery_charge: 0,
    services: deliveryServices,
    items: productItemsFromPosting(products).length
      ? productItemsFromPosting(products)
      : [{ sku: null, name: null, quantity: 1 }],
    posting: {
      posting_number: unit,
      delivery_schema: accrual.posting?.delivery_schema ?? null,
      order_date: accrual.posting?.order_date ?? null,
      order_id: unit,
      warehouse_id: accrual.posting?.warehouse_id ?? null,
    },
    type: 'orders',
    accrued_category: 'POSTING',
    unit_number: unit,
  };
}

function normalizeItemAccrual(accrual, typesMap, fallbackDate) {
  const feeGroups = Array.isArray(accrual?.item_fees?.fees) ? accrual.item_fees.fees : [];
  const services = [];
  let primaryType = null;
  for (const group of feeGroups) {
    for (const fee of group?.fees || []) {
      if (!primaryType) primaryType = typeById(typesMap, fee?.type_id);
      services.push(...servicesFromTypeFees([fee], typesMap));
    }
  }
  const total = moneyAmount(accrual.total_amount ?? accrual.amount);
  const code = primaryType?.code || primaryType?.name || 'ITEM';
  const unit = accrual.unit_number != null ? String(accrual.unit_number) : null;
  const items = productItemsFromItemFees(accrual.item_fees);
  return {
    operation_id: accrual.accrual_id ?? accrual.operation_id ?? accrual.id ?? null,
    operation_type: code,
    operation_type_name: primaryType?.name || code,
    operation_date: accrual.date || accrual.operation_date || fallbackDate,
    amount: total,
    accruals_for_sale: 0,
    sale_commission: 0,
    delivery_charge: 0,
    return_delivery_charge: 0,
    services,
    items: items.length ? items : [{ sku: null, name: null, quantity: 1 }],
    posting: {
      posting_number: unit,
      delivery_schema: null,
      order_date: null,
      order_id: unit,
      warehouse_id: null,
    },
    type: code,
    accrued_category: 'ITEM',
    unit_number: unit,
  };
}

function normalizeNonItemAccrual(accrual, typesMap, fallbackDate) {
  const fee = accrual?.non_item_fee;
  const hit = typeById(typesMap, fee?.type_id);
  const code = hit?.code || hit?.name || 'NON_ITEM';
  const total = moneyAmount(accrual.total_amount ?? fee?.accrued ?? accrual.amount);
  const unit = accrual.unit_number != null ? String(accrual.unit_number) : null;
  const services = fee ? servicesFromTypeFees([fee], typesMap) : [];
  return {
    operation_id: accrual.accrual_id ?? accrual.operation_id ?? accrual.id ?? null,
    operation_type: code,
    operation_type_name: hit?.name || code,
    operation_date: accrual.date || accrual.operation_date || fallbackDate,
    amount: total,
    accruals_for_sale: 0,
    sale_commission: 0,
    delivery_charge: 0,
    return_delivery_charge: 0,
    services,
    items: [{ sku: null, name: null, quantity: 1 }],
    posting: {
      posting_number: unit,
      delivery_schema: null,
      order_date: null,
      order_id: unit,
      warehouse_id: null,
    },
    type: code,
    accrued_category: 'NON_ITEM',
    unit_number: unit,
  };
}

/** Одна запись by-day → operation-like (или несколько, если вложенные accruals). */
export function normalizeAccrualToOperation(accrual, typesMap = new Map(), fallbackDate = null) {
  if (!accrual || typeof accrual !== 'object') return null;
  const cat = String(accrual.accrued_category || '').toUpperCase();
  if (cat === 'POSTING') return normalizePostingAccrual(accrual, typesMap, fallbackDate);
  if (cat === 'ITEM') return normalizeItemAccrual(accrual, typesMap, fallbackDate);
  if (cat === 'NON_ITEM') return normalizeNonItemAccrual(accrual, typesMap, fallbackDate);

  // Устаревший/неожиданный формат — пытаемся не потерять сумму.
  const total = moneyAmount(accrual.total_amount ?? accrual.amount ?? accrual.accrual_amount ?? accrual.total);
  const unit = accrual.unit_number != null ? String(accrual.unit_number) : accrual.posting_number || null;
  return {
    operation_id: accrual.accrual_id ?? accrual.operation_id ?? accrual.id ?? null,
    operation_type: accrual.operation_type || accrual.accrued_category || 'UNKNOWN',
    operation_type_name: accrual.operation_type_name || null,
    operation_date: accrual.date || accrual.operation_date || fallbackDate,
    amount: total,
    accruals_for_sale: moneyAmount(accrual.accruals_for_sale ?? accrual.sale_amount),
    sale_commission: moneyAmount(accrual.sale_commission ?? accrual.commission),
    delivery_charge: moneyAmount(accrual.delivery_charge),
    return_delivery_charge: moneyAmount(accrual.return_delivery_charge),
    services: Array.isArray(accrual.services) ? accrual.services : [],
    items: [{ sku: accrual.sku ?? null, name: accrual.name ?? null, quantity: 1 }],
    posting: {
      posting_number: unit,
      delivery_schema: accrual.posting?.delivery_schema ?? accrual.delivery_schema ?? null,
      order_date: accrual.posting?.order_date ?? null,
      order_id: unit,
      warehouse_id: accrual.posting?.warehouse_id ?? null,
    },
    type: accrual.type ?? accrual.accrued_category ?? null,
    accrued_category: accrual.accrued_category ?? null,
    unit_number: unit,
  };
}

function extractAccrualList(json) {
  const root = json?.result ?? json ?? {};
  if (Array.isArray(root.accruals)) return { list: root.accruals, lastId: root.last_id ?? json?.last_id ?? '' };
  if (Array.isArray(root.postings)) return { list: root.postings, lastId: root.last_id ?? '', pageCount: root.page_count };
  if (Array.isArray(root)) return { list: root, lastId: json?.last_id ?? '' };
  if (Array.isArray(json?.accruals)) return { list: json.accruals, lastId: json.last_id ?? '' };
  if (Array.isArray(json?.postings)) return { list: json.postings, lastId: json.last_id ?? '', pageCount: json.page_count };
  return { list: [], lastId: '' };
}

/**
 * Разворачивает posting с вложенными accruals в список operation-like.
 */
function expandPostingOrAccrual(row, typesMap, fallbackDate) {
  if (!row || typeof row !== 'object') return [];
  if (Array.isArray(row.accruals) && row.accruals.length) {
    return row.accruals
      .map((acc) =>
        normalizeAccrualToOperation(
          {
            ...acc,
            posting: acc.posting || {
              posting_number: row.posting_number,
              delivery_schema: row.delivery_schema,
              order_date: row.order_date,
              order_id: row.order_id,
              warehouse_id: row.warehouse_id,
              products: row.products,
            },
            unit_number: acc.unit_number || row.unit_number || row.posting_number,
            products: acc.products || row.products,
          },
          typesMap,
          fallbackDate
        )
      )
      .filter(Boolean);
  }
  const one = normalizeAccrualToOperation(row, typesMap, fallbackDate);
  return one ? [one] : [];
}

async function fetchAccrualsByDay({ clientId, apiKey, dateFrom, dateTo, typesMap }) {
  const days = eachUtcDateInclusive(dateFrom, dateTo);
  const all = [];
  for (const day of days) {
    let lastId = '';
    for (let guard = 0; guard < 200; guard += 1) {
      const { ok, status, json, text } = await ozonPostJson({
        clientId,
        apiKey,
        path: '/v1/finance/accrual/by-day',
        body: { date: day, last_id: lastId || '' },
      });
      if (!ok) {
        throw new Error(`Ozon finance/accrual/by-day (${day}): ${status} ${String(text).slice(0, 300)}`);
      }
      const { list, lastId: nextId } = extractAccrualList(json);
      for (const row of list) {
        all.push(...expandPostingOrAccrual(row, typesMap, day));
      }
      if (!nextId || !list.length) break;
      lastId = String(nextId);
    }
  }
  return all;
}

/**
 * Загрузить начисления за период и вернуть operation-like массив (как у v3/transaction/list).
 * Используем by-day: postings не содержит ITEM (эквайринг) и часто отвечает 429.
 */
export async function fetchOzonFinanceAccrualOperations({ clientId, apiKey, dateFrom, dateTo }) {
  const cid = String(clientId || '').trim();
  const key = String(apiKey || '').trim();
  if (!cid || !key) throw new Error('Не настроены Client-Id / Api-Key Ozon');

  let typesMap = new Map();
  try {
    typesMap = await fetchOzonAccrualTypes({ clientId: cid, apiKey: key });
  } catch {
    typesMap = new Map();
  }

  return fetchAccrualsByDay({
    clientId: cid,
    apiKey: key,
    dateFrom,
    dateTo,
    typesMap,
  });
}

/**
 * Оставить FBS: POSTING со схемой FBS + связанные ITEM/NON_ITEM с тем же unit_number.
 */
export function filterOzonFbsAccrualOperations(ops) {
  const list = Array.isArray(ops) ? ops : [];
  const fbsUnits = new Set();
  for (const op of list) {
    const schema = String(op?.posting?.delivery_schema || op?.delivery_schema || '').toLowerCase();
    const unit = String(op?.posting?.posting_number || op?.unit_number || '').trim();
    if (unit && (schema === 'fbs' || schema === 'rfbs')) fbsUnits.add(unit);
  }
  return list.filter((op) => {
    const schema = String(op?.posting?.delivery_schema || '').toLowerCase();
    if (schema === 'fbs' || schema === 'rfbs') return true;
    const unit = String(op?.posting?.posting_number || op?.unit_number || '').trim();
    return unit !== '' && fbsUnits.has(unit);
  });
}
