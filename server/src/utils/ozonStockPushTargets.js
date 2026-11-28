/**
 * Цели пуша остатков на Ozon: основной offer из product_skus + алиасы из mp_extra.
 * Алиасы нужны, когда на Ozon осталась старая карточка (другой offer_id),
 * а в ERM уникальность (product_id, marketplace) не даёт вторую строку product_skus.
 *
 * mp_extra.stock_aliases: [{ offer_id, product_id?, ozon_sku? }, ...]
 * (также принимаем ozon_stock_aliases)
 */

function trimStr(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {object|null|undefined} mpExtra
 * @returns {{ offerId: string|null, productId: number|null }[]}
 */
export function parseOzonStockAliases(mpExtra) {
  const extra = mpExtra && typeof mpExtra === 'object' && !Array.isArray(mpExtra) ? mpExtra : {};
  const raw = extra.stock_aliases ?? extra.ozon_stock_aliases ?? [];
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const offerId = trimStr(row.offer_id ?? row.offerId ?? row.sku) || null;
    const productId = numOrNull(row.product_id ?? row.productId ?? row.marketplace_product_id);
    if (!offerId && !productId) continue;
    const key = `${offerId || ''}:${productId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ offerId, productId });
  }
  return out;
}

/**
 * @param {{ productSkus?: object[], product?: object }} ctx
 * @returns {{ offerId: string|null, productId: number|null, source: 'primary'|'alias' }[]}
 */
export function resolveOzonStockPushTargets(ctx = {}) {
  const ozonSku = (ctx.productSkus || []).find((s) => s && s.marketplace === 'ozon');
  const primaryOffer =
    trimStr(ozonSku?.sku) ||
    trimStr(ctx.product?.sku_ozon) ||
    trimStr(ctx.product?.sku) ||
    null;
  const primaryProductId =
    numOrNull(ozonSku?.marketplace_product_id) ??
    numOrNull(ctx.product?.ozon_product_id) ??
    null;

  const targets = [];
  const seen = new Set();
  const add = (offerId, productId, source) => {
    if (!offerId && !productId) return;
    const key = `${offerId || ''}:${productId || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ offerId: offerId || null, productId: productId || null, source });
  };

  add(primaryOffer, primaryProductId, 'primary');

  const extra =
    (ozonSku?.mp_extra && typeof ozonSku.mp_extra === 'object' ? ozonSku.mp_extra : null) ||
    (ctx.product?.mp_extra && typeof ctx.product.mp_extra === 'object' ? ctx.product.mp_extra : null) ||
    {};
  for (const a of parseOzonStockAliases(extra)) {
    add(a.offerId, a.productId, 'alias');
  }

  return targets;
}
