/**
 * Ozon Finance: загрузка начислений через /v1/finance/accrual/*
 * (замена отключённого /v3/finance/transaction/list).
 *
 * Нормализуем ответ к «плоским» operation-объектам старого API,
 * чтобы mapOzonTransactionRow / extractOzonFinanceAmounts продолжали работать.
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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
    (Array.isArray(root) && root) ||
    (Array.isArray(root.types) && root.types) ||
    (Array.isArray(root.accruals) && root.accruals) ||
    (Array.isArray(json?.types) && json.types) ||
    [];
  const map = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id ?? item.accrual_id ?? item.type_id;
    const code = String(item.code || item.operation_type || item.accrued_category || id || '').trim();
    const name = String(item.name || item.title || item.operation_type_name || code).trim();
    const rec = { id, code, name };
    if (id != null) map.set(String(id), rec);
    if (code) map.set(code, rec);
  }
  return map;
}

function resolveType(typesMap, accrual) {
  const id = accrual?.accrual_id ?? accrual?.type_id ?? accrual?.id;
  const code = accrual?.operation_type || accrual?.accrued_category || accrual?.code;
  const hit =
    (id != null && typesMap.get(String(id))) ||
    (code && typesMap.get(String(code))) ||
    null;
  return {
    operation_type: hit?.code || code || (id != null ? String(id) : null),
    operation_type_name: hit?.name || accrual?.operation_type_name || accrual?.name || null,
  };
}

function pickProducts(src) {
  if (Array.isArray(src?.products) && src.products.length) return src.products;
  if (Array.isArray(src?.items) && src.items.length) return src.items;
  if (Array.isArray(src?.posting?.products) && src.posting.products.length) return src.posting.products;
  return [];
}

function pickServices(src) {
  if (Array.isArray(src?.services) && src.services.length) return src.services;
  const nested = src?.delivery?.services || src?.posting?.products?.[0]?.delivery?.services;
  if (Array.isArray(nested) && nested.length) {
    return nested.map((s) =>
      s && typeof s === 'object'
        ? { name: s.name || s.service_name || s.code, price: s.price ?? s.amount }
        : s
    );
  }
  if (Array.isArray(src?.container_fees) && src.container_fees.length) {
    return src.container_fees.map((s) => ({
      name: s?.name || 'CONTAINER_FEES',
      price: s?.price ?? s?.amount,
    }));
  }
  return [];
}

function productToItem(p) {
  if (!p || typeof p !== 'object') return { sku: null, name: null, quantity: 1 };
  return {
    sku: p.sku ?? p.offer_id ?? p.product_id ?? null,
    name: p.name ?? p.product_name ?? null,
    quantity: toNum(p.quantity) || 1,
  };
}

/** Одна запись by-day / postings → operation-like. */
export function normalizeAccrualToOperation(accrual, typesMap = new Map(), fallbackDate = null) {
  if (!accrual || typeof accrual !== 'object') return null;
  const posting = accrual.posting && typeof accrual.posting === 'object' ? accrual.posting : accrual;
  const type = resolveType(typesMap, accrual);
  const products = pickProducts(accrual).map(productToItem);
  const amount =
    accrual.amount != null
      ? toNum(accrual.amount)
      : accrual.accrual_amount != null
        ? toNum(accrual.accrual_amount)
        : toNum(accrual.total);

  return {
    operation_id: accrual.operation_id ?? accrual.accrual_id ?? accrual.id ?? null,
    operation_type: type.operation_type,
    operation_type_name: type.operation_type_name,
    operation_date:
      accrual.operation_date ||
      accrual.date ||
      posting.order_date ||
      posting.accrual_date ||
      fallbackDate,
    amount,
    accruals_for_sale: toNum(accrual.accruals_for_sale ?? accrual.sale_amount ?? accrual.revenue),
    sale_commission: toNum(accrual.sale_commission ?? accrual.commission),
    delivery_charge: toNum(accrual.delivery_charge),
    return_delivery_charge: toNum(accrual.return_delivery_charge),
    services: pickServices(accrual),
    items: products.length ? products : [{ sku: accrual.sku ?? null, name: accrual.name ?? null, quantity: 1 }],
    posting: {
      posting_number: posting.posting_number ?? accrual.posting_number ?? null,
      delivery_schema: posting.delivery_schema ?? accrual.delivery_schema ?? null,
      order_date: posting.order_date ?? null,
      order_id: posting.order_id ?? accrual.order_id ?? null,
      warehouse_id: posting.warehouse_id ?? null,
    },
    type: accrual.type ?? accrual.accrued_category ?? null,
    accrued_category: accrual.accrued_category ?? null,
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
            },
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

async function fetchAccrualsByPostings({ clientId, apiKey, dateFrom, dateTo, typesMap }) {
  const all = [];
  let page = 1;
  const pageSize = 500;
  const fromIso = `${ymd(dateFrom)}T00:00:00.000Z`;
  const toIso = `${ymd(dateTo)}T23:59:59.999Z`;
  const bodyFactories = [
    (p) => ({ page: p, page_size: pageSize, date: { from: fromIso, to: toIso } }),
    (p) => ({ page: p, page_size: pageSize, filter: { date: { from: fromIso, to: toIso } } }),
    (p) => ({
      page: p,
      page_size: pageSize,
      filter: { date: { from: fromIso, to: toIso }, posting_number: '' },
    }),
  ];
  let chosenFactory = null;

  for (let guard = 0; guard < 200; guard += 1) {
    let lastErr = null;
    let list = [];
    let okPage = false;
    const factories = chosenFactory ? [chosenFactory] : bodyFactories;

    for (const makeBody of factories) {
      const { ok, status, json, text } = await ozonPostJson({
        clientId,
        apiKey,
        path: '/v1/finance/accrual/postings',
        body: makeBody(page),
      });
      if (ok) {
        ({ list } = extractAccrualList(json));
        chosenFactory = makeBody;
        okPage = true;
        break;
      }
      lastErr = new Error(`Ozon finance/accrual/postings: ${status} ${String(text).slice(0, 300)}`);
      lastErr.status = status;
      if (status !== 400 && status !== 422) break;
    }

    if (!okPage) throw lastErr || new Error('Ozon finance/accrual/postings: unknown error');

    for (const row of list) {
      all.push(...expandPostingOrAccrual(row, typesMap, null));
    }
    if (list.length < pageSize) break;
    page += 1;
  }
  return all;
}

/**
 * Загрузить начисления за период и вернуть operation-like массив (как у v3/transaction/list).
 * Сначала postings (удобнее для диапазона), при 404/400 — by-day по дням.
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

  try {
    return await fetchAccrualsByPostings({
      clientId: cid,
      apiKey: key,
      dateFrom,
      dateTo,
      typesMap,
    });
  } catch (err) {
    const st = err?.status;
    if (st === 404 || st === 400 || st === 405 || st === 501) {
      return fetchAccrualsByDay({
        clientId: cid,
        apiKey: key,
        dateFrom,
        dateTo,
        typesMap,
      });
    }
    // Сеть / 5xx — тоже пробуем by-day как запасной контур.
    if (st >= 500 || st == null) {
      try {
        return await fetchAccrualsByDay({
          clientId: cid,
          apiKey: key,
          dateFrom,
          dateTo,
          typesMap,
        });
      } catch {
        throw err;
      }
    }
    throw err;
  }
}
