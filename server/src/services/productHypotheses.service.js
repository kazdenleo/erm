/**
 * Гипотезы по товарам: CRUD + сравнение продаж/прибыли с предыдущим периодом той же длины.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import marketplaceCategoryAnalyticsService from './marketplaceCategoryAnalytics.service.js';
import { enrichAnalyticsRowWithTax, loadMarketplaceTaxContext } from '../utils/marketplaceOrderTax.js';

const MARKETPLACES = new Set(['all', 'ozon', 'wb', 'ym']);
const SCHEMES = new Set(['all', 'fbo', 'fbs']);
const STATUSES = new Set(['active', 'completed']);

function ymdFromPg(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function parseDateYmd(raw) {
  const s = String(raw || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days)));
  return dt.toISOString().slice(0, 10);
}

function periodLengthDays(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.round((b - a) / 86400000) + 1;
}

function minYmd(a, b) {
  return a <= b ? a : b;
}

function maxYmd(a, b) {
  return a >= b ? a : b;
}

function normalizeMarketplace(raw) {
  const v = String(raw || 'all').trim().toLowerCase();
  if (v === 'wildberries') return 'wb';
  if (v === 'yandex' || v === 'yandexmarket') return 'ym';
  return MARKETPLACES.has(v) ? v : 'all';
}

function normalizeScheme(raw) {
  const v = String(raw || 'all').trim().toLowerCase();
  return SCHEMES.has(v) ? v : 'all';
}

function normalizeStatus(raw) {
  const v = String(raw || 'active').trim().toLowerCase();
  return STATUSES.has(v) ? v : 'active';
}

function requireProfile(profileId) {
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
  return pid;
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function emptyEconomics() {
  return {
    soldQty: 0,
    soldAmount: 0,
    commissionAmount: 0,
    logisticsAmount: 0,
    storageAmount: 0,
    penaltyAmount: 0,
    acquiringAmount: 0,
    otherDeductions: 0,
    payoutAmount: 0,
    costAmount: 0,
    additionalExpensesAmount: 0,
    expensesTotal: 0,
    netIncome: 0,
  };
}

function addEconomics(acc, row) {
  acc.soldQty += Number(row.soldQty) || 0;
  acc.soldAmount += Number(row.soldAmount) || 0;
  acc.commissionAmount += Number(row.commissionAmount) || 0;
  acc.logisticsAmount += Number(row.logisticsAmount) || 0;
  acc.storageAmount += Number(row.storageAmount) || 0;
  acc.penaltyAmount += Number(row.penaltyAmount) || 0;
  acc.acquiringAmount += Number(row.acquiringAmount) || 0;
  acc.otherDeductions += Number(row.otherDeductions) || 0;
  acc.payoutAmount += Number(row.payoutAmount) || 0;
  acc.costAmount += Number(row.costAmount) || 0;
  acc.additionalExpensesAmount += Number(row.additionalExpensesAmount) || 0;
}

function finalizeEconomics(acc, taxContext, productId) {
  acc.expensesTotal =
    acc.commissionAmount +
    acc.logisticsAmount +
    acc.storageAmount +
    acc.penaltyAmount +
    acc.acquiringAmount +
    acc.otherDeductions;
  const taxed = enrichAnalyticsRowWithTax({ ...acc, productId }, taxContext);
  return {
    soldQty: acc.soldQty,
    soldAmount: acc.soldAmount,
    netIncome: Number(taxed.netIncome) || 0,
  };
}

function deltaPct(curr, prev) {
  const c = Number(curr) || 0;
  const p = Number(prev) || 0;
  if (p === 0) return c === 0 ? 0 : null;
  return (c - p) / Math.abs(p);
}

function comparisonWindows(dateFrom, dateTo, today) {
  const plannedDays = periodLengthDays(dateFrom, dateTo);
  const effectiveTo = minYmd(dateTo, today);
  if (effectiveTo < dateFrom) {
    return {
      plannedDays,
      elapsedDays: 0,
      incomplete: true,
      current: { dateFrom, dateTo: dateFrom },
      previous: { dateFrom, dateTo: dateFrom },
    };
  }
  const elapsedDays = periodLengthDays(dateFrom, effectiveTo);
  const prevTo = shiftDaysYmd(dateFrom, -1);
  const prevFrom = shiftDaysYmd(prevTo, -(elapsedDays - 1));
  return {
    plannedDays,
    elapsedDays,
    incomplete: effectiveTo < dateTo,
    current: { dateFrom, dateTo: effectiveTo },
    previous: { dateFrom: prevFrom, dateTo: prevTo },
  };
}

function rowMatchesHypothesis(row, hyp) {
  if (Number(row.productId) !== Number(hyp.product_id)) return false;
  if (hyp.marketplace && hyp.marketplace !== 'all' && row.marketplace !== hyp.marketplace) return false;
  if (hyp.scheme && hyp.scheme !== 'all' && row.scheme !== hyp.scheme) return false;
  return true;
}

function inDateRange(ymd, from, to) {
  return ymd >= from && ymd <= to;
}

function mapHypothesisRow(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    productName: row.product_name || '',
    productSku: row.product_sku || '',
    title: row.title || '',
    description: row.description || '',
    dateFrom: ymdFromPg(row.date_from),
    dateTo: ymdFromPg(row.date_to),
    marketplace: row.marketplace || 'all',
    scheme: row.scheme || 'all',
    status: row.status || 'active',
    conclusion: row.conclusion || '',
    createdById: row.created_by_id != null ? Number(row.created_by_id) : null,
    createdByName: row.created_by_full_name || row.created_by_email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_SQL = `
  SELECT
    h.*,
    p.name AS product_name,
    p.sku AS product_sku,
    u.full_name AS created_by_full_name,
    u.email AS created_by_email
  FROM product_hypotheses h
  INNER JOIN products p ON p.id = h.product_id
  LEFT JOIN users u ON u.id = h.created_by_id
`;

async function findById(id, profileId) {
  const res = await query(`${SELECT_SQL} WHERE h.id = $1 AND h.profile_id = $2`, [id, profileId]);
  return res.rows?.[0] || null;
}

async function assertProduct(productId, profileId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) {
    throw httpError('Укажите товар', 400);
  }
  const res = await query(
    `SELECT id, name, sku FROM products WHERE id = $1 AND profile_id = $2`,
    [pid, profileId]
  );
  const product = res.rows?.[0];
  if (!product) {
    throw httpError('Товар не найден', 404);
  }
  return product;
}

function parseBody(body = {}) {
  const title = String(body.title || '').trim();
  if (!title) throw httpError('Укажите формулировку гипотезы', 400);
  if (title.length > 500) throw httpError('Формулировка слишком длинная', 400);

  const dateFrom = parseDateYmd(body.dateFrom ?? body.date_from);
  const dateTo = parseDateYmd(body.dateTo ?? body.date_to);
  if (!dateFrom || !dateTo) throw httpError('Укажите период гипотезы', 400);
  if (dateTo < dateFrom) throw httpError('Дата окончания не может быть раньше начала', 400);

  return {
    productId: body.productId ?? body.product_id,
    title,
    description: String(body.description || '').trim() || null,
    dateFrom,
    dateTo,
    marketplace: normalizeMarketplace(body.marketplace),
    scheme: normalizeScheme(body.scheme),
    status: normalizeStatus(body.status),
    conclusion: String(body.conclusion || '').trim() || null,
  };
}

async function attachComparisons(profileId, rows) {
  const items = (rows || []).map(mapHypothesisRow);
  if (!items.length) return items;

  const today = todayYmd();
  const windows = items.map((h) => comparisonWindows(h.dateFrom, h.dateTo, today));
  let rangeFrom = windows[0].previous.dateFrom;
  let rangeTo = windows[0].current.dateTo;
  for (const w of windows) {
    rangeFrom = minYmd(rangeFrom, w.previous.dateFrom);
    rangeTo = maxYmd(rangeTo, w.current.dateTo);
    rangeTo = maxYmd(rangeTo, w.previous.dateTo);
  }

  const productIds = [...new Set(items.map((h) => h.productId))];
  const [dayRows, taxContext] = await Promise.all([
    marketplaceCategoryAnalyticsService.getProductDayEconomics({
      profileId,
      productIds,
      dateFrom: rangeFrom,
      dateTo: rangeTo,
    }),
    loadMarketplaceTaxContext(profileId),
  ]);

  return items.map((item, idx) => {
    const w = windows[idx];
    const currentAcc = emptyEconomics();
    const previousAcc = emptyEconomics();
    const hypRow = {
      product_id: item.productId,
      marketplace: item.marketplace,
      scheme: item.scheme,
    };
    for (const row of dayRows) {
      if (!rowMatchesHypothesis(row, hypRow)) continue;
      if (inDateRange(row.operationDate, w.current.dateFrom, w.current.dateTo)) {
        addEconomics(currentAcc, row);
      } else if (inDateRange(row.operationDate, w.previous.dateFrom, w.previous.dateTo)) {
        addEconomics(previousAcc, row);
      }
    }
    const current = {
      ...w.current,
      ...finalizeEconomics(currentAcc, taxContext, item.productId),
    };
    const previous = {
      ...w.previous,
      ...finalizeEconomics(previousAcc, taxContext, item.productId),
    };
    return {
      ...item,
      comparison: {
        plannedDays: w.plannedDays,
        elapsedDays: w.elapsedDays,
        incomplete: w.incomplete,
        current,
        previous,
        soldQtyDelta: current.soldQty - previous.soldQty,
        soldQtyDeltaPct: deltaPct(current.soldQty, previous.soldQty),
        soldAmountDelta: current.soldAmount - previous.soldAmount,
        soldAmountDeltaPct: deltaPct(current.soldAmount, previous.soldAmount),
        netIncomeDelta: current.netIncome - previous.netIncome,
        netIncomeDeltaPct: deltaPct(current.netIncome, previous.netIncome),
      },
    };
  });
}

class ProductHypothesesService {
  async list({ profileId, status = null, productId = null } = {}) {
    const pid = requireProfile(profileId);
    const params = [pid];
    const where = ['h.profile_id = $1'];
    if (status && STATUSES.has(String(status))) {
      params.push(status);
      where.push(`h.status = $${params.length}`);
    }
    const prod = Number(productId);
    if (Number.isFinite(prod) && prod > 0) {
      params.push(prod);
      where.push(`h.product_id = $${params.length}`);
    }
    const res = await query(
      `${SELECT_SQL}
       WHERE ${where.join(' AND ')}
       ORDER BY h.date_from DESC, h.id DESC`,
      params
    );
    const items = await attachComparisons(pid, res.rows || []);
    const activeCount = items.filter((h) => h.status === 'active').length;
    const completedCount = items.filter((h) => h.status === 'completed').length;
    const withSalesUp = items.filter((h) => (h.comparison?.soldQtyDelta || 0) > 0).length;
    const withProfitUp = items.filter((h) => (h.comparison?.netIncomeDelta || 0) > 0).length;
    return {
      items,
      summary: {
        total: items.length,
        activeCount,
        completedCount,
        withSalesUp,
        withProfitUp,
      },
    };
  }

  async create({ profileId, createdById, body }) {
    const pid = requireProfile(profileId);
    const parsed = parseBody(body);
    await assertProduct(parsed.productId, pid);
    const res = await query(
      `INSERT INTO product_hypotheses (
         profile_id, product_id, title, description,
         date_from, date_to, marketplace, scheme, status, conclusion, created_by_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        pid,
        Number(parsed.productId),
        parsed.title,
        parsed.description,
        parsed.dateFrom,
        parsed.dateTo,
        parsed.marketplace,
        parsed.scheme,
        parsed.status,
        parsed.conclusion,
        createdById != null ? Number(createdById) : null,
      ]
    );
    const created = await findById(res.rows[0].id, pid);
    const [item] = await attachComparisons(pid, [created]);
    return item;
  }

  async update({ profileId, id, body }) {
    const pid = requireProfile(profileId);
    const hid = Number(id);
    if (!Number.isFinite(hid) || hid < 1) throw httpError('Гипотеза не найдена', 404);
    const existing = await findById(hid, pid);
    if (!existing) throw httpError('Гипотеза не найдена', 404);

    const parsed = parseBody({
      productId: body.productId ?? body.product_id ?? existing.product_id,
      title: body.title ?? existing.title,
      description: body.description !== undefined ? body.description : existing.description,
      dateFrom: body.dateFrom ?? body.date_from ?? existing.date_from,
      dateTo: body.dateTo ?? body.date_to ?? existing.date_to,
      marketplace: body.marketplace ?? existing.marketplace,
      scheme: body.scheme ?? existing.scheme,
      status: body.status ?? existing.status,
      conclusion: body.conclusion !== undefined ? body.conclusion : existing.conclusion,
    });
    await assertProduct(parsed.productId, pid);

    await query(
      `UPDATE product_hypotheses SET
         product_id = $2,
         title = $3,
         description = $4,
         date_from = $5,
         date_to = $6,
         marketplace = $7,
         scheme = $8,
         status = $9,
         conclusion = $10,
         updated_at = NOW()
       WHERE id = $1 AND profile_id = $11`,
      [
        hid,
        Number(parsed.productId),
        parsed.title,
        parsed.description,
        parsed.dateFrom,
        parsed.dateTo,
        parsed.marketplace,
        parsed.scheme,
        parsed.status,
        parsed.conclusion,
        pid,
      ]
    );
    const updated = await findById(hid, pid);
    const [item] = await attachComparisons(pid, [updated]);
    return item;
  }

  async remove({ profileId, id }) {
    const pid = requireProfile(profileId);
    const hid = Number(id);
    if (!Number.isFinite(hid) || hid < 1) throw httpError('Гипотеза не найдена', 404);
    const res = await query(
      `DELETE FROM product_hypotheses WHERE id = $1 AND profile_id = $2 RETURNING id`,
      [hid, pid]
    );
    if (!res.rowCount) throw httpError('Гипотеза не найдена', 404);
    return { id: hid };
  }
}

export default new ProductHypothesesService();
