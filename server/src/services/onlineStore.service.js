/**
 * Интернет-магазин: настройки витрины + публичный каталог + checkout → manual order.
 */
import { query } from '../config/database.js';
import * as storesRepo from '../repositories/onlineStores.repository.pg.js';
import repositoryFactory from '../config/repository-factory.js';
import customersRepo from '../repositories/customers.repository.pg.js';
import {
  ONLINE_STORE_TEMPLATES,
  isOnlineStoreTemplate,
} from '../constants/onlineStoreTemplates.js';
import {
  STORE_BLOCK_TYPES,
  STORE_EDITOR_FEATURE,
  defaultLayoutForTemplate,
  normalizeStoreTheme,
  resolveStoreLayout,
  resolveStoreTheme,
  sanitizeLayout,
} from '../constants/onlineStoreLayout.js';
import {
  STORE_CUSTOM_DOMAIN_FEATURE,
  domainDnsInstructions,
  isValidCustomDomain,
  normalizeCustomDomain,
  storeDomainCnameTarget,
} from '../constants/onlineStoreDomain.js';
import { privateClientMinPrice } from '../utils/marketplaceMinProfit.js';
import { planHasFeature, resolveSubscription } from '../utils/profileSubscription.js';
import ordersService from './orders.service.js';

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

function err(message, statusCode = 400, code = null) {
  const e = new Error(message);
  e.statusCode = statusCode;
  if (code) e.code = code;
  throw e;
}

