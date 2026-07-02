/**
 * Подстановка переменных в шаблон ответа.
 * Имя: {{имя}}, {{name}}
 * Товар: {{товар}}, {{product}}, {{артикул}}
 */

export const QUESTION_TEMPLATE_NAME_TOKEN = '{{имя}}';
export const QUESTION_TEMPLATE_PRODUCT_TOKEN = '{{товар}}';

export const QUESTION_TEMPLATE_PREVIEW_SAMPLE_NAME = 'Мария';

const NAME_PLACEHOLDER_RE = /\{\{\s*(имя|name)\s*\}\}|\{\s*(имя|name)\s*\}/gi;
const PRODUCT_PLACEHOLDER_RE = /\{\{\s*(товар|product|артикул)\s*\}\}|\{\s*(товар|product|артикул)\s*\}/gi;
const ANY_TOKEN_RE =
  /\{\{\s*(имя|name|товар|product|артикул)\s*\}\}|\{\s*(имя|name|товар|product|артикул)\s*\}/gi;

function tokenTypeFromMatch(m) {
  const key = String(m[1] ?? m[2] ?? '').toLowerCase();
  if (key === 'имя' || key === 'name') return 'name';
  return 'product';
}

/** Убрать запятую и лишние пробелы, если метка имени пустая («Здравствуйте, !» → «Здравствуйте!»). */
function cleanupAfterEmptyBuyerName(text) {
  let s = String(text ?? '');
  s = s.replace(/,\s*([!?.…])/g, '$1');
  s = s.replace(/,\s*,/g, ',');
  s = s.replace(/,\s*$/g, '');
  s = s.replace(/\s+([!?.…])/g, '$1');
  s = s.replace(/ {2,}/g, ' ');
  return s;
}

function replaceBuyerNameInTemplate(text, name) {
  const trimmed = name != null ? String(name).trim() : '';
  if (trimmed) {
    return String(text ?? '').replace(NAME_PLACEHOLDER_RE, trimmed);
  }
  let s = String(text ?? '');
  s = s.replace(/,\s*(\{\{\s*(имя|name)\s*\}\}|\{\s*(имя|name)\s*\})/gi, '');
  s = s.replace(/(\{\{\s*(имя|name)\s*\}\}|\{\s*(имя|name)\s*\})\s*,\s*/gi, '');
  s = s.replace(NAME_PLACEHOLDER_RE, '');
  return cleanupAfterEmptyBuyerName(s);
}

/** Имя для прямого ответа (без метки в тексте). Пустая строка, если имя неизвестно. */
export function resolveBuyerNameForReply(buyerName) {
  const name = buyerName != null ? String(buyerName).trim() : '';
  return name;
}

/**
 * @param {string} templateText
 * @param {{ buyerName?: string|null, productLabel?: string|null }} [vars]
 * @returns {string}
 */
export function applyQuestionTemplate(templateText, { buyerName, productLabel } = {}) {
  const product = productLabel != null ? String(productLabel).trim() : '';
  return replaceBuyerNameInTemplate(templateText, buyerName).replace(
    PRODUCT_PLACEHOLDER_RE,
    product || 'товар'
  );
}

export function templateContainsNamePlaceholder(templateText) {
  return /\{\{\s*(имя|name)\s*\}\}|\{\s*(имя|name)\s*\}/i.test(String(templateText ?? ''));
}

export function templateContainsProductPlaceholder(templateText) {
  return /\{\{\s*(товар|product|артикул)\s*\}\}|\{\s*(товар|product|артикул)\s*\}/i.test(
    String(templateText ?? '')
  );
}

/**
 * @returns {Array<{ type: 'text'|'name'|'product', value: string }>}
 */
export function splitTemplateForDisplay(templateText) {
  const text = String(templateText ?? '');
  if (!text) return [];
  const parts = [];
  let lastIndex = 0;
  let m;
  const re = new RegExp(ANY_TOKEN_RE.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, m.index) });
    }
    parts.push({ type: tokenTypeFromMatch(m), value: m[0] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return parts;
}
