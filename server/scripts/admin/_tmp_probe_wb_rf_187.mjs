import { query, closePool } from '../../src/config/database.js';

const cache = await query(
  `SELECT calculator->>'logistics_base_fbo' AS base_fbo,
          calculator->>'logistics_cost_fbo' AS cost_fbo,
          calculator->>'logistics_base_fbs' AS base_fbs,
          calculator->>'logistics_cost_fbs' AS cost_fbs,
          calculator->>'logistics_coef_fbs' AS coef_fbs
     FROM product_mp_calculator_cache
    WHERE marketplace = 'wb' AND product_id = 187`
);
const price = await query(
  `SELECT min_price, min_price_fbo, min_price_fbs, updated_at,
          calculation_details
     FROM product_marketplace_prices
    WHERE product_id = 187 AND marketplace = 'wb'`
);
const sku = await query(`SELECT sku, name FROM products WHERE id = 187`);
const d = price.rows[0]?.calculation_details || {};
const dims = await query(
  `SELECT length, width, height, wb_attributes, wb_draft, mp_field_links
     FROM products WHERE id = 187`
);
const row = dims.rows[0] || {};
const attrs = row.wb_attributes && typeof row.wb_attributes === 'object' ? row.wb_attributes : {};
const draft = row.wb_draft && typeof row.wb_draft === 'object' ? row.wb_draft : {};
console.log(JSON.stringify({
  sku: sku.rows[0],
  cache: cache.rows[0],
  price: {
    min_price: price.rows[0]?.min_price,
    min_price_fbo: price.rows[0]?.min_price_fbo,
    min_price_fbs: price.rows[0]?.min_price_fbs,
  },
  saved: {
    volume_weight: d.volume_weight,
    logistics_cost: d.logistics_cost,
    logistics_cost_fbo: d.logistics_cost_fbo,
    logistics_cost_fbs: d.logistics_cost_fbs,
    logistics_base_fbo: d.logistics_base_fbo,
    logistics_liter_fbo: d.logistics_liter_fbo,
    logistics: d.logistics,
    inputs: d._inputs,
  },
  product: {
    length: row.length,
    width: row.width,
    height: row.height,
    links: row.mp_field_links,
    pack: { l: attrs['90849'] ?? attrs[90849], w: attrs['90745'] ?? attrs[90745], h: attrs['90846'] ?? attrs[90846] },
    draftDimensions: draft.dimensions || null,
  },
}, null, 2));
await closePool();
