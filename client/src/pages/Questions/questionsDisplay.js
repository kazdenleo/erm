/**
 * В колонке «тема» показываем только артикул (SKU / offer / хвост из subject).
 */

function truncate(s, n) {
  const t = s == null ? '' : String(s);
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

function pickString(...values) {
  for (const v of values) {
    const s = v != null ? String(v).trim() : '';
    if (s) return s;
  }
  return null;
}

function isSellerAuthorType(type) {
  const t = String(type ?? '').toUpperCase();
  if (!t) return false;
  return (
    t.includes('SELLER') ||
    t.includes('SHOP') ||
    t.includes('PARTNER') ||
    t.includes('BUSINESS') ||
    t.includes('MERCHANT')
  );
}

function authorBuyerName(author) {
  if (!author || typeof author !== 'object' || isSellerAuthorType(author.type ?? author.author_type)) {
    return null;
  }
  return pickString(author.name, author.fullName, author.full_name, author.nickname);
}

/**
 * Имя покупателя из API-поля или raw_payload (fallback для Яндекса/Ozon).
 * @param {object|null|undefined} q
 */
export function extractBuyerName(q) {
  const direct = pickString(q?.buyerName, q?.customerName);
  if (direct) return direct;

  const raw = q?.rawPayload ?? q?.raw_payload;
  if (!raw || typeof raw !== 'object') return null;

  return pickString(
    authorBuyerName(raw.author),
    authorBuyerName(raw.questionAuthor),
    authorBuyerName(raw.question_author),
    authorBuyerName(raw.user),
    authorBuyerName(raw.buyer),
    authorBuyerName(raw.customer),
    authorBuyerName(raw.client),
    raw.userName,
    raw.user_name,
    raw.customerName,
    raw.customer_name,
    raw.buyerName,
    raw.buyer_name,
    raw.nickname
  );
}

function wbSupplierArticleFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const pd = raw.productDetails ?? raw.product_details ?? {};
  const candidates = [
    pd.supplierArticle,
    pd.supplier_article,
    pd.vendorCode,
    pd.vendor_code,
    pd.article,
    raw.vendorCode,
    raw.vendor_code,
  ];
  for (const v of candidates) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function pickOfferSku(q) {
  const mp = String(q.marketplace || '').toLowerCase();
  const raw = q.rawPayload ?? q.raw_payload;
  if (mp === 'wildberries') {
    const fromApi = wbSupplierArticleFromRaw(raw);
    if (fromApi) return fromApi;
  }
  const direct = q.skuOrOffer ?? q.sku_or_offer;
  if (direct != null && String(direct).trim() !== '') return String(direct).trim();
  if (mp !== 'yandex') return '';
  if (!raw || typeof raw !== 'object') return '';
  const qi = raw.questionIdentifiers ?? raw.QuestionIdentifiers ?? raw.question_identifiers ?? {};
  const id =
    qi.offerId ??
    qi.offer_id ??
    qi.shopSku ??
    qi.shop_sku ??
    qi.marketSku ??
    raw.marketSku;
  if (id != null && String(id).trim() !== '') return String(id).trim();
  return '';
}

/** Только артикул: колонка БД, иначе последний сегмент после « · » в subject (старые строки). */
function extractArticleOnly(q) {
  const sku = pickOfferSku(q);
  if (sku) return sku;
  let subj = q.subject != null && String(q.subject).trim() !== '' ? String(q.subject).trim() : '';
  if (!subj) return '';
  subj = subj.replace(/^Арт\.\s*/i, '').trim();
  if (subj.includes(' · ')) {
    const tail = subj.split(' · ').pop().trim();
    if (tail) return tail;
  }
  return subj;
}

/**
 * @param {{ subject?: string|null, skuOrOffer?: string|null, sku_or_offer?: string|null, marketplace?: string|null, rawPayload?: object|null, raw_payload?: object|null }} q
 * @param {number} [maxLen]
 */
export function formatProductTheme(q, maxLen = 48) {
  const art = extractArticleOnly(q);
  if (!art) return '—';
  return truncate(art, maxLen);
}