function normalizeSlug(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function parseImages(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
}

function primaryImageUrl(images) {
  const list = parseImages(images);
  const localUrl = (img) => {
    if (!img || typeof img !== 'object') return '';
    const u = img.url ?? img.src ?? img.link ?? '';
    return typeof u === 'string' ? u.trim() : '';
  };
  const remoteUrl = (img) => {
    if (!img || typeof img !== 'object') return '';
    const u = img.source_url ?? img.sourceUrl ?? img.cdn_url ?? img.cdnUrl ?? '';
    return typeof u === 'string' ? u.trim() : '';
  };
  const hasAny = (img) => Boolean(localUrl(img) || remoteUrl(img));
  const primary = list.find((img) => (img.primary === true || img.is_main === true) && hasAny(img));
  const chosen = primary || list.find((img) => hasAny(img));
  if (!chosen) return null;
  // Публичная витрина: сначала CDN/source — локальные /uploads часто отсутствуют на диске.
  const remote = remoteUrl(chosen);
  if (/^https?:\/\//i.test(remote)) return remote;
  const raw = localUrl(chosen);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw;
  return `/${raw.replace(/^\//, '')}`;
}

function resolveSellPrice(product, link) {
  if (link?.sellingPrice != null && Number.isFinite(link.sellingPrice) && link.sellingPrice >= 0) {
    return link.sellingPrice;
  }
  const catalog = product.price != null ? Number(product.price) : NaN;
  if (Number.isFinite(catalog) && catalog > 0) return catalog;
  try {
    const floor = privateClientMinPrice(product, null);
    if (Number.isFinite(floor) && floor > 0) return Math.ceil(floor);
  } catch {
    /* ignore */
  }
  const cost = product.cost != null ? Number(product.cost) : NaN;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

async function stockForProduct(productId, warehouseId) {
  if (warehouseId) {
    try {
      const r = await query(
        `SELECT quantity::int AS q FROM product_warehouse_stock
         WHERE product_id = $1 AND warehouse_id = $2`,
        [productId, warehouseId]
      );
      if (r.rows?.[0]) return Math.max(0, Number(r.rows[0].q) || 0);
    } catch {
      /* fall through */
    }
  }
  const r = await query(`SELECT COALESCE(quantity, 0)::int AS q FROM products WHERE id = $1`, [
    productId,
  ]);
  return Math.max(0, Number(r.rows?.[0]?.q) || 0);
}

async function loadProfile(profileId) {
  const profilesRepo = repositoryFactory.getProfilesRepository();
  return profilesRepo.findById(profileId);
}

function editorAllowedForProfile(profile) {
  return planHasFeature(resolveSubscription(profile), STORE_EDITOR_FEATURE);
}

function customDomainAllowedForProfile(profile) {
  return planHasFeature(resolveSubscription(profile), STORE_CUSTOM_DOMAIN_FEATURE);
}

function domainPublicPayload(store) {
  if (!store?.customDomain) {
    return {
      customDomain: null,
      customDomainStatus: 'none',
      customDomainVerifiedAt: null,
      customDomainError: '',
    };
  }
  return {
    customDomain: store.customDomain,
    customDomainStatus: store.customDomainStatus || 'none',
    customDomainVerifiedAt: store.customDomainVerifiedAt || null,
    customDomainError: store.customDomainError || '',
  };
}

function publicStorePayload(store) {
  const theme = resolveStoreTheme(store);
  const layout = resolveStoreLayout(store);
  return {
    slug: store.slug,
    name: store.name,
    templateCode: store.templateCode,
    brandColor: theme.brandColor || store.brandColor,
    logoUrl: theme.logoUrl || store.logoUrl,
    tagline: store.tagline,
    phone: store.phone,
    email: store.email,
    address: store.address,
    theme,
    layout,
    ...domainPublicPayload(store),
  };
}

function mapPublicProduct(product, link, stock) {
  const price = resolveSellPrice(product, link);
  const categoryId =
    product.user_category_id != null && product.user_category_id !== ''
      ? Number(product.user_category_id)
      : product.categoryId != null
        ? Number(product.categoryId)
        : null;
  return {
    id: Number(product.id),
    sku: product.sku || null,
    name: product.name || '',
    description: pickPublicDescription(product),
    price,
    inStock: stock > 0,
    stock: stock > 0 ? stock : 0,
    imageUrl: primaryImageUrl(product.images),
    categoryId: Number.isFinite(categoryId) && categoryId > 0 ? categoryId : null,
    categoryName: product.category_name || product.categoryName || null,
  };
}

function buildPublicCategories(products) {
  const map = new Map();
  let uncategorized = 0;
  for (const p of products || []) {
    if (p.categoryId != null && p.categoryName) {
      const prev = map.get(p.categoryId) || { id: p.categoryId, name: p.categoryName, count: 0 };
      prev.count += 1;
      map.set(p.categoryId, prev);
    } else {
      uncategorized += 1;
    }
  }
  const categories = [...map.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), 'ru')
  );
  if (uncategorized > 0) {
    categories.push({ id: 'none', name: 'Без категории', count: uncategorized });
  }
  return categories;
}

async function attachCategoryImages(profileId, categories) {
  const ids = (categories || [])
    .map((c) => Number(c.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return categories || [];
  const r = await query(
    `SELECT id, image_url
     FROM user_categories
     WHERE profile_id = $1 AND id = ANY($2::bigint[])`,
    [profileId, ids]
  );
  const byId = new Map(
    (r.rows || []).map((row) => [Number(row.id), row.image_url ? String(row.image_url) : null])
  );
  return (categories || []).map((c) => ({
    ...c,
    imageUrl: byId.get(Number(c.id)) || null,
  }));
}

export function listTemplates() {
  return ONLINE_STORE_TEMPLATES;
}

export async function getAdminStore(profileId) {
  const profile = await loadProfile(profileId);
  const editorEnabled = editorAllowedForProfile(profile);
  const customDomainEnabled = customDomainAllowedForProfile(profile);
  const store = await storesRepo.findByProfileId(profileId);
  const domainMeta = {
    customDomainEnabled,
    customDomainFeature: STORE_CUSTOM_DOMAIN_FEATURE,
    cnameTarget: storeDomainCnameTarget(),
  };
  if (!store) {
    return {
      store: null,
      products: [],
      templates: ONLINE_STORE_TEMPLATES,
      blockTypes: STORE_BLOCK_TYPES,
      editorEnabled,
      editorFeature: STORE_EDITOR_FEATURE,
      ...domainMeta,
      publicPath: null,
    };
  }
  const products = await storesRepo.listStoreProductLinks(store.id);
  const theme = resolveStoreTheme(store);
  const layout = resolveStoreLayout(store);
  return {
    store: {
      ...store,
      theme,
      layout,
      ...domainPublicPayload(store),
      dns: store.customDomain ? domainDnsInstructions(store.customDomain) : null,
    },
    products,
    templates: ONLINE_STORE_TEMPLATES,
    blockTypes: STORE_BLOCK_TYPES,
    editorEnabled,
    editorFeature: STORE_EDITOR_FEATURE,
    ...domainMeta,
    publicPath: `/s/${store.slug}`,
  };
}

export async function saveAdminStore(profileId, body = {}) {
  const profile = await loadProfile(profileId);
  if (!profile) err('Профиль не найден', 404);

  const existing = await storesRepo.findByProfileId(profileId);
  let slug = body.slug != null ? normalizeSlug(body.slug) : existing?.slug || '';
  if (!slug) {
    const base = normalizeSlug(profile.name || `shop-${profileId}`) || `shop-${profileId}`;
    slug = base;
    let n = 0;
    while (await storesRepo.slugTaken(slug, existing?.id || null)) {
      n += 1;
      slug = `${base.slice(0, 56)}-${n}`;
    }
  }
  if (!SLUG_RE.test(slug)) {
    err('Адрес магазина: латиница, цифры и дефис (2–64 символа)');
  }
  if (await storesRepo.slugTaken(slug, existing?.id || null)) {
    err('Такой адрес уже занят — выберите другой', 409, 'SLUG_TAKEN');
  }

  const name =
    body.name != null && String(body.name).trim()
      ? String(body.name).trim().slice(0, 255)
      : existing?.name || profile.name || 'Мой магазин';

  let templateCode = existing?.templateCode || 'minimal';
  if (body.templateCode != null) {
    const t = String(body.templateCode).trim().toLowerCase();
    if (!isOnlineStoreTemplate(t)) err('Неизвестный шаблон');
    templateCode = t;
  }

  let brandColor = existing?.brandColor || '#0f766e';
  if (body.brandColor != null) {
    const c = String(body.brandColor).trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) err('Цвет бренда: формат #RRGGBB');
    brandColor = c.toLowerCase();
  }

  const productModeRaw =
    body.productMode != null ? String(body.productMode).trim().toLowerCase() : null;
  if (productModeRaw && productModeRaw !== 'all' && productModeRaw !== 'selected') {
    err('productMode: all или selected');
  }

  const published =
    body.published != null ? body.published === true || body.published === '1' : undefined;

  const willPublish =
    published !== undefined ? published === true : existing?.published === true;

  if (willPublish) {
    if (profile.allow_private_orders !== true) {
      err(
        'Интернет-магазин можно опубликовать только при включённых частных заказах (Настройки → Аккаунт)',
        400,
        'PRIVATE_ORDERS_REQUIRED'
      );
    }
    const wh = profile.manual_orders_warehouse_id ?? profile.manualOrdersWarehouseId;
    if (wh == null || wh === '') {
      err(
        'Перед публикацией укажите склад частных заказов в Настройки → Аккаунт',
        400,
        'WAREHOUSE_REQUIRED'
      );
    }
  }

  const editorEnabled = editorAllowedForProfile(profile);
  const templateChanged = existing && existing.templateCode !== templateCode;

  let themeJson;
  let layoutJson;
  if (editorEnabled) {
    if (body.theme != null || body.themeJson != null) {
      themeJson = normalizeStoreTheme(body.theme ?? body.themeJson, {
        brandColor,
        logoUrl: body.logoUrl !== undefined ? body.logoUrl : existing?.logoUrl,
      });
      brandColor = themeJson.brandColor;
    }
    if (body.layout != null || body.layoutJson != null) {
      layoutJson = sanitizeLayout(body.layout ?? body.layoutJson, { templateCode });
    } else if (templateChanged) {
      // Смена шаблона на Про: подставляем стартовую раскладку шаблона (можно править дальше).
      layoutJson = defaultLayoutForTemplate(templateCode);
    }
  } else {
    if (body.layout != null || body.layoutJson != null || body.theme != null || body.themeJson != null) {
      err(
        'Редактор витрины доступен на тарифе «Про». На текущем тарифе можно выбрать готовый шаблон.',
        403,
        'PLAN_FEATURE'
      );
    }
    if (!existing || templateChanged) {
      layoutJson = defaultLayoutForTemplate(templateCode);
      themeJson = normalizeStoreTheme(
        {},
        {
          brandColor,
          logoUrl: body.logoUrl !== undefined ? body.logoUrl : existing?.logoUrl,
        }
      );
    }
  }

  const customDomainEnabled = customDomainAllowedForProfile(profile);
  const domainTouched =
    body.customDomain !== undefined ||
    body.custom_domain !== undefined ||
    body.clearCustomDomain === true;

  let domainPatch = {};
  if (domainTouched) {
    if (!customDomainEnabled) {
      err(
        'Свой домен витрины доступен на тарифе «Про».',
        403,
        'PLAN_FEATURE'
      );
    }
    if (body.clearCustomDomain === true) {
      domainPatch = {
        customDomain: null,
        customDomainStatus: 'none',
        customDomainError: '',
        customDomainVerifiedAt: null,
      };
    } else {
      const nextDomain = normalizeCustomDomain(body.customDomain ?? body.custom_domain);
      if (!nextDomain) {
        domainPatch = {
          customDomain: null,
          customDomainStatus: 'none',
          customDomainError: '',
          customDomainVerifiedAt: null,
        };
      } else {
        if (!isValidCustomDomain(nextDomain)) {
          err('Некорректное доменное имя (пример: shop.example.ru)');
        }
        if (await storesRepo.customDomainTaken(nextDomain, existing?.id || null)) {
          err('Этот домен уже привязан к другому магазину', 409, 'DOMAIN_TAKEN');
        }
        const sameAsBefore =
          existing?.customDomain &&
          String(existing.customDomain).toLowerCase() === nextDomain &&
          existing.customDomainStatus === 'active';
        domainPatch = {
          customDomain: nextDomain,
          customDomainStatus: sameAsBefore ? 'active' : 'pending',
          customDomainError: '',
          customDomainVerifiedAt: sameAsBefore ? existing.customDomainVerifiedAt : null,
        };
      }
    }
  }

  const fields = {
    slug,
    name,
    templateCode,
    brandColor,
    logoUrl: body.logoUrl !== undefined ? body.logoUrl || null : existing?.logoUrl || null,
    tagline: body.tagline != null ? String(body.tagline).slice(0, 500) : existing?.tagline || '',
    phone: body.phone != null ? String(body.phone).slice(0, 50) : existing?.phone || '',
    email: body.email != null ? String(body.email).slice(0, 255) : existing?.email || '',
    address: body.address != null ? String(body.address).slice(0, 1000) : existing?.address || '',
    published: published !== undefined ? published : existing?.published === true,
    productMode: productModeRaw || existing?.productMode || 'all',
    themeJson,
    layoutJson,
    ...domainPatch,
  };

  const store = await storesRepo.upsertForProfile(profileId, fields);

  if (Array.isArray(body.products)) {
    const ids = body.products
      .map((p) => Number(p.productId ?? p.product_id ?? p))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length) {
      const check = await query(
        `SELECT id FROM products WHERE profile_id = $1 AND id = ANY($2::bigint[])`,
        [profileId, ids]
      );
      const allowed = new Set((check.rows || []).map((r) => Number(r.id)));
      const items = body.products
        .map((p, i) => {
          const productId = Number(p.productId ?? p.product_id ?? p);
          if (!allowed.has(productId)) return null;
          return {
            productId,
            sortOrder: Number.isFinite(Number(p.sortOrder)) ? Number(p.sortOrder) : i,
            published: p.published !== false,
            sellingPrice: p.sellingPrice ?? p.selling_price ?? null,
          };
        })
        .filter(Boolean);
      await storesRepo.replaceStoreProducts(store.id, items);
    } else if (body.products.length === 0) {
      await storesRepo.replaceStoreProducts(store.id, []);
    }
  }

  return getAdminStore(profileId);
}

async function catalogRowsForStore(store) {
  const warehouseId = await resolveWarehouseId(store.profileId);
  const links =
    store.productMode === 'selected' ? await storesRepo.listStoreProductLinks(store.id) : [];
  const linkById = new Map(links.filter((l) => l.published).map((l) => [l.productId, l]));

  let sql;
  let params;
  if (store.productMode === 'selected') {
    const ids = [...linkById.keys()];
    if (!ids.length) return [];
    sql = `SELECT p.id, p.sku, p.name, p.description, p.price, p.cost, p.additional_expenses, p.min_price,
                  p.images, p.quantity, p.user_category_id, uc.name AS category_name,
                  p.mp_ozon_description, p.mp_wb_description, p.mp_ym_description
           FROM products p
           LEFT JOIN user_categories uc ON uc.id = p.user_category_id
           WHERE p.profile_id = $1 AND p.id = ANY($2::bigint[])
             AND LOWER(TRIM(COALESCE(p.product_type::text, 'product'))) <> 'kit'`;
    params = [store.profileId, ids];
  } else {
    sql = `SELECT p.id, p.sku, p.name, p.description, p.price, p.cost, p.additional_expenses, p.min_price,
                  p.images, p.quantity, p.user_category_id, uc.name AS category_name,
                  p.mp_ozon_description, p.mp_wb_description, p.mp_ym_description
           FROM products p
           LEFT JOIN user_categories uc ON uc.id = p.user_category_id
           WHERE p.profile_id = $1
             AND LOWER(TRIM(COALESCE(p.product_type::text, 'product'))) <> 'kit'
           ORDER BY COALESCE(uc.name, 'ЯЯЯ') ASC, p.name ASC
           LIMIT 500`;
    params = [store.profileId];
  }

  const r = await query(sql, params);
  const out = [];
  for (const row of r.rows || []) {
    const id = Number(row.id);
    const link = linkById.get(id) || null;
    if (store.productMode === 'selected' && !link) continue;
    const stock = await stockForProduct(id, warehouseId);
    out.push(mapPublicProduct(row, link, stock));
  }
  if (store.productMode === 'selected') {
    out.sort((a, b) => {
      const sa = linkById.get(a.id)?.sortOrder ?? 0;
      const sb = linkById.get(b.id)?.sortOrder ?? 0;
      return sa - sb || a.name.localeCompare(b.name, 'ru');
    });
  }
  return out;
}

async function resolveWarehouseId(profileId) {
  const profile = await loadProfile(profileId);
  const wh = profile?.manual_orders_warehouse_id ?? profile?.manualOrdersWarehouseId ?? null;
  const n = wh != null && wh !== '' ? Number(wh) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function getPublicStore(slug) {
  const store = await storesRepo.findPublishedBySlug(slug);
  if (!store) err('Магазин не найден или не опубликован', 404);
  return publicStorePayload(store);
}

/** Резолв витрины по Host (свой домен). Готов к nginx → тому же SPA. */
export async function getPublicStoreByHost(hostRaw) {
  const host = normalizeCustomDomain(hostRaw);
  if (!host) err('Укажите host', 400);
  const store = await storesRepo.findPublishedByCustomDomain(host);
  if (!store) err('Магазин для этого домена не найден', 404);
  // active — полноценно; pending — отдаём витрину, но статус виден в payload
  return {
    ...publicStorePayload(store),
    resolvedBy: 'custom_domain',
    host,
  };
}

export async function listPublicProducts(slug, { q = '', categoryId = '' } = {}) {
  const store = await storesRepo.findPublishedBySlug(slug);
  if (!store) err('Магазин не найден или не опубликован', 404);
  const allProducts = await catalogRowsForStore(store);
  const categories = await attachCategoryImages(
    store.profileId,
    buildPublicCategories(allProducts)
  );
  let products = allProducts;
  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    products = products.filter(
      (p) =>
        String(p.name || '')
          .toLowerCase()
          .includes(needle) ||
        String(p.sku || '')
          .toLowerCase()
          .includes(needle)
    );
  }
  const catRaw = String(categoryId || '').trim();
  if (catRaw === 'none') {
    products = products.filter((p) => p.categoryId == null);
  } else if (catRaw && /^\d+$/.test(catRaw)) {
    const cid = Number(catRaw);
    products = products.filter((p) => p.categoryId === cid);
  }
  return {
    store: publicStorePayload(store),
    products,
    categories,
  };
}

function pickPublicDescription(row) {
  const candidates = [
    row.description,
    row.mp_ozon_description,
    row.mp_wb_description,
    row.mp_ym_description,
  ];
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (s) return s;
  }
  return '';
}

