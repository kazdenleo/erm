/**
 * Подстановка имени покупателя в шаблон ответа.
 * Плейсхолдеры: {{имя}}, {{name}}, {имя}, {name}
 */

export const QUESTION_TEMPLATE_NAME_TOKEN = '{{имя}}';

export const QUESTION_TEMPLATE_PREVIEW_SAMPLE_NAME = 'Мария';

const NAME_PLACEHOLDER_RE = /\{\{\s*(имя|name)\s*\}\}|\{\s*(имя|name)\s*\}/gi;

/**
 * @param {string} templateText
 * @param {{ buyerName?: string|null }} [vars]
 * @returns {string}
 */
export function applyQuestionTemplate(templateText, { buyerName } = {}) {
  const name = buyerName != null ? String(buyerName).trim() : '';
  const replacement = name || 'покупатель';
  return String(templateText ?? '').replace(NAME_PLACEHOLDER_RE, replacement);
}

export function templateContainsNamePlaceholder(templateText) {
  return /\{\{\s*(имя|name)\s*\}\}|\{\s*(имя|name)\s*\}/i.test(String(templateText ?? ''));
}

/**
 * Разбивка текста шаблона для визуального отображения (текст + метка «имя»).
 * @returns {Array<{ type: 'text'|'name', value: string }>}
 */
export function splitTemplateForDisplay(templateText) {
  const text = String(templateText ?? '');
  if (!text) return [];
  const re = /\{\{\s*(?:имя|name)\s*\}\}|\{\s*(?:имя|name)\s*\}/gi;
  const parts = [];
  let lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, m.index) });
    }
    parts.push({ type: 'name', value: m[0] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return parts;
}
