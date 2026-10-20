/**
 * WB Finance API: детализация отчётов реализации.
 * Замена отключённого GET statistics-api …/reportDetailByPeriod (с 15.07.2026).
 *
 * POST https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed
 * Ответ нормализуем к snake_case v5, чтобы mapWbReportRow / extractWbFinanceAmounts
 * продолжали работать без правок по всей аналитике.
 */

const WB_FINANCE_DETAILED_URL =
  'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';

/** Лимит WB: 1 запрос/мин на метод. */
const PAGE_GAP_MS = 61_000;

/** camelCase (v1) → snake_case (v5 legacy), как в наших мапперах. */
const FIELD_MAP = {
  retailPrice: 'retail_price',
  retailAmount: 'retail_amount',
  retailPriceWithDisc: 'retail_price_withdisc_rub',
  deliveryService: 'delivery_rub',
  sellerPromo: 'supplier_promo',
  ppvzSalesCommission: 'ppvz_sales_commission',
  forPay: 'ppvz_for_pay',
  ppvzReward: 'ppvz_reward',
  acquiringFee: 'acquiring_fee',
  vw: 'ppvz_vw',
  vwNds: 'ppvz_vw_nds',
  penalty: 'penalty',
  additionalPayment: 'additional_payment',
  rebillLogisticCost: 'rebill_logistic_cost',
  paidStorage: 'storage_fee',
  deduction: 'deduction',
  paidAcceptance: 'acceptance',
  installmentCofinancingAmount: 'installment_cofinancing_amount',
  cashbackAmount: 'cashback_amount',
  cashbackDiscount: 'cashback_discount',
  cashbackCommissionChange: 'cashback_commission_change',
  paymentSchedule: 'payment_schedule',
  reportId: 'realizationreport_id',
  rrdId: 'rrd_id',
  giId: 'gi_id',
  nmId: 'nm_id',
  shkId: 'shk_id',
  orderId: 'assembly_id',
  vendorCode: 'sa_name',
  sku: 'barcode',
  techSize: 'ts_name',
  orderUid: 'order_uid',
  stickerId: 'sticker_id',
  trbxId: 'trbx_id',
  dateFrom: 'date_from',
  dateTo: 'date_to',
  createDate: 'create_dt',
  fixTariffDateFrom: 'fix_tariff_date_from',
  fixTariffDateTo: 'fix_tariff_date_to',
  orderDt: 'order_dt',
  saleDt: 'sale_dt',
  rrDate: 'rr_dt',
  salePercent: 'sale_percent',
  commissionPercent: 'commission_percent',
  dlvPrc: 'dlv_prc',
  productDiscountForReport: 'product_discount_for_report',
  spp: 'ppvz_spp_prc',
  kvwBase: 'ppvz_kvw_prc_base',
  kvw: 'ppvz_kvw_prc',
  supRatingUp: 'sup_rating_prc_up',
  isKgvpV2: 'is_kgvp_v2',
  acquiringPercent: 'acquiring_percent',
  wibesDiscountPercent: 'wibes_wb_discount_percent',
  sellerPromoDiscount: 'seller_promo_discount',
  loyaltyDiscount: 'loyalty_discount',
  currency: 'currency_name',
  subjectName: 'subject_name',
  brandName: 'brand_name',
  docTypeName: 'doc_type_name',
  officeName: 'office_name',
  sellerOperName: 'supplier_oper_name',
  ppvzOfficeName: 'ppvz_office_name',
  ppvzSupplierName: 'ppvz_supplier_name',
  ppvzSupplierInn: 'ppvz_inn',
  acquiringBank: 'acquiring_bank',
  paymentProcessing: 'payment_processing',
  declarationNumber: 'declaration_number',
  bonusTypeName: 'bonus_type_name',
  country: 'site_country',
  deliveryMethod: 'delivery_method',
  rebillLogisticOrg: 'rebill_logistic_org',
  giBoxTypeName: 'gi_box_type_name',
  srvDbs: 'srv_dbs',
  isB2b: 'is_legal_entity',
  reportType: 'report_type',
  quantity: 'quantity',
  deliveryAmount: 'delivery_amount',
  returnAmount: 'return_amount',
  ppvzOfficeId: 'ppvz_office_id',
  srid: 'srid',
  rid: 'rid',
  title: 'title',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMoneyMaybe(v) {
  if (v == null || v === '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : v;
}

/**
 * Строка v1 (camelCase, деньги-string) → формат v5 (snake_case, числа),
 * плюс исходные ключи на случай уже смешанного ответа.
 */
export function normalizeWbSalesReportRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };

  for (const [camel, snake] of Object.entries(FIELD_MAP)) {
    if (out[camel] === undefined) continue;
    if (out[snake] === undefined || out[snake] === null || out[snake] === '') {
      out[snake] = out[camel];
    }
  }

  // Денежные / числовые поля, которыми оперирует extractWbFinanceAmounts
  const moneyKeys = [
    'retail_price',
    'retail_amount',
    'retail_price_withdisc_rub',
    'delivery_rub',
    'ppvz_sales_commission',
    'ppvz_for_pay',
    'ppvz_reward',
    'acquiring_fee',
    'penalty',
    'additional_payment',
    'rebill_logistic_cost',
    'storage_fee',
    'deduction',
    'acceptance',
    'commission_percent',
    'quantity',
  ];
  for (const k of moneyKeys) {
    if (out[k] != null) out[k] = parseMoneyMaybe(out[k]);
  }

  // Новое поле title → имя товара, если subject пустой
  if (out.title && !out.subject_name) {
    out.subject_name = String(out.title);
  }

  return out;
}

