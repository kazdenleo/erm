/**
 * Минимальные цены конкурентов на Ozon из индекса цен Seller API.
 */
import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import {
  ozonColorIndexLabel,
  parseOzonCompetitorPriceIndex,
} from '../utils/ozonCompetitorPriceIndex.js';

function mapRow(row) {
  if (!row) return null;
  const color = row.color_index || null;
  const price = row.competitor_min_price != null ? Number(row.competitor_min_price) : null;
  const cost = row.product_cost != null ? Number(row.product_cost) : null;
  return {
    id: Number(row.id),
    product_id: Number(row.product_id),
    offer_id: row.offer_id,
    competitor_min_price: price,
    external_min_price: row.external_min_price != null ? Number(row.external_min_price) : null,
    price_index_value: row.price_index_value != null ? Number(row.price_index_value) : null,
    color_index: color,
    color_label: ozonColorIndexLabel(color),
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    below_cost: cost != null && price != null && price < cost,
    product_cost: cost,
  };
}

export async function listOzonCompetitorPrices(productId) {
  const r = await query(
    `SELECT c.*, p.cost AS product_cost
     FROM ozon_competitor_prices c
     JOIN products p ON p.id = c.product_id
     WHERE c.product_id = $1
     ORDER BY c.offer_id`,
    [productId]
  );
  return (r.rows || []).map(mapRow);
}

export async function productHasOzonOffer(productId) {
  const r = await query(
    `SELECT 1 FROM product_skus
     WHERE product_id = $1 AND marketplace = 'ozon'
       AND sku IS NOT NULL AND TRIM(sku) <> ''
     LIMIT 1`,
    [productId]
  );
  return Boolean(r.rows?.length);
}

/**
 * Сохранить индекс цен из уже полученного элемента /v5/product/info/prices.
 */
export async function upsertOzonCompetitorPriceFromV5Item({ productId, offerId, item, lastError = null }) {
  const parsed = parseOzonCompetitorPriceIndex(item);
  const offer = String(offerId || item?.offer_id || '').trim();
  if (!productId || !offer) return null;
  const r = await query(
    `INSERT INTO ozon_competitor_prices (
       product_id, offer_id, competitor_min_price, external_min_price,
       price_index_value, color_index, last_checked_at, last_error, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, CURRENT_TIMESTAMP)
     ON CONFLICT (product_id, offer_id) DO UPDATE SET
       competitor_min_price = EXCLUDED.competitor_min_price,
       external_min_price = EXCLUDED.external_min_price,
       price_index_value = EXCLUDED.price_index_value,
       color_index = EXCLUDED.color_index,
       last_checked_at = CURRENT_TIMESTAMP,
       last_error = EXCLUDED.last_error,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      productId,
      offer,
      parsed.competitor_min_price,
      parsed.external_min_price,
      parsed.price_index_value,
      parsed.color_index,
      lastError,
    ]
  );
  return r.rows?.[0] || null;
}

export async function markOzonCompetitorPriceError(productId, offerId, message) {
  const offer = String(offerId || '').trim();
  if (!productId || !offer) return;
  await query(
    `INSERT INTO ozon_competitor_prices (
       product_id, offer_id, last_checked_at, last_error, updated_at
     ) VALUES ($1, $2, CURRENT_TIMESTAMP, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (product_id, offer_id) DO UPDATE SET
       last_checked_at = CURRENT_TIMESTAMP,
       last_error = EXCLUDED.last_error,
       updated_at = CURRENT_TIMESTAMP`,
    [productId, offer, String(message || 'Ошибка Ozon').slice(0, 500)]
  );
}

export async function saveOzonCompetitorPricesForOffer(offerId, item) {
  const offer = String(offerId || '').trim();
  if (!offer || !item) return 0;
  let saved = 0;
  try {
    const pidsRes = await query(
      `SELECT product_id FROM product_skus
       WHERE marketplace = 'ozon' AND TRIM(sku) = $1`,
      [offer]
    );
    for (const pr of pidsRes.rows || []) {
      await upsertOzonCompetitorPriceFromV5Item({
        productId: pr.product_id,
        offerId: offer,
        item,
      });
      saved += 1;
    }
  } catch (e) {
    if (String(e?.message || '').includes('ozon_competitor_prices')) {
      logger.warn('[Ozon competitors] table missing, skip save', { message: e?.message });
      return 0;
    }
    throw e;
  }
  return saved;
}
