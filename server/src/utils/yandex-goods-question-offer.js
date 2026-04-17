/**
 * Извлечение артикула (SKU / offerId) из объекта вопроса API goods-questions Яндекс.Маркета.
 * В документации offerId указан в questionIdentifiers; на практике встречаются варианты вложенности и имён.
 */

function norm(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function pickQi(o) {
  if (!o || typeof o !== 'object') return {};
  return o.questionIdentifiers ?? o.QuestionIdentifiers ?? o.question_identifiers ?? {};
}

/**
 * @param {unknown} payload — объект вопроса из API или JSONB из БД
 * @returns {string|null}
 */
export function extractYandexGoodsQuestionOfferId(payload) {
  if (payload == null) return null;
  let o = payload;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(o)) {
    try {
      o = JSON.parse(o.toString('utf8'));
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object') return null;

  const qi = pickQi(o);
  const flat = [
    norm(qi.offerId),
    norm(qi.offer_id),
    norm(qi.shopSku),
    norm(qi.shop_sku),
    norm(o.offerId),
    norm(o.offer_id),
    norm(o.shopSku),
    norm(o.shop_sku),
    norm(qi.marketSku),
    norm(o.marketSku),
  ];
  const hit = flat.find(Boolean);
  if (hit) return hit;

  const nested = o.offer ?? o.product ?? o.goods ?? o.item;
  if (nested && typeof nested === 'object') {
    const sub = [
      norm(nested.offerId),
      norm(nested.id),
      norm(nested.shopSku),
      norm(nested.shop_sku),
    ];
    const s2 = sub.find(Boolean);
    if (s2) return s2;
  }

  return null;
}
