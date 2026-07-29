/**
 * Плейсхолдеры шаблонов ответов на отзывы.
 */

const PRODUCT_RE = /\{\{\s*(товар|product|артикул)\s*\}\}|\{\s*(товар|product|артикул)\s*\}/gi;

/**
 * @param {string} body
 * @param {{ skuOrOffer?: string|null }} [ctx]
 */
export function applyReviewTemplate(body, ctx = {}) {
  const sku = String(ctx.skuOrOffer ?? '').trim() || 'товар';
  return String(body ?? '').replace(PRODUCT_RE, sku).trim();
}

export const REVIEW_TEMPLATE_PRODUCT_TOKEN = '{{артикул}}';