function formatCertDocType(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'declaration') return 'Декларация';
  if (v === 'registration') return 'Свидетельство о регистрации';
  return 'Сертификат';
}

async function loadPublicAttributes(productId) {
  const r = await query(
    `SELECT pa.id, pa.name, pav.value
     FROM product_attribute_values pav
     JOIN product_attributes pa ON pa.id = pav.attribute_id
     WHERE pav.product_id = $1
       AND pav.value IS NOT NULL
       AND btrim(pav.value::text) <> ''
     ORDER BY pa.name ASC`,
    [productId]
  );
  return (r.rows || [])
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name || '').trim(),
      value: String(row.value || '').trim(),
    }))
    .filter((a) => a.name && a.value);
}

async function loadPublicCertificates(profileId, productId) {
  const r = await query(
    `SELECT c.id, c.certificate_number, c.document_type, c.valid_from, c.valid_to, c.photo_url
     FROM certificates c
     WHERE c.profile_id = $1
       AND (
         EXISTS (
           SELECT 1 FROM certificate_products cp
           WHERE cp.certificate_id = c.id AND cp.product_id = $2
         )
         OR EXISTS (
           SELECT 1
           FROM products p
           JOIN certificate_user_categories cuc
             ON cuc.certificate_id = c.id AND cuc.user_category_id = p.user_category_id
           WHERE p.id = $2
             AND p.profile_id = $1
             AND (c.brand_id IS NULL OR c.brand_id = p.brand_id)
         )
       )
     ORDER BY c.valid_to NULLS LAST, c.certificate_number`,
    [profileId, productId]
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return (r.rows || [])
    .map((row) => {
      const validTo = row.valid_to ? new Date(row.valid_to) : null;
      const expired = validTo ? validTo < today : false;
      let fileUrl = row.photo_url ? String(row.photo_url).trim() : '';
      if (fileUrl && !/^https?:\/\//i.test(fileUrl) && !fileUrl.startsWith('/')) {
        fileUrl = `/${fileUrl}`;
      }
      return {
        id: Number(row.id),
        number: row.certificate_number || '',
        documentType: formatCertDocType(row.document_type),
        validFrom: row.valid_from || null,
        validTo: row.valid_to || null,
        expired,
        fileUrl: fileUrl || null,
      };
    })
    .filter((c) => c.number || c.fileUrl);
}

function buildPublicSpecs(row) {
  const specs = [];
  const push = (name, value) => {
    if (value == null || value === '') return;
    specs.push({ name, value: String(value) });
  };
  if (row.sku) push('Артикул', row.sku);
  if (row.category_name) push('Категория', row.category_name);
  if (row.brand_name) push('Бренд', row.brand_name);
  if (row.country_of_origin) push('Страна', row.country_of_origin);
  if (row.unit) push('Ед. изм.', row.unit);
  const w = row.weight != null && row.weight !== '' ? Number(row.weight) : NaN;
  if (Number.isFinite(w) && w > 0) push('Вес', `${w} кг`);
  const L = row.length != null ? Number(row.length) : NaN;
  const W = row.width != null ? Number(row.width) : NaN;
  const H = row.height != null ? Number(row.height) : NaN;
  if ([L, W, H].some((n) => Number.isFinite(n) && n > 0)) {
    const dims = [L, W, H]
      .map((n) => (Number.isFinite(n) && n > 0 ? String(n) : '—'))
      .join(' × ');
    push('Габариты (Д×Ш×В), мм', dims);
  }
  return specs;
}

export async function getPublicProduct(slug, productId) {
  const store = await storesRepo.findPublishedBySlug(slug);
  if (!store) err('Магазин не найден или не опубликован', 404);
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) err('Товар не найден в магазине', 404);

  // Доступность на витрине (режим selected / kit)
  const listed = await catalogRowsForStore(store);
  const listedHit = listed.find((p) => p.id === pid);
  if (!listedHit) err('Товар не найден в магазине', 404);

  const r = await query(
    `SELECT p.id, p.sku, p.name, p.description, p.price, p.cost, p.additional_expenses, p.min_price,
            p.images, p.quantity, p.user_category_id, p.brand_id, p.unit, p.weight,
            p.length, p.width, p.height, p.country_of_origin,
            p.mp_ozon_description, p.mp_wb_description, p.mp_ym_description,
            uc.name AS category_name, b.name AS brand_name
     FROM products p
     LEFT JOIN user_categories uc ON uc.id = p.user_category_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.id = $1 AND p.profile_id = $2
     LIMIT 1`,
    [pid, store.profileId]
  );
  const row = r.rows?.[0];
  if (!row) err('Товар не найден в магазине', 404);

  const links =
    store.productMode === 'selected' ? await storesRepo.listStoreProductLinks(store.id) : [];
  const link = links.find((l) => l.productId === pid && l.published) || null;
  const warehouseId = await resolveWarehouseId(store.profileId);
  const stock = await stockForProduct(pid, warehouseId);
  const base = mapPublicProduct(row, link, stock);
  const [attributes, certificates] = await Promise.all([
    loadPublicAttributes(pid),
    loadPublicCertificates(store.profileId, pid),
  ]);

  return {
    store: publicStorePayload(store),
    product: {
      ...base,
      ...listedHit,
      description: pickPublicDescription(row),
      specs: buildPublicSpecs(row),
      attributes,
      certificates,
    },
  };
}

