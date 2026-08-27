/**
 * Описание карточки: WB принимает обычные переносы строк.
 * Яндекс.Маркет на витрине показывает HTML.
 * Аннотация Ozon (4191) — одно текстовое значение: переносы как \\n, без HTML.
 */

const ALREADY_HTML_RE = /<\s*\/?\s*(br|p|b|i|strong|em|ul|ol|li|div|span)(?:\s|\/|>)/i;

export function escapeHtmlText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Переносы строк → <br> для Ozon / YM. Уже размеченный HTML не экранируем целиком.
 * @param {unknown} text
 * @returns {string}
 */
export function plainTextToMarketplaceHtml(text) {
  const raw = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!raw) return '';
  if (ALREADY_HTML_RE.test(raw)) {
    return raw.replace(/\n/g, '<br>');
  }
  return escapeHtmlText(raw).replace(/\n/g, '<br>');
}

/**
 * HTML описания с МП → текст с \n для полей ERP.
 * @param {unknown} html
 * @returns {string}
 */
export function marketplaceHtmlToPlainText(html) {
  return String(html ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n')
    .replace(/<\s*p[^>]*>/gi, '')
    .replace(/<\s*\/\s*div\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '')
    .replace(/<\s*\/\s*li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const OZON_ANNOTATION_ATTR_ID = 4191;

/**
 * Аннотация Ozon: одно { value }, переносы строк сохраняем.
 * HTML &lt;br&gt; / несколько values раньше давали ERROR_ATTRIBUTE_IS_NOT_COLLECTION.
 * @param {unknown} text
 * @returns {string}
 */
export function formatOzonAnnotationForPush(text) {
  return marketplaceHtmlToPlainText(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** @deprecated имя историческое: HTML в 4191 не отправляем, только текст с \\n. */
export function ozonAnnotationSingleHtml(text) {
  return formatOzonAnnotationForPush(text);
}

/**
 * Пишет описание в атрибут «Аннотация» (4191) одним значением с переносами строк.
 * item.description не дублируем — Ozon склеивает его с 4191 и ругается на коллекцию.
 * @param {object} item
 * @param {unknown} description
 */
export function applyOzonDescriptionHtml(item, description) {
  if (!item || typeof item !== 'object') return item;
  const attrs = Array.isArray(item.attributes) ? item.attributes.map((a) => ({ ...a })) : [];
  const idx = attrs.findIndex((a) => Number(a.id) === OZON_ANNOTATION_ATTR_ID);
  const attrPlain = idx >= 0 ? String(attrs[idx]?.values?.[0]?.value ?? '') : '';
  const source = String(description || '').trim() || attrPlain;
  const plain = ozonAnnotationSingleHtml(source);
  if (!plain) return item;

  const nextAttrs = attrs.map((a) => {
    if (Number(a.id) !== OZON_ANNOTATION_ATTR_ID) return a;
    return { ...a, complex_id: a.complex_id ?? 0, values: [{ value: plain }] };
  });
  if (!nextAttrs.some((a) => Number(a.id) === OZON_ANNOTATION_ATTR_ID)) {
    nextAttrs.push({ complex_id: 0, id: OZON_ANNOTATION_ATTR_ID, values: [{ value: plain }] });
  }
  item.attributes = nextAttrs;
  return item;
}

export default {
  escapeHtmlText,
  plainTextToMarketplaceHtml,
  marketplaceHtmlToPlainText,
  formatOzonAnnotationForPush,
  ozonAnnotationSingleHtml,
  applyOzonDescriptionHtml,
};
