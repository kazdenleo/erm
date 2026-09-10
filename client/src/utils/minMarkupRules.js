/**
 * Правила градации мин. наценки (profile.price_push_settings.minMarkupRules).
 * Наценка в ₽: mode=rub → value; mode=percent → cost * value / 100.
 */

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parsePositiveIntList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0))];
}

function parseCategoryIdList(raw) {
  if (raw == null || raw === '') return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return [...new Set(arr.map((v) => String(v).trim()).filter(Boolean))];
}

function newRuleId() {
  return `mmr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyMinMarkupRule() {
  return {
    id: newRuleId(),
    enabled: true,
    name: '',
    scope: 'all',
    categoryIds: [],
    productIds: [],
    excludeProductIds: [],
    tiers: [{ costFrom: 0, costTo: null, mode: 'rub', value: 50, minRub: null }],
  };
}

export function parseMinMarkupTier(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return [{ costFrom: 0, costTo: null, mode: 'rub', value: 50, minRub: null }];
  }
  const tiers = raw
    .map((t) => {
      if (!t || typeof t !== 'object') return null;
      const costFrom = Math.max(0, numOrNull(t.costFrom ?? t.cost_from) ?? 0);
      const costToRaw = t.costTo ?? t.cost_to;
      const costTo =
        costToRaw == null || costToRaw === ''
          ? null
          : Math.max(0, numOrNull(costToRaw) ?? 0);
      const mode = String(t.mode || t.type || 'rub').toLowerCase() === 'percent' ? 'percent' : 'rub';
      const value = numOrNull(t.value);
      if (value == null || value < 0) return null;
      const minRubRaw = t.minRub ?? t.min_rub ?? t.notLessThan ?? t.not_less_than;
      const minRubParsed = numOrNull(minRubRaw);
      const minRub =
        minRubParsed == null || minRubParsed < 0 ? null : Math.round(minRubParsed);
      return { costFrom, costTo, mode, value, minRub };
    })
    .filter(Boolean);
  return tiers.length ? tiers.sort((a, b) => a.costFrom - b.costFrom) : [{ costFrom: 0, costTo: null, mode: 'rub', value: 50, minRub: null }];
}

export function parseMinMarkupRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const scopeRaw = String(r.scope || 'all').trim();
      const scope =
        scopeRaw === 'categories' || scopeRaw === 'products' ? scopeRaw : 'all';
      return {
        id: r.id != null && String(r.id).trim() !== '' ? String(r.id) : newRuleId(),
        enabled: r.enabled !== false,
        name: r.name != null ? String(r.name).trim() : '',
        scope,
        categoryIds: scope === 'categories' ? parseCategoryIdList(r.categoryIds) : [],
        productIds: scope === 'products' ? parsePositiveIntList(r.productIds) : [],
        excludeProductIds: parsePositiveIntList(r.excludeProductIds ?? r.exclude_product_ids),
        tiers: parseMinMarkupTier(r.tiers),
      };
    })
    .filter(Boolean);
}

function productCategoryKey(product) {
  const catRaw = product?.user_category_id ?? product?.userCategoryId ?? null;
  if (catRaw == null || String(catRaw).trim() === '') return '__no_category__';
  return String(catRaw).trim();
}

function ruleMatchesProduct(rule, product) {
  if (!rule?.enabled) return false;
  const productId = Number(product?.id ?? product?.product_id);
  if (!Number.isFinite(productId) || productId < 1) return false;
  if (rule.excludeProductIds?.includes(productId)) return false;

  if (rule.scope === 'products') {
    return rule.productIds.includes(productId);
  }
  if (rule.scope === 'categories') {
    return rule.categoryIds.includes(productCategoryKey(product));
  }
  return true; // all
}

function ruleSpecificity(rule) {
  if (rule.scope === 'products') return 300;
  if (rule.scope === 'categories') return 200;
  return 100;
}

function pickTier(tiers, cost) {
  const c = Math.max(0, Number(cost) || 0);
  for (const tier of tiers || []) {
    const from = Number(tier.costFrom) || 0;
    const to = tier.costTo == null ? null : Number(tier.costTo);
    if (c < from) continue;
    if (to != null && Number.isFinite(to) && c >= to) continue;
    return tier;
  }
  return null;
}

/** Сколько ₽ мин. наценки даёт правило для себестоимости. */
export function markupRubFromTier(cost, tier) {
  if (!tier) return null;
  const value = numOrNull(tier.value);
  if (value == null || value < 0) return null;
  let rub;
  if (tier.mode === 'percent') {
    const c = Math.max(0, Number(cost) || 0);
    rub = Math.max(0, Math.round((c * value) / 100));
  } else {
    rub = Math.max(0, Math.round(value));
  }
  const floor = numOrNull(tier.minRub ?? tier.min_rub);
  if (floor != null && floor >= 0) {
    rub = Math.max(rub, Math.round(floor));
  }
  return rub;
}

/**
 * @returns {{ rub: number, ruleId: string, tier: object } | null}
 */
export function resolveMinMarkupFromRules(product, rules) {
  const list = Array.isArray(rules) ? rules : [];
  if (!product || !list.length) return null;

  const matches = list
    .filter((r) => ruleMatchesProduct(r, product))
    .sort((a, b) => ruleSpecificity(b) - ruleSpecificity(a));
  if (!matches.length) return null;

  const rule = matches[0];
  const cost = numOrNull(product.cost ?? product.price ?? product.base_price) ?? 0;
  const tier = pickTier(rule.tiers, cost);
  const rub = markupRubFromTier(cost, tier);
  if (rub == null) return null;
  return { rub, ruleId: rule.id, tier, ruleName: rule.name || null };
}
