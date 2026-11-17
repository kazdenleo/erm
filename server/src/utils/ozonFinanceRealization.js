/**
 * Отчёт о реализации Ozon — тот же документ, что в ЛК
 * «Финансы → Документы → Отчёты о реализации» и что грузит 1С в «Отчёт о продажах».
 *
 * POST /v2/finance/realization { month, year }
 * Выручка строки = delivery_commission.amount («Реализовано на сумму»).
 * Не путать с /v1/finance/accrual/by-day (seller_price), из‑за которого ОПиУ раздувал продажи.
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function monthsOverlappingRange(dateFrom, dateTo) {
  const from = String(dateFrom || '').slice(0, 10);
  const to = String(dateTo || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    return [];
  }
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  for (let guard = 0; guard < 36; guard += 1) {
    out.push({ year: y, month: m });
    if (y === endY && m === endM) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function lastDayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month, 0));
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * @param {object} row — строка result.rows[]
 * @param {{ year: number, month: number }} period
 * @returns {object[]} operation-like (sale и/или return)
 */
export function mapRealizationRowToOperations(row, period) {
  if (!row || typeof row !== 'object') return [];
  const item = row.item && typeof row.item === 'object' ? row.item : {};
  const offerId = item.offer_id != null ? String(item.offer_id).trim() : '';
  const sku = item.sku != null ? String(item.sku).trim() : '';
  const name = item.name != null ? String(item.name).trim() : '';
  const barcode = item.barcode != null ? String(item.barcode).trim() : '';
  const opDate = lastDayOfMonth(period.year, period.month);
  const out = [];

  const del = row.delivery_commission && typeof row.delivery_commission === 'object' ? row.delivery_commission : null;
  if (del) {
    const qty = Math.max(0, Math.trunc(toNum(del.quantity)));
    const amount = toNum(del.amount);
    const commission = Math.abs(toNum(del.commission));
    const total = toNum(del.total);
    if (qty > 0 || amount !== 0 || commission !== 0 || total !== 0) {
      out.push({
        operation_id: `ozon-realization-${period.year}-${period.month}-d-${row.rowNumber ?? row.row_number ?? (offerId || sku)}`,
        operation_type: 'OperationAgentDeliveredToCustomer',
        operation_type_name: 'Продажа (отчёт о реализации)',
        operation_date: opDate,
        amount: total !== 0 ? total : amount - commission,
        accruals_for_sale: amount,
        sale_commission: commission > 0 ? -commission : 0,
        delivery_charge: 0,
        return_delivery_charge: 0,
        services: [],
        items: [{ sku: offerId || sku || null, name: name || null, quantity: qty || 1 }],
        posting: {
          posting_number: null,
          delivery_schema: null,
          order_date: null,
          order_id: null,
          warehouse_id: null,
        },
        type: 'orders',
        accrued_category: 'REALIZATION',
        realization_source: true,
        barcode: barcode || null,
      });
    }
  }

  const ret = row.return_commission && typeof row.return_commission === 'object' ? row.return_commission : null;
  if (ret) {
    const qty = Math.max(0, Math.trunc(toNum(ret.quantity)));
    const amount = toNum(ret.amount);
    const commission = Math.abs(toNum(ret.commission));
    const total = toNum(ret.total);
    if (qty > 0 || amount !== 0 || commission !== 0 || total !== 0) {
      // В отчёте amount по возврату обычно положительный «возвращено на сумму».
      const returnAmount = Math.abs(amount);
      out.push({
        operation_id: `ozon-realization-${period.year}-${period.month}-r-${row.rowNumber ?? row.row_number ?? (offerId || sku)}`,
        operation_type: 'OperationAgentStornoDeliveredToCustomer',
        operation_type_name: 'Возврат (отчёт о реализации)',
        operation_date: opDate,
        amount: total !== 0 ? total : -(returnAmount - commission),
        accruals_for_sale: -returnAmount,
        sale_commission: commission,
        delivery_charge: 0,
        return_delivery_charge: 0,
        services: [],
        items: [{ sku: offerId || sku || null, name: name || null, quantity: qty || 1 }],
        posting: {
          posting_number: null,
          delivery_schema: null,
          order_date: null,
          order_id: null,
          warehouse_id: null,
        },
        type: 'returns',
        accrued_category: 'REALIZATION',
        realization_source: true,
        barcode: barcode || null,
      });
    }
  }

  return out;
}