export async function checkout(slug, body = {}) {
  const store = await storesRepo.findPublishedBySlug(slug);
  if (!store) err('Магазин не найден или не опубликован', 404);

  const profile = await loadProfile(store.profileId);
  if (!profile || profile.allow_private_orders !== true) {
    err('Приём заказов временно недоступен', 403);
  }
  const warehouseId = await resolveWarehouseId(store.profileId);
  if (!warehouseId) err('Магазин ещё не настроен (склад)', 400);

  const customerName = String(body.customerName || body.name || '').trim();
  const customerPhone = String(body.customerPhone || body.phone || '').trim();
  const customerEmail = String(body.customerEmail || body.email || '').trim();
  const customerAddress = String(body.customerAddress || body.address || '').trim();
  if (!customerName) err('Укажите имя');
  if (!customerPhone) err('Укажите телефон');

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) err('Корзина пуста');

  const catalog = await catalogRowsForStore(store);
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const parsedItems = [];
  for (const it of rawItems) {
    const productId = Number(it.productId ?? it.product_id);
    const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
    const product = byId.get(productId);
    if (!product) err(`Товар #${productId} недоступен`);
    if (!product.inStock || product.stock < qty) {
      err(`Недостаточно остатка: ${product.name}`);
    }
    parsedItems.push({ productId, quantity: qty, price: product.price });
  }

  let customerId = null;
  const byPhone = await customersRepo.findByPhone(store.profileId, customerPhone);
  if (byPhone) {
    customerId = Number(byPhone.id);
    try {
      await customersRepo.update(customerId, store.profileId, {
        name: customerName,
        email: customerEmail || undefined,
        address: customerAddress || undefined,
        source: byPhone.source || 'Интернет-магазин',
      });
    } catch {
      /* ignore update conflicts */
    }
  } else {
    const created = await customersRepo.create(store.profileId, {
      name: customerName,
      phone: customerPhone,
      email: customerEmail,
      address: customerAddress,
      source: 'Интернет-магазин',
    });
    customerId = Number(created.id);
  }

  const { orderGroupId, orders } = await ordersService.createManualWithItems(parsedItems, {
    profileId: store.profileId,
    customerName,
    customerPhone,
    customerId,
    warehouseId,
  });

  return {
    orderGroupId,
    orderCount: orders.length,
    total: parsedItems.reduce((s, it) => s + it.price * it.quantity, 0),
    storeName: store.name,
  };
}

export default {
  listTemplates,
  getAdminStore,
  saveAdminStore,
  getPublicStore,
  getPublicStoreByHost,
  listPublicProducts,
  getPublicProduct,
  checkout,
};
