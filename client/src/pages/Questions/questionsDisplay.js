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

/** Ozon: «Пользователь OZON» и т.п. — не имя покупателя. */
function isOzonGenericBuyerName(name) {
  const s = String(name ?? '').trim();
  if (!s) return true;
  const lower = s.toLowerCase().replace(/\s+/g, ' ');
  if (lower === 'пользователь ozon' || lower === 'пользователь озон') return true;
  if (lower.includes('пользователь') && (lower.includes('ozon') || lower.includes('озон'))) return true;
  if (lower.includes('скрыть') && lower.includes('данн')) return true;
  if (lower === 'покупатель' || lower === 'buyer' || lower === 'anonymous') return true;
  return false;
}

function sanitizeBuyerName(name, marketplace) {
  const s = pickString(name);
  if (!s) return null;
  const mp = String(marketplace || '').toLowerCase();
  if (mp === 'ozon' && isOzonGenericBuyerName(s)) return null;
  return s;
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
  const mp = String(q?.marketplace || '').toLowerCase();
  const direct = sanitizeBuyerName(pickString(q?.buyerName, q?.customerName), mp);
  if (direct) return direct;

  const raw = q?.rawPayload ?? q?.raw_payload;
  if (!raw || typeof raw !== 'object') return null;

  if (mp === 'ozon') {
    const ozon = sanitizeBuyerName(
      pickString(raw.author_name, raw.authorName, authorBuyerName(raw.author)),
      mp
    );
    if (ozon) return ozon;
  }
  if (mp === 'wildberries' || mp === 'wb') {
    const wb = pickString(raw.userName, raw.user_name, raw.clientName, raw.client_name);
    if (wb) return wb;
  }

  return sanitizeBuyerName(
    pickString(
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
    ),
    mp
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

function isOzonNumericMarketSku(value) {
  return /^\d{6,}$/.test(String(value ?? '').trim());
}

/** Артикул продавца из subject: «ART — Название» или «ART — Название · 123456». */
function ozonSellerArticleFromSubject(subject) {
  let subj = subject != null ? String(subject).trim() : '';
  if (!subj) return null;
  const dash = subj.match(/^([A-Za-z0-9][A-Za-z0-9._\-/]{2,})\s*[—–-]\s*.+$/);
  if (dash && !isOzonNumericMarketSku(dash[1])) return dash[1].trim();
  if (subj.includes(' · ')) {
    const head = subj.split(' · ')[0].trim();
    const tail = subj.split(' · ').pop().trim();
    if (isOzonNumericMarketSku(tail) && head) {
      const headDash = head.match(/^([A-Za-z0-9][A-Za-z0-9._\-/]{2,})\s*[—–-]\s*(.+)$/);
      if (headDash && !isOzonNumericMarketSku(headDash[1])) return headDash[1].trim();
    }
  }
  return null;
}

function ozonProductNameFromSubject(subject, sellerArticle) {
  let subj = subject != null ? String(subject).trim() : '';
  if (!subj) return null;
  const art = sellerArticle != null ? String(sellerArticle).trim() : '';
  const dash = subj.match(/^[A-Za-z0-9][A-Za-z0-9._\-/]{2,}\s*[—–-]\s*(.+)$/);
  if (dash) return dash[1].trim();
  if (subj.includes(' · ')) {
    const head = subj.split(' · ')[0].trim();
    const tail = subj.split(' · ').pop().trim();
    if (isOzonNumericMarketSku(tail) && head) {
      const headDash = head.match(/^[A-Za-z0-9][A-Za-z0-9._\-/]{2,}\s*[—–-]\s*(.+)$/);
      if (headDash) return headDash[2].trim();
      return stripArticlePrefix(art, head) || head;
    }
  }
  if (art && subj.toLowerCase() !== art.toLowerCase()) return stripArticlePrefix(art, subj) || subj;
  return subj;
}

function pickOfferSku(q) {
  const mp = String(q.marketplace || '').toLowerCase();
  const raw = q.rawPayload ?? q.raw_payload;
  if (mp === 'wildberries') {
    const fromApi = wbSupplierArticleFromRaw(raw);
    if (fromApi) return fromApi;
  }
  if (mp === 'ozon') {
    const direct = q.skuOrOffer ?? q.sku_or_offer;
    if (direct != null) {
      const d = String(direct).trim();
      if (d && !isOzonNumericMarketSku(d)) return d;
    }
    if (raw && typeof raw === 'object') {
      const offer = pickString(raw.offer_id, raw.offerId);
      if (offer) return offer;
    }
    const fromSubject = ozonSellerArticleFromSubject(q?.subject);
    if (fromSubject) return fromSubject;
    return '';
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

/** Артикул вопроса для сортировки и отображения в списке. */
export function getQuestionArticle(q) {
  return extractArticleOnly(q) || '';
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

function productNameFromRaw(q) {
  const raw = q?.rawPayload ?? q?.raw_payload;
  if (!raw || typeof raw !== 'object') return null;
  const mp = String(q?.marketplace || '').toLowerCase();
  const pd = raw.productDetails ?? raw.product_details ?? {};
  if (mp === 'wildberries' || mp === 'wb') {
    return pickString(pd.productName, pd.product_name, pd.name, raw.productName, raw.product_name);
  }
  if (mp === 'ozon') {
    const fromRaw = pickString(raw.product_name, raw.product_title, raw.productName, raw.name, raw.title);
    if (fromRaw) return fromRaw;
    const art = ozonSellerArticleFromSubject(q?.subject);
    return ozonProductNameFromSubject(q?.subject, art);
  }
  if (mp === 'yandex' || mp === 'ym') {
    return pickString(
      raw.modelName,
      raw.model_name,
      raw.shopSku,
      raw.shop_sku,
      raw.offer?.name,
      raw.offer?.title,
      raw.productName,
      raw.product_name,
      raw.title
    );
  }
  return pickString(raw.product_name, raw.product_title, raw.productName, raw.name, raw.title);
}

function parseSubjectNameAndArticle(q) {
  let subj = q?.subject != null && String(q.subject).trim() !== '' ? String(q.subject).trim() : '';
  subj = subj.replace(/^Арт\.\s*/i, '').trim();
  const mp = String(q?.marketplace || '').toLowerCase();
  if (mp === 'ozon') {
    const art = ozonSellerArticleFromSubject(subj) || pickOfferSku(q) || null;
    const name = ozonProductNameFromSubject(subj, art) || null;
    if (art || name) return { name, article: art };
  }
  const article = extractArticleOnly(q);
  if (subj.includes(' · ')) {
    const head = subj.split(' · ')[0].trim();
    const tail = subj.split(' · ').pop().trim();
    return {
      name: head || null,
      article: tail || article || null,
    };
  }
  if (article && subj && subj !== article) {
    return { name: subj, article };
  }
  return { name: subj || null, article: article || null };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Убрать артикул из начала названия («ART Название» → «Название»). */
function stripArticlePrefix(article, text) {
  const art = String(article || '').trim();
  let s = String(text || '').trim();
  if (!s) return '';
  if (!art) return s;
  if (s.toLowerCase() === art.toLowerCase()) return '';
  const patterns = [
    new RegExp(`^${escapeRegex(art)}\\s*[—–\\-·|:]\\s*`, 'i'),
    new RegExp(`^${escapeRegex(art)}\\s+`, 'i'),
  ];
  for (const re of patterns) {
    if (re.test(s)) return s.replace(re, '').trim();
  }
  return s;
}

/** Название без артикула в начале (для списка поиска). */
export function productNameWithoutArticle(article, name) {
  const stripped = stripArticlePrefix(article, name);
  if (stripped) return stripped;
  const raw = String(name || '').trim();
  const art = String(article || '').trim();
  if (raw && art && raw.toLowerCase() !== art.toLowerCase()) return raw;
  return '';
}

/**
 * «ART — Название» без дублирования артикула в названии.
 * @param {string|null|undefined} article
 * @param {string|null|undefined} name
 */
export function formatArticleWithProductName(article, name) {
  const art = String(article || '').trim();
  const rawName = String(name || '').trim();
  const cleanName = stripArticlePrefix(art, rawName);
  if (art && cleanName && cleanName.toLowerCase() !== art.toLowerCase()) {
    return `${art} — ${cleanName}`;
  }
  if (art) return art;
  if (cleanName) return cleanName;
  if (rawName) return rawName;
  return 'товар';
}

/**
 * Артикул и название товара с маркетплейса: «ART — Название».
 * @param {object|null|undefined} q
 */
export function formatProductArticleWithName(q) {
  const { name: fromSubject, article } = parseSubjectNameAndArticle(q);
  const name = pickString(fromSubject, productNameFromRaw(q));
  const art = article || extractArticleOnly(q);
  return formatArticleWithProductName(art, name);
}

/**
 * Артикул и название товара из вопроса (для окна ответа).
 * @param {object|null|undefined} q
 * @returns {{ article: string|null, name: string|null, line: string }}
 */
export function getQuestionProductInfo(q) {
  const { name: fromSubject, article } = parseSubjectNameAndArticle(q);
  const art = article || extractArticleOnly(q) || null;
  const rawName = pickString(fromSubject, productNameFromRaw(q));
  const name = rawName ? stripArticlePrefix(art, rawName) || null : null;
  const cleanName = name && art && name.toLowerCase() === art.toLowerCase() ? null : name;
  const line = formatArticleWithProductName(art, cleanName);
  if (!art && !cleanName && line && line !== 'товар') {
    return { article: null, name: line, line };
  }
  return {
    article: art,
    name: cleanName,
    line,
  };
}

/**
 * Строка «артикул — название» для шапки модалки (без заглушки «товар»).
 * @param {object|null|undefined} q
 */
export function questionModalProductLine(q) {
  const line = formatProductArticleWithName(q);
  if (line && line !== 'товар') return line;
  const subj = q?.subject != null ? String(q.subject).trim() : '';
  if (subj && !isOzonNumericMarketSku(subj)) return subj;
  const art = getQuestionArticle(q);
  if (art) return art;
  return 'Вопрос';
}

/** @param {string|null|undefined} marketplace */
export function normalizeQuestionMarketplace(marketplace) {
  const s = String(marketplace || '').toLowerCase();
  if (s === 'ozon') return 'ozon';
  if (s === 'wildberries' || s === 'wb') return 'wb';
  if (s === 'yandex' || s === 'ym') return 'ym';
  return s || null;
}

function pickNumericId(...values) {
  for (const v of values) {
    const s = v != null ? String(v).trim() : '';
    if (s && /^\d+$/.test(s)) return s;
  }
  return null;
}

/**
 * Числовой / строковый ID карточки на маркетплейсе из карточки ERP.
 * @param {object|null|undefined} product
 * @param {string|null|undefined} marketplace
 */
export function getProductMarketplaceNumber(product, marketplace) {
  if (!product) return null;
  const mp = normalizeQuestionMarketplace(marketplace);
  if (mp === 'ozon') {
    return pickNumericId(product.ozon_market_sku, product.ozon_sku);
  }
  if (mp === 'wb') {
    return pickNumericId(product.sku_wb, product.wb_nmid, product.nmId, product.nm_id);
  }
  if (mp === 'ym') {
    return pickNumericId(
      product.ym_market_sku,
      product.ym_product_id,
      product.marketplace_ym_product_id,
      product.marketSku,
      product.market_sku,
      product.sku_ym
    );
  }
  return null;
}

/**
 * ID карточки из payload вопроса (для «Из вопроса»).
 * @param {object|null|undefined} q
 */
export function extractQuestionMarketplaceProductId(q) {
  const mp = normalizeQuestionMarketplace(q?.marketplace);
  const raw = q?.rawPayload ?? q?.raw_payload;
  if (!raw || typeof raw !== 'object') return null;

  if (mp === 'ozon') {
    // product_id из вопроса Ozon ≠ номер карточки для покупателя (нужен sku из API).
    return null;
  }
  if (mp === 'wb') {
    const pd = raw.productDetails ?? raw.product_details ?? {};
    return pickNumericId(pd.nmId, pd.nmID, pd.nm_id);
  }
  if (mp === 'ym') {
    const qi = raw.questionIdentifiers ?? raw.QuestionIdentifiers ?? raw.question_identifiers ?? {};
    return pickNumericId(qi.marketSku, qi.market_sku, raw.marketSku, raw.market_sku);
  }
  return null;
}

/**
 * Товар из каталога для вставки в ответ: только номер карточки на МП (или ERP-артикул).
 * @param {object|null|undefined} product
 * @param {string|null|undefined} marketplace
 */
export function formatProductForQuestionReply(product, marketplace) {
  const erpSku = String(product?.sku || '').trim();
  const mpNumber = getProductMarketplaceNumber(product, marketplace);
  const article = mpNumber || erpSku;
  if (!article) {
    return product?.id != null ? `Товар #${product.id}` : 'товар';
  }
  return article;
}

/**
 * Товар из текущего вопроса для вставки в ответ: только номер карточки (или артикул).
 * @param {object|null|undefined} q
 */
export function formatQuestionProductForReply(q) {
  const mpNumber = extractQuestionMarketplaceProductId(q);
  const { article } = parseSubjectNameAndArticle(q);
  const erpArt = article || extractArticleOnly(q);
  const articleOut = mpNumber || erpArt;
  if (!articleOut) return 'товар';
  return articleOut;
}

/**
 * @param {object|null|undefined} q
 */
export function questionNeedsReply(q) {
  if (q?.needsReply === true) return true;
  if (q?.needsReply === false) return false;
  const tm = q?.threadMessages;
  if (Array.isArray(tm) && tm.length > 0) {
    return String(tm[tm.length - 1]?.role || '').toLowerCase() === 'buyer';
  }
  const t = q?.answerText;
  return t == null || String(t).trim() === '';
}