export function summarizeRealizationOperations(ops) {
  let sold = 0;
  let returned = 0;
  let commission = 0;
  let payout = 0;
  for (const op of ops || []) {
    const accruals = toNum(op.accruals_for_sale);
    const saleComm = Math.abs(toNum(op.sale_commission));
    payout += toNum(op.amount);
    if (op.operation_type === 'OperationAgentDeliveredToCustomer') {
      sold += Math.max(0, accruals);
      commission += saleComm;
    } else if (op.operation_type === 'OperationAgentStornoDeliveredToCustomer') {
      returned += Math.abs(accruals);
      commission -= saleComm;
    }
  }
  return {
    sold: Math.round(sold * 100) / 100,
    returned: Math.round(returned * 100) / 100,
    revenue: Math.round((sold - returned) * 100) / 100,
    commission: Math.round(commission * 100) / 100,
    payout: Math.round(payout * 100) / 100,
  };
}

/**
 * @returns {Promise<{ header: object|null, rows: object[], operations: object[], summary: object }>}
 */
export async function fetchOzonFinanceRealization({ clientId, apiKey, month, year }) {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isFinite(m) || m < 1 || m > 12 || !Number.isFinite(y) || y < 2000) {
    throw new Error('Ozon finance/realization: укажите month (1–12) и year');
  }
  if (!clientId || !apiKey) throw new Error('Не настроены Client-Id / Api-Key Ozon');

  const res = await fetch('https://api-seller.ozon.ru/v2/finance/realization', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Client-Id': String(clientId),
      'Api-Key': String(apiKey),
    },
    body: JSON.stringify({ month: m, year: y }),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`Ozon finance/realization ${y}-${String(m).padStart(2, '0')}: ${res.status} ${String(text).slice(0, 300)}`);
  }

  const result = json?.result ?? json ?? {};
  const header = result.header && typeof result.header === 'object' ? result.header : null;
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const period = { year: y, month: m };
  const operations = [];
  for (const row of rows) {
    operations.push(...mapRealizationRowToOperations(row, period));
  }
  return {
    header,
    rows,
    operations,
    summary: summarizeRealizationOperations(operations),
  };
}

/**
 * Отчёты о реализации за все месяцы, пересекающие [dateFrom, dateTo].
 */
export async function fetchOzonFinanceRealizationForRange({ clientId, apiKey, dateFrom, dateTo }) {
  const months = monthsOverlappingRange(dateFrom, dateTo);
  const allOps = [];
  const reports = [];
  for (const { year, month } of months) {
    const report = await fetchOzonFinanceRealization({ clientId, apiKey, month, year });
    reports.push({ year, month, header: report.header, summary: report.summary, rowCount: report.rows.length });
    allOps.push(...report.operations);
  }
  return {
    operations: allOps,
    reports,
    summary: summarizeRealizationOperations(allOps),
  };
}

/**
 * POSTING из accrual: обнуляем выручку, комиссию продажи, payout и услуги на отправлении.
 * Выручку/комиссию берём из отчёта о реализации; логистику доставки с POSTING
 * в 1С отражает «Отчёт о перевыставлении», а не services у POSTING (иначе ~×6 к логистике).
 * Отдельные операции возвратов/штрафов/материалов из by-day оставляем.
 */
export function stripPostingSaleRetailForRealization(op) {
  if (!op || typeof op !== 'object') return op;
  const cat = String(op.accrued_category || '').toUpperCase();
  const type = String(op.operation_type || '');
  const isPostingSale =
    cat === 'POSTING' ||
    type === 'OperationAgentDeliveredToCustomer' ||
    type === 'OperationAgentStornoDeliveredToCustomer';
  if (!isPostingSale) return op;
  if (op.realization_source) return op;
  return {
    ...op,
    accruals_for_sale: 0,
    sale_commission: 0,
    amount: 0,
    delivery_charge: 0,
    return_delivery_charge: 0,
    services: [],
  };
}

export { monthsOverlappingRange, lastDayOfMonth };
