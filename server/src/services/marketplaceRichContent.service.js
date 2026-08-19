/**
 * Сборка тестового Rich-контента из карточки товара ERP.
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
import integrationsService from './integrations.service.js';
import {
  parseUserCategoryMarketplaceMappings,
  extractOzonDescTypeForCache,
} from './productsExport.service.js';
import { getProductImageUrlsForMarketplace } from './marketplaceProductImages.service.js';
import { resolveCardTextForPush } from '../utils/productMpFieldLinks.js';
import { categoryRichContentTemplatesRepository } from '../repositories/categoryRichContentTemplates.repository.pg.js';
import {
  resolveRichModulesForRender,
  normalizeRichContentModules,
  parseStoredRichContentModules,
} from '../utils/richContentTemplate.js';
import {
  asText,
  stripDictArrow,
  buildOzonRichContentJson,
  buildOzonRichContentFromResolved,
  stringifyOzonRichContent,
  buildWbStructuredDescription,
  buildYmStructuredDescription,
  buildStructuredDescriptionFromResolved,
  shouldSkipOzonAttrForRichTable,
  shouldSkipWbCharcForRichTable,
  OZON_RICH_CONTENT_ATTR_ID,
} from '../utils/marketplaceRichContent.js';

const productsRepo = () => repositoryFactory.getProductsRepository();

function parseJsonObject(v) {
  if (v == null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return { ...v };
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

function mergeProductPatch(product, patch) {
  if (!patch || typeof patch !== 'object') return product;
  const next = { ...product };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (
      k === 'ozon_attributes' ||
      k === 'wb_attributes' ||
      k === 'ym_attributes' ||
      k === 'mp_field_links'
    ) {
      next[k] = { ...parseJsonObject(product[k]), ...parseJsonObject(v) };
      continue;
    }
    next[k] = v;
  }
  return next;
}

function attrId(item) {
  return item?.id ?? item?.attribute_id ?? item?.charcID ?? item?.characteristic_id ?? item?.parameterId;
}

function attrName(item) {
  return item?.name ?? item?.charcName ?? item?.characteristic_name ?? item?.parameterName ?? '';
}

function rawToIdAndText(raw) {
  if (raw == null || raw === '') return { id: null, text: '' };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const did = raw.dictionary_value_id ?? (raw.value == null ? raw.id : null);
    const text = stripDictArrow(asText(raw.value ?? raw.name ?? raw.text ?? ''));
    const id = did != null && String(did).trim() !== '' ? String(did).trim() : null;
    return { id, text };
  }
  const s = String(raw).trim();
  const arrow = s.indexOf('->');
  if (arrow > 0) {
    return { text: s.slice(0, arrow).trim(), id: s.slice(arrow + 2).trim() || null };
  }
  if (/^\d+$/.test(s)) return { id: s, text: '' };
  return { id: null, text: s };
}

function displayAttrValue(raw) {
  const { id, text } = rawToIdAndText(raw);
  if (text && !/^\d+$/.test(text)) return text;
  return text || id || '';
}

function splitDictTokens(value) {
  return String(value || '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ozonAttrHasDictionary(item) {
  if (!item || typeof item !== 'object') return false;
  for (const k of ['dictionary_id', 'attribute_dictionary_id', 'dictionaryId', 'dictionaryID']) {
    const n = Number(item[k]);
    if (Number.isFinite(n) && n !== 0) return true;
  }
  return false;
}

function ozonDictOptionLabel(opt) {
  return String(opt?.value ?? opt?.info ?? opt?.title ?? opt?.name ?? '').trim();
}

async function resolveOzonCharacteristicLabels(pairs, schema, mm, ctx) {
  if (!Array.isArray(pairs) || pairs.length === 0) return pairs;
  const { descId, typeId } = extractOzonDescTypeForCache(mm || {});
  if (descId <= 0 || typeId <= 0) return pairs;

  const byId = new Map();
  const byName = new Map();
  for (const item of schema || []) {
    if (!ozonAttrHasDictionary(item)) continue;
    const id = attrId(item);
    if (id == null) continue;
    byId.set(String(id), item);
    const n = String(attrName(item) || '').trim().toLowerCase();
    if (n) byName.set(n, item);
  }

  const needed = new Set();
  const annotated = pairs.map((row) => {
    const item = (row.id != null && byId.get(String(row.id))) || byName.get(String(row.name || '').toLowerCase());
    const tokens = splitDictTokens(row.value);
    const needs = Boolean(item && tokens.length && tokens.every((t) => /^\d+$/.test(t)));
    if (needs) needed.add(String(attrId(item)));
    return { row, item, tokens, needs };
  });
  if (needed.size === 0) return pairs;

  const dictByAttr = new Map();
  await Promise.all(
    [...needed].map(async (aid) => {
      try {
        const res = await integrationsService.getOzonAttributeValues(aid, descId, typeId, {
          limit: 500,
          profileId: ctx.profileId ?? null,
          organizationId: ctx.organizationId ?? null,
        });
        dictByAttr.set(aid, Array.isArray(res?.result) ? res.result : []);
      } catch {
        dictByAttr.set(aid, []);
      }
    })
  );

  const optId = (o) => String(o?.id ?? o?.dictionary_value_id ?? '').trim();
  return annotated.map(({ row, item, tokens, needs }) => {
    if (!needs || !item) return row;
    const opts = dictByAttr.get(String(attrId(item))) || [];
    const labels = tokens.map((vid) => {
      const hit = opts.find((o) => optId(o) === String(vid));
      return ozonDictOptionLabel(hit) || vid;
    });
    const joined = labels.join(', ');
    if (!joined) return row;
    return { ...row, value: joined };
  });
}

function pairsFromOverride(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (const row of list) {
    const name = String(row?.name || '').trim();
    const value = displayAttrValue(row?.value);
    if (!name || !value) continue;
    const id = row.id != null && String(row.id).trim() !== '' ? String(row.id) : undefined;
    out.push(id ? { id, name, value } : { name, value });
  }
  return out.length ? out : null;
}

function pairsFromStored(stored, schema, { skip } = {}) {
  const obj = parseJsonObject(stored);
  const nameById = new Map();
  for (const item of schema || []) {
    const id = attrId(item);
    if (id == null) continue;
    nameById.set(String(id), String(attrName(item) || '').trim());
  }
  const out = [];
  for (const [id, raw] of Object.entries(obj)) {
    const name = nameById.get(String(id)) || '';
    if (typeof skip === 'function' && skip(id, name)) continue;
    const value = displayAttrValue(raw);
    if (!value) continue;
    out.push({ id: String(id), name: name || `ID ${id}`, value });
  }
  return out;
}

async function loadCategoryMappings(userCategoryId) {
  if (userCategoryId == null || userCategoryId === '') return {};
  const r = await query(`SELECT marketplace_mappings FROM user_categories WHERE id = $1`, [
    userCategoryId,
  ]);
  return parseUserCategoryMarketplaceMappings(r.rows[0]?.marketplace_mappings);
}

async function loadOzonSchema(mm, ctx) {
  try {
    const { descId, typeId } = extractOzonDescTypeForCache(mm || {});
    if (descId <= 0 || typeId <= 0) return [];
    const list = await integrationsService.getOzonCategoryAttributes(descId, typeId, {
      profileId: ctx.profileId ?? null,
      organizationId: ctx.organizationId ?? null,
    });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function loadWbSchema(mm, ctx) {
  try {
    const subject =
      mm?.wb ??
      mm?.wildberries ??
      mm?.wb_subject_id ??
      mm?.wbSubjectId ??
      mm?.subjectId ??
      mm?.subject_id;
    const m = String(subject ?? '').trim().match(/^(\d+)/);
    const subjectId = m ? Number(m[1]) : 0;
    if (!Number.isFinite(subjectId) || subjectId <= 0) return [];
    const list = await integrationsService.getWildberriesCategoryAttributes(subjectId, {
      profileId: ctx.profileId ?? null,
      organizationId: ctx.organizationId ?? null,
    });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function loadYmSchema(mm, ctx) {
  try {
    const raw = mm?.ym ?? mm?.yandex ?? mm?.ym_category_id ?? mm?.marketCategoryId;
    const catId = String(raw || '').trim();
    if (!/^\d+$/.test(catId)) return [];
    const list = await integrationsService.getYandexCategoryContentParameters(catId, {
      profileId: ctx.profileId ?? null,
      organizationId: ctx.organizationId ?? null,
    });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function cardInput(product, mp, characteristics, imageUrls) {
  return {
    name:
      resolveCardTextForPush(product, mp, 'name') ||
      String(product.name || '').trim() ||
      '',
    brand:
      resolveCardTextForPush(product, mp, 'brand') ||
      String(product.brand || '').trim() ||
      '',
    sku:
      mp === 'ozon'
        ? String(product.sku_ozon || product.sku || '').trim()
        : mp === 'wb'
          ? String(product.mp_wb_vendor_code || product.sku_wb || product.sku || '').trim()
          : String(product.sku_ym || product.sku || '').trim(),
    description:
      resolveCardTextForPush(product, mp, 'description') ||
      String(product.description || '').trim() ||
      '',
    characteristics,
    imageUrls,
  };
}

function ctxFromCard(input) {
  const characteristics = input.characteristics || [];
  const attrsById = new Map();
  const attrsByName = new Map();
  for (const row of characteristics) {
    if (row?.id != null) attrsById.set(String(row.id), row);
    if (row?.name) attrsByName.set(String(row.name).toLowerCase(), row);
  }
  return { ...input, attrsById, attrsByName };
}

function normalizeMpList(marketplace) {
  if (Array.isArray(marketplace)) {
    const list = [...new Set(
      marketplace
        .map((x) => String(x || '').toLowerCase().trim())
        .filter((m) => m === 'ozon' || m === 'wb' || m === 'ym')
    )];
    if (list.length) return list;
  }
  const m = String(marketplace || 'all').toLowerCase().trim();
  if (m === 'all') return ['ozon', 'wb', 'ym'];
  if (m.includes(',')) {
    const list = [...new Set(
      m.split(',').map((x) => x.trim()).filter((x) => x === 'ozon' || x === 'wb' || x === 'ym')
    )];
    if (list.length) return list;
  }
  if (m === 'wildberries') return ['wb'];
  if (m === 'yandex' || m === 'yandexmarket') return ['ym'];
  if (m === 'ozon' || m === 'wb' || m === 'ym') return [m];
  const err = new Error('Неизвестный маркетплейс. Допустимо: ozon, wb, ym, all.');
  err.statusCode = 400;
  throw err;
}

/**
 * @param {number|string} productId
 * @param {{ marketplace?: string, productPatch?: object|null, profileId?: * }} [options]
 */
