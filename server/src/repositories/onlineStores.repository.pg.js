import { query } from '../config/database.js';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function mapStore(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    slug: row.slug,
    name: row.name,
    templateCode: row.template_code,
    brandColor: row.brand_color,
    logoUrl: row.logo_url || null,
    tagline: row.tagline || '',
    phone: row.phone || '',
    email: row.email || '',
    address: row.address || '',
    published: row.published === true,
    productMode: row.product_mode || 'all',
    themeJson: parseJson(row.theme_json, {}),
    layoutJson: parseJson(row.layout_json, {}),
    attributeDisplay: parseJson(row.attribute_display_json, { byCategory: {} }),
    customDomain: row.custom_domain || null,
    customDomainStatus: row.custom_domain_status || 'none',
    customDomainVerifiedAt: row.custom_domain_verified_at || null,
    customDomainError: row.custom_domain_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findByProfileId(profileId) {
  const r = await query(`SELECT * FROM online_stores WHERE profile_id = $1 LIMIT 1`, [
    Number(profileId),
  ]);
  return mapStore(r.rows?.[0]);
}

export async function findBySlug(slug) {
  const r = await query(`SELECT * FROM online_stores WHERE slug = $1 LIMIT 1`, [
    String(slug || '').trim().toLowerCase(),
  ]);
  return mapStore(r.rows?.[0]);
}

export async function findPublishedBySlug(slug) {
  const r = await query(
    `SELECT * FROM online_stores WHERE slug = $1 AND published = true LIMIT 1`,
    [String(slug || '').trim().toLowerCase()]
  );
  return mapStore(r.rows?.[0]);
}

/** Опубликованная витрина по своему домену (active или pending — для будущей проверки). */
export async function findPublishedByCustomDomain(domain) {
  const host = String(domain || '').trim().toLowerCase();
  if (!host) return null;
  const r = await query(
    `SELECT * FROM online_stores
     WHERE published = true
       AND custom_domain IS NOT NULL
       AND lower(custom_domain) = $1
       AND custom_domain_status IN ('pending', 'active')
     LIMIT 1`,
    [host]
  );
  return mapStore(r.rows?.[0]);
}

export async function customDomainTaken(domain, excludeStoreId = null) {
  const host = String(domain || '').trim().toLowerCase();
  if (!host) return false;
  const params = [host];
  let sql = `SELECT 1 FROM online_stores WHERE custom_domain IS NOT NULL AND lower(custom_domain) = $1`;
  if (excludeStoreId != null) {
    params.push(Number(excludeStoreId));
    sql += ` AND id <> $2`;
  }
  sql += ` LIMIT 1`;
  const r = await query(sql, params);
  return Boolean(r.rows?.length);
}

export async function slugTaken(slug, excludeStoreId = null) {
  const params = [String(slug || '').trim().toLowerCase()];
  let sql = `SELECT 1 FROM online_stores WHERE slug = $1`;
  if (excludeStoreId != null) {
    params.push(Number(excludeStoreId));
    sql += ` AND id <> $2`;
  }
  sql += ` LIMIT 1`;
  const r = await query(sql, params);
  return Boolean(r.rows?.length);
}

export async function upsertForProfile(profileId, fields) {
  const existing = await findByProfileId(profileId);
  const themeJson = fields.themeJson != null ? JSON.stringify(fields.themeJson) : null;
  const layoutJson = fields.layoutJson != null ? JSON.stringify(fields.layoutJson) : null;
  const attributeDisplayProvided = fields.attributeDisplayJson !== undefined;
  const attributeDisplayJson = attributeDisplayProvided
    ? JSON.stringify(fields.attributeDisplayJson || { byCategory: {} })
    : null;

  const domainFieldsProvided = fields.customDomain !== undefined;
  const customDomain = domainFieldsProvided ? fields.customDomain || null : undefined;
  const customDomainStatus = domainFieldsProvided
    ? fields.customDomainStatus || (customDomain ? 'pending' : 'none')
    : undefined;
  const customDomainError = domainFieldsProvided ? fields.customDomainError || '' : undefined;
  const customDomainVerifiedAt = domainFieldsProvided
    ? fields.customDomainVerifiedAt ?? null
    : undefined;

  if (existing) {
    const r = await query(
      `UPDATE online_stores SET
         slug = $2,
         name = $3,
         template_code = $4,
         brand_color = $5,
         logo_url = $6,
         tagline = $7,
         phone = $8,
         email = $9,
         address = $10,
         published = $11,
         product_mode = $12,
         theme_json = COALESCE($13::jsonb, theme_json),
         layout_json = COALESCE($14::jsonb, layout_json),
         attribute_display_json = CASE
           WHEN $15::boolean THEN COALESCE($16::jsonb, '{}'::jsonb)
           ELSE attribute_display_json
         END,
         custom_domain = CASE WHEN $17::boolean THEN $18 ELSE custom_domain END,
         custom_domain_status = CASE WHEN $17::boolean THEN $19 ELSE custom_domain_status END,
         custom_domain_error = CASE WHEN $17::boolean THEN $20 ELSE custom_domain_error END,
         custom_domain_verified_at = CASE WHEN $17::boolean THEN $21 ELSE custom_domain_verified_at END,
         updated_at = CURRENT_TIMESTAMP
       WHERE profile_id = $1
       RETURNING *`,
      [
        Number(profileId),
        fields.slug,
        fields.name,
        fields.templateCode || 'minimal',
        fields.brandColor || '#0f766e',
        fields.logoUrl || null,
        fields.tagline || '',
        fields.phone || '',
        fields.email || '',
        fields.address || '',
        fields.published === true,
        fields.productMode || 'all',
        themeJson,
        layoutJson,
        attributeDisplayProvided,
        attributeDisplayJson,
        domainFieldsProvided,
        customDomain,
        customDomainStatus || 'none',
        customDomainError || '',
        customDomainVerifiedAt,
      ]
    );
    return mapStore(r.rows[0]);
  }

  const r = await query(
    `INSERT INTO online_stores (
       profile_id, slug, name, template_code, brand_color, logo_url,
       tagline, phone, email, address, published, product_mode,
       theme_json, layout_json, attribute_display_json,
       custom_domain, custom_domain_status, custom_domain_error, custom_domain_verified_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       COALESCE($13::jsonb, '{}'::jsonb),
       COALESCE($14::jsonb, '{}'::jsonb),
       COALESCE($15::jsonb, '{}'::jsonb),
       $16, $17, $18, $19
     )
     RETURNING *`,
    [
      Number(profileId),
      fields.slug,
      fields.name,
      fields.templateCode || 'minimal',
      fields.brandColor || '#0f766e',
      fields.logoUrl || null,
      fields.tagline || '',
      fields.phone || '',
      fields.email || '',
      fields.address || '',
      fields.published === true,
      fields.productMode || 'all',
      themeJson,
      layoutJson,
      attributeDisplayProvided ? attributeDisplayJson : '{}',
      domainFieldsProvided ? customDomain : null,
      domainFieldsProvided ? customDomainStatus || 'none' : 'none',
      domainFieldsProvided ? customDomainError || '' : '',
      domainFieldsProvided ? customDomainVerifiedAt : null,
    ]
  );
  return mapStore(r.rows[0]);
}

/** Снять витрину с публикации (например, при отключении частных заказов). */
export async function unpublishByProfileId(profileId) {
  const r = await query(
    `UPDATE online_stores
     SET published = false, updated_at = CURRENT_TIMESTAMP
     WHERE profile_id = $1 AND published = true
     RETURNING id`,
    [Number(profileId)]
  );
  return (r.rows || []).length;
}

export async function listStoreProductLinks(storeId) {
  const r = await query(
    `SELECT store_id, product_id, sort_order, published, selling_price
     FROM online_store_products
     WHERE store_id = $1
     ORDER BY sort_order ASC, product_id ASC`,
    [Number(storeId)]
  );
  return (r.rows || []).map((row) => ({
    storeId: Number(row.store_id),
    productId: Number(row.product_id),
    sortOrder: Number(row.sort_order) || 0,
    published: row.published !== false,
    sellingPrice:
      row.selling_price != null && row.selling_price !== '' ? Number(row.selling_price) : null,
  }));
}

export async function replaceStoreProducts(storeId, items) {
  await query(`DELETE FROM online_store_products WHERE store_id = $1`, [Number(storeId)]);
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const productId = Number(it.productId ?? it.product_id);
    if (!Number.isFinite(productId) || productId < 1) continue;
    const priceRaw = it.sellingPrice ?? it.selling_price;
    const sellingPrice =
      priceRaw != null && priceRaw !== '' && Number.isFinite(Number(priceRaw))
        ? Number(priceRaw)
        : null;
    await query(
      `INSERT INTO online_store_products (store_id, product_id, sort_order, published, selling_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        Number(storeId),
        productId,
        Number.isFinite(Number(it.sortOrder)) ? Number(it.sortOrder) : i,
        it.published === false ? false : true,
        sellingPrice,
      ]
    );
  }
  return listStoreProductLinks(storeId);
}

export default {
  findByProfileId,
  findBySlug,
  findPublishedBySlug,
  findPublishedByCustomDomain,
  customDomainTaken,
  slugTaken,
  upsertForProfile,
  unpublishByProfileId,
  listStoreProductLinks,
  replaceStoreProducts,
};
