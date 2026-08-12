/**
 * Сбор контента карточки из PartsIndex по brand + артикул.
 * OpenAPI: https://api.parts-index.com/docs/ru/openapi.yml
 */

import { getPartsIndexConfig, normalizePartsIndexKeys } from '../config/partsindex.config.js';
import {
  PartsIndexError,
  getEntities,
  getBrandsByPartCode,
  parseBrand,
  getRelations,
  getCarsByPart,
} from './partsindex.client.js';

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function normToken(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9А-ЯЁ]/gi, '')
    .replace(/Ё/g, 'Е');
}

function brandScore(a, b) {
  const x = normToken(a);
  const y = normToken(b);
  if (!x || !y) return 0;
  if (x === y) return 100;
  if (x.includes(y) || y.includes(x)) return 80;
  return 0;
}

function parseNumberLoose(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(',', '.').replace(/[^\d.-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Вес → граммы */
function weightToGrams(value, unitHint = '') {
  const n = parseNumberLoose(value);
  if (n == null) return null;
  const u = String(unitHint || '').toLowerCase();
  if (u.includes('кг') || u.includes('kg')) return Math.round(n * 1000);
  if (u.includes('г') || u.includes('g') || !u) {
    return n < 50 && !u.includes('г') && !u.includes('g') ? Math.round(n * 1000) : Math.round(n);
  }
  return Math.round(n);
}

/** Длина → мм */
function lengthToMm(value, unitHint = '') {
  const n = parseNumberLoose(value);
  if (n == null) return null;
  const u = String(unitHint || '').toLowerCase();
  if (u.includes('см') || u === 'cm') return Math.round(n * 10);
  if ((u.includes('м') || u === 'm') && !u.includes('мм') && !u.includes('см')) {
    return Math.round(n * 1000);
  }
  if (u.includes('мм') || u === 'mm') return Math.round(n);
  return n > 0 && n < 20 ? Math.round(n * 10) : Math.round(n);
}

/**
 * @param {object} entity EntityByCodeBrand
 */
export function mapPartsIndexEntityToContent(entity) {
  const content = {
    name: null,
    description: null,
    info: null,
    statusText: null,
    packUnit: null,
    quantityPerUnit: null,
    weight: null,
    length: null,
    width: null,
    height: null,
    barcodes: [],
    oemNumbers: [],
    images: [],
    documents: [],
    links: [],
    media360: [],
    attributes: [],
    searchHits: [],
    article: null,
    applicability: [],
    analogs: [],
    rawByMethod: {},
  };

  if (!entity || typeof entity !== 'object') return content;

  const nameObj = entity.name;
  content.name = pickFirstNonEmpty(
    entity.originalName,
    typeof nameObj === 'object' ? nameObj?.name : nameObj,
    entity.code
  );
  content.description = pickFirstNonEmpty(entity.description) || null;
  content.barcodes = [
    ...new Set((Array.isArray(entity.barcodes) ? entity.barcodes : []).map((b) => String(b).trim()).filter(Boolean)),
  ];
  content.article = {
    id: entity.id ?? null,
    code: entity.code ?? null,
    brand: entity.brand?.name ?? null,
    brandId: entity.brand?.id ?? null,
    originalName: entity.originalName ?? null,
    groups: entity.groups ?? null,
  };

  for (const img of Array.isArray(entity.images) ? entity.images : []) {
    const url = typeof img === 'string' ? img : img?.url || img?.src || '';
    if (url) content.images.push({ url, source: 'partsindex' });
  }

  for (const link of Array.isArray(entity.links) ? entity.links : []) {
    if (!link) continue;
    const code = pickFirstNonEmpty(link.code);
    const brand = pickFirstNonEmpty(link.brand?.name);
    if (code) content.oemNumbers.push(brand ? `${brand}: ${code}` : code);
  }
  content.oemNumbers = [...new Set(content.oemNumbers)];

  const attrs = [];
  for (const group of Array.isArray(entity.parameters) ? entity.parameters : []) {
    for (const p of Array.isArray(group?.params) ? group.params : []) {
      const title = pickFirstNonEmpty(p.title, p.name, p.code) || 'param';
      const unit = pickFirstNonEmpty(p.unit);
      const values = Array.isArray(p.values)
        ? p.values.map((v) => pickFirstNonEmpty(v?.value, v)).filter(Boolean)
        : [];
      const value = values.join('; ') || pickFirstNonEmpty(p.value);
      if (!value) continue;
      const display = unit ? `${value} ${unit}` : value;
      attrs.push({ name: title, value: display, unit: unit || null });

      const t = title.toLowerCase();
      if (/вес|weight|масса|mass/.test(t) && content.weight == null) {
        content.weight = weightToGrams(value, unit || title);
      }
      if (/длин|length|длина/.test(t) && content.length == null) {
        content.length = lengthToMm(value, unit || title);
      }
      if (/ширин|width|ширина/.test(t) && content.width == null) {
        content.width = lengthToMm(value, unit || title);
      }
      if (/высот|height|высота/.test(t) && content.height == null) {
        content.height = lengthToMm(value, unit || title);
      }
    }
  }
  content.attributes = attrs;
  if (!content.description && attrs.length) {
    content.description = attrs.map((a) => `${a.name}: ${a.value}`).join('\n');
  }

  return content;
}

function pickEntity(list, brand, sku) {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return null;
  const skuN = normToken(sku);
  const scored = rows
    .map((row) => {
      const codeN = normToken(row.code);
      const bScore = brandScore(brand, row.brand?.name);
      let score = bScore;
      if (codeN && skuN && codeN === skuN) score += 50;
      else if (codeN && skuN && (codeN.includes(skuN) || skuN.includes(codeN))) score += 20;
      return { row, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 40) return null;
  return best.row;
}

/**
 * @param {string} brand
 * @param {string} sku
 * @param {{ apiKey?: string }|string|null} profileKeys
 */
export async function collectPartsIndexContent(brand, sku, profileKeys) {
  const keys = normalizePartsIndexKeys(profileKeys);
  const cfg = getPartsIndexConfig(keys);
  if (!cfg.apiKey) {
    const e = new Error('Нужен API-ключ PartsIndex');
    e.statusCode = 400;
    throw e;
  }

  const steps = [];
  const warnings = [];
  const opts = { apiKey: cfg.apiKey, lang: cfg.lang };
  let matchedBrand = brand;
  let matchedNumber = sku;
  let entityId = null;

  // Нормализация бренда (необязательно)
  try {
    const parsed = await parseBrand(brand, opts);
    steps.push({ method: 'brands/parse', ok: true });
    if (parsed.brand?.name) matchedBrand = parsed.brand.name;
  } catch (err) {
    steps.push({ method: 'brands/parse', ok: false, error: err?.message || String(err) });
    // не критично
  }

  let list = [];
  let entitiesRaw = null;
  try {
    const res = await getEntities(sku, matchedBrand || brand, opts);
    list = res.list || [];
    entitiesRaw = res.raw;
    steps.push({ method: 'entities', ok: true, count: list.length });
  } catch (err) {
    const e = new Error(`PartsIndex entities: ${err?.message || err}`);
    e.statusCode = err instanceof PartsIndexError ? err.status || 502 : 502;
    throw e;
  }

  // Если по бренду пусто — список брендов по артикулу и повтор
  if (!list.length) {
    try {
      const brandsRes = await getBrandsByPartCode(sku, opts);
      steps.push({ method: 'brands/by-part-code', ok: true, count: brandsRes.list.length });
      const brandHit = (brandsRes.list || [])
        .map((b) => ({ b, score: brandScore(brand, b.name) }))
        .sort((a, c) => c.score - a.score)[0];
      if (brandHit && brandHit.score >= 50) {
        matchedBrand = brandHit.b.name || matchedBrand;
        const retry = await getEntities(sku, matchedBrand, opts);
        list = retry.list || [];
        entitiesRaw = retry.raw;
        steps.push({ method: 'entities:retry', ok: true, count: list.length });
      }
    } catch (err) {
      steps.push({
        method: 'brands/by-part-code',
        ok: false,
        error: err?.message || String(err),
      });
      warnings.push(`brands/by-part-code: ${err?.message || err}`);
    }
  }

  const entity = pickEntity(list, matchedBrand || brand, sku) || list[0] || null;
  if (!entity) {
    const e = new Error('Не найдено в PartsIndex по бренду и артикулу');
    e.statusCode = 404;
    throw e;
  }

  const content = mapPartsIndexEntityToContent(entity);
  content.rawByMethod.entities = entitiesRaw;
  content.searchHits = list.slice(0, 20).map((r) => ({
    id: r.id ?? null,
    number: r.code ?? null,
    brand: r.brand?.name ?? null,
    name: pickFirstNonEmpty(r.originalName, r.name?.name),
  }));

  entityId = entity.id != null ? String(entity.id) : null;
  matchedBrand = pickFirstNonEmpty(entity.brand?.name, matchedBrand, brand);
  matchedNumber = pickFirstNonEmpty(entity.code, matchedNumber, sku);

  // Аналоги / связанные детали — GET /v1/relations (scope: access + relations)
  try {
    const rel = await getRelations(
      { id: entityId || undefined, code: matchedNumber, brand: matchedBrand },
      opts
    );
    content.rawByMethod.relations = rel.raw;
    content.analogs = (rel.list || []).slice(0, 100).map((r) => ({
      id: r.id ?? null,
      code: r.code ?? null,
      brand: r.brand?.name ?? null,
      brandId: r.brand?.id ?? null,
      relation: r.relation ?? null,
    }));
    for (const a of content.analogs) {
      if (a.code) {
        content.oemNumbers.push(a.brand ? `${a.brand}: ${a.code}` : a.code);
      }
    }
    content.oemNumbers = [...new Set(content.oemNumbers)];
    steps.push({ method: 'relations', ok: true, count: content.analogs.length });
  } catch (err) {
    const msg = err?.message || String(err);
    steps.push({ method: 'relations', ok: false, error: msg });
    if (/403|Deny|access deny|scope/i.test(msg)) {
      warnings.push(
        'relations: нет доступа (нужен scope «relations» в ключе PartsIndex)'
      );
    } else {
      warnings.push(`relations: ${msg}`);
    }
  }

  // Применимость — GET /v1/cars (scope: access + old-apply)
  try {
    const cars = await getCarsByPart(matchedNumber, matchedBrand, opts);
    content.rawByMethod.cars = cars.raw;
    content.applicability = (cars.list || []).slice(0, 200).map((c) => {
      const from = c.dateFrom ?? c.yearBegin ?? c.yearFrom ?? null;
      const to = c.dateTo ?? c.yearEnd ?? c.yearTo ?? null;
      const years =
        pickFirstNonEmpty(
          c.years,
          c.year,
          from != null || to != null ? [from, to].filter((v) => v != null).join('-') : null
        ) || null;
      return {
        brand: c.brand ?? null,
        model: c.model ?? null,
        modif: c.modif ?? null,
        years,
        dateFrom: from,
        dateTo: to,
        body: c.body ?? null,
        engCode: c.engCode ?? null,
        hp: c.hp ?? null,
        kw: c.kw ?? null,
        cc: c.cc ?? null,
      };
    });
    steps.push({ method: 'cars', ok: true, count: content.applicability.length });
  } catch (err) {
    const msg = err?.message || String(err);
    steps.push({ method: 'cars', ok: false, error: msg });
    if (/403|Deny|access deny|scope/i.test(msg)) {
      warnings.push(
        'cars: нет доступа (нужен scope «old-apply» в ключе PartsIndex)'
      );
    } else {
      warnings.push(`cars: ${msg}`);
    }
  }

  const filled = [];
  if (content.name) filled.push('name');
  if (content.description) filled.push('description');
  if (content.weight != null) filled.push('weight');
  if (content.length != null) filled.push('length');
  if (content.width != null) filled.push('width');
  if (content.height != null) filled.push('height');
  if (content.barcodes.length) filled.push('barcodes');
  if (content.oemNumbers.length) filled.push('oem');
  if (content.images.length) filled.push('images');
  if (content.attributes.length) filled.push('attributes');
  if (content.analogs.length) filled.push('analogs');
  if (content.applicability.length) filled.push('applicability');

  return {
    entityId,
    matchedBrand,
    matchedNumber,
    content,
    filled,
    warnings,
    steps,
    methodsUsed: steps.filter((s) => s.ok).map((s) => s.method),
    status: filled.length >= 3 ? 'full' : filled.length ? 'partial' : 'not_found',
  };
}

export default {
  collectPartsIndexContent,
  mapPartsIndexEntityToContent,
};