function extractRowsPayload(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.rows)) return json.rows;
  if (Array.isArray(json.report)) return json.report;
  if (Array.isArray(json.details)) return json.details;
  return [];
}

async function postDetailedPage({ token, dateFrom, dateTo, rrdId, limit, period }) {
  const body = {
    dateFrom,
    dateTo,
    period,
    rrdId: rrdId == null ? 0 : rrdId,
    limit,
  };

  const response = await fetch(WB_FINANCE_DETAILED_URL, {
    method: 'POST',
    headers: {
      Authorization: token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

/**
 * Загрузка детализации за период (с пагинацией по rrdId).
 * @returns {Promise<object[]>} строки в legacy snake_case
 */
export async function fetchWbSalesReportsDetailed(apiKey, dateFrom, dateTo, opts = {}) {
  const token = String(apiKey || '').trim();
  if (!token) throw new Error('Не настроен API-ключ Wildberries');

  const from = String(dateFrom || '').slice(0, 10);
  const to = String(dateTo || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('WB sales-reports/detailed: некорректный период');
  }

  const limit = Math.min(Math.max(Number(opts.limit) || 100000, 1), 100000);
  const maxPages = Math.min(Math.max(Number(opts.maxPages) || 50, 1), 100);
  let period = opts.period === 'weekly' ? 'weekly' : 'daily';

  const allRows = [];
  let rrdId = 0;

  for (let page = 0; page < maxPages; page += 1) {
    if (page > 0) await sleep(PAGE_GAP_MS);

    let attempt = await postDetailedPage({
      token,
      dateFrom: from,
      dateTo: to,
      rrdId,
      limit,
      period,
    });

    // На первом запросе: если daily отвергнут — пробуем weekly
    if (
      page === 0 &&
      !attempt.ok &&
      period === 'daily' &&
      (attempt.status === 400 || attempt.status === 422)
    ) {
      const msg = String(attempt.text || '').toLowerCase();
      if (msg.includes('period') || msg.includes('daily') || msg.includes('weekly')) {
        period = 'weekly';
        attempt = await postDetailedPage({
          token,
          dateFrom: from,
          dateTo: to,
          rrdId,
          limit,
          period,
        });
      }
    }

    // 429 — подождать и повторить ту же страницу
    if (!attempt.ok && attempt.status === 429) {
      await sleep(PAGE_GAP_MS);
      attempt = await postDetailedPage({
        token,
        dateFrom: from,
        dateTo: to,
        rrdId,
        limit,
        period,
      });
    }

    if (!attempt.ok) {
      const snippet = String(attempt.text || '').slice(0, 400);
      throw new Error(`WB sales-reports/detailed: ${attempt.status} ${snippet}`);
    }

    const chunkRaw = extractRowsPayload(attempt.json);
    if (!chunkRaw.length) break;

    const chunk = chunkRaw.map(normalizeWbSalesReportRow);
    allRows.push(...chunk);

    const last = chunk[chunk.length - 1];
    const nextRrdId = last?.rrd_id ?? last?.rrdId ?? null;
    if (nextRrdId == null || nextRrdId === rrdId || chunk.length < limit) break;
    rrdId = nextRrdId;
  }

  return allRows;
}

export { WB_FINANCE_DETAILED_URL, FIELD_MAP };