export async function generateMarketplaceRichContent(productId, options = {}) {
  const product = await productsRepo().findById(productId);
  if (!product) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }
  const merged = mergeProductPatch(product, options.productPatch);
  const mps = normalizeMpList(options.marketplace);
  const ctx = {
    profileId: options.profileId ?? merged.profile_id ?? null,
    organizationId: merged.organization_id ?? merged.organizationId ?? null,
  };
  const categoryId = merged.user_category_id ?? merged.categoryId ?? merged.category_id;
  const mm = await loadCategoryMappings(categoryId);
  const override = options.characteristics && typeof options.characteristics === 'object'
    ? options.characteristics
    : {};
  let template = null;
  const draftModules = Array.isArray(options.modules) ? normalizeRichContentModules(options.modules) : null;
  const productModules = parseStoredRichContentModules(merged.rich_content_modules ?? merged.richContentModules);
  if (draftModules) {
    template = { modules: draftModules, source: 'draft' };
  } else if (productModules) {
    template = { modules: productModules, source: 'product' };
  } else if (categoryId) {
    try {
      template = await categoryRichContentTemplatesRepository.findByCategoryId(
        categoryId,
        ctx.profileId
      );
    } catch {
      template = null;
    }
  }
  const templateModules = template?.modules?.length ? template.modules : null;
  const templateNote = !templateModules
    ? 'Базовая вёрстка (шаблона нет).'
    : template.source === 'draft'
      ? 'Черновик шаблона.'
      : template.source === 'product'
        ? 'Шаблон этого товара (переопределяет шаблон категории).'
        : template.source === 'shared'
          ? 'Шаблон категории.'
          : template.category_name
            ? `Шаблон категории «${template.category_name}».`
            : 'Шаблон категории.';

  const result = { marketplace: mps.length === 1 ? mps[0] : 'all', ozon: null, wb: null, ym: null, template: Boolean(templateModules) };

  if (mps.includes('ozon')) {
    const schema = await loadOzonSchema(mm, ctx);
    const characteristics = await resolveOzonCharacteristicLabels(
      pairsFromOverride(override.ozon) ||
        pairsFromStored(merged.ozon_attributes, schema, {
          skip: shouldSkipOzonAttrForRichTable,
        }) ||
        [],
      schema,
      mm,
      ctx
    );
    const imageUrls = getProductImageUrlsForMarketplace(merged, 'ozon');
    const input = cardInput(merged, 'ozon', characteristics, imageUrls);
    const previewBlocks = templateModules
      ? resolveRichModulesForRender(templateModules, ctxFromCard(input))
      : null;
    const json = previewBlocks
      ? buildOzonRichContentFromResolved(previewBlocks)
      : buildOzonRichContentJson(input);
    const jsonString = stringifyOzonRichContent(json);
    const publicImages = json.content.find((w) => w.widgetName === 'raShowcase')?.blocks?.length || 0;
    const notes = [
      templateNote,
      `Ozon: атрибут ${OZON_RICH_CONTENT_ATTR_ID} (Rich-контент JSON).`,
    ];
    if (previewBlocks?.some((b) => b.style?.background || b.style?.backgroundImage || b.style?.font === 'serif')) {
      notes.push(
        'Фон (цвет и картинка) и семейство шрифта видны в предпросмотре ERP; на Ozon уходят размер, выравнивание и цвет (тёмный/серый).'
      );
    }
    if (!publicImages && imageUrls.length) {
      notes.push('Фото не попали в виджет: нужны публичные https-URL (не localhost).');
    }
    result.ozon = {
      attributeId: OZON_RICH_CONTENT_ATTR_ID,
      json,
      jsonString,
      widgets: json.content.length,
      characteristics: characteristics.length,
      images: publicImages,
      previewBlocks,
      notes,
    };
  }

  if (mps.includes('wb')) {
    const schema = await loadWbSchema(mm, ctx);
    const characteristics =
      pairsFromOverride(override.wb) ||
      pairsFromStored(merged.wb_attributes, schema, {
        skip: shouldSkipWbCharcForRichTable,
      });
    const input = cardInput(merged, 'wb', characteristics, []);
    const previewBlocks = templateModules
      ? resolveRichModulesForRender(templateModules, ctxFromCard(input))
      : null;
    const description = previewBlocks
      ? buildStructuredDescriptionFromResolved(previewBlocks)
      : buildWbStructuredDescription(input);
    result.wb = {
      description,
      characteristics: characteristics.length,
      previewBlocks,
      notes: [
        templateNote,
        'Wildberries Content API не принимает Rich JSON — заполняем структурированное описание.',
      ],
    };
  }

  if (mps.includes('ym')) {
    const schema = await loadYmSchema(mm, ctx);
    const characteristics =
      pairsFromOverride(override.ym) ||
      pairsFromStored(merged.ym_attributes, schema, {
        skip: (_id, name) => shouldSkipOzonAttrForRichTable(null, name),
      });
    const input = cardInput(merged, 'ym', characteristics, []);
    const previewBlocks = templateModules
      ? resolveRichModulesForRender(templateModules, ctxFromCard(input))
      : null;
    const description = previewBlocks
      ? buildStructuredDescriptionFromResolved(previewBlocks)
      : buildYmStructuredDescription(input);
    result.ym = {
      description,
      characteristics: characteristics.length,
      previewBlocks,
      notes: [
        templateNote,
        'Яндекс.Маркет принимает обычное описание — заполняем структурированный текст из карточки.',
      ],
    };
  }

  return result;
}

export default { generateMarketplaceRichContent };
