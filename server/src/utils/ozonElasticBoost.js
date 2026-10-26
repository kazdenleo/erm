function ozonMoney(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') {
    const amount = v.amount ?? v.value;
    if (amount != null && amount !== '') {
      const n = Number(amount);
      return Number.isFinite(n) ? n : null;
    }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Края эластичного бустинга: цена минимального процента выше цены максимального. */
export function elasticBoostScale(row) {
  const priceAtMinBoost = ozonMoney(row?.price_min_elastic);
  const priceAtMaxBoost = ozonMoney(row?.price_max_elastic);
  const minBoost = ozonMoney(row?.min_boost);
  const maxBoost = ozonMoney(row?.max_boost);
  if (
    priceAtMinBoost == null || priceAtMaxBoost == null || minBoost == null || maxBoost == null
    || priceAtMinBoost <= priceAtMaxBoost
    || maxBoost <= minBoost
    || priceAtMinBoost <= 0
    || priceAtMaxBoost <= 0
  ) {
    return null;
  }
  return { priceAtMinBoost, priceAtMaxBoost, minBoost, maxBoost };
}

/** Бустинг по цене. На живом товаре шкала Ozon совпала с прямой между краями. */
export function boostAtPrice(scale, price) {
  const p = Number(price);
  if (!scale || !Number.isFinite(p)) return null;
  const span = scale.priceAtMinBoost - scale.priceAtMaxBoost;
  const t = (scale.priceAtMinBoost - p) / span;
  const boost = scale.minBoost + t * (scale.maxBoost - scale.minBoost);
  return Math.round(boost * 10) / 10;
}

export function priceAtBoost(scale, boost) {
  const b = Number(boost);
  if (!scale || !Number.isFinite(b)) return null;
  const span = scale.maxBoost - scale.minBoost;
  const t = (b - scale.minBoost) / span;
  const price = scale.priceAtMinBoost + t * (scale.priceAtMaxBoost - scale.priceAtMinBoost);
  return Math.round(price);
}

function boostStep(span) {
  if (span <= 10) return 1;
  if (span <= 20) return 2;
  if (span <= 45) return 5;
  return Math.max(1, Math.ceil(span / 8));
}

/**
 * Уровни от меньшего бустинга к большему.
 * Ozon отдаёт только края; промежуточные цены — по прямой между ними.
 */
export function elasticBoostLevels(row) {
  const scale = elasticBoostScale(row);
  if (!scale) return [];
  const step = boostStep(scale.maxBoost - scale.minBoost);
  const boosts = [scale.minBoost];
  const start = Math.ceil((scale.minBoost + 1e-6) / step) * step;
  for (let boost = start; boost < scale.maxBoost - 1e-6; boost += step) {
    if (boost - scale.minBoost > 0.05) boosts.push(boost);
  }
  boosts.push(scale.maxBoost);

  const levels = [];
  const seen = new Set();
  for (const boost of boosts) {
    const price = priceAtBoost(scale, boost);
    if (price == null || seen.has(price)) continue;
    seen.add(price);
    levels.push({ boost, price, current: false });
  }

  const currentPrice = ozonMoney(row?.action_price);
  if (currentPrice != null && currentPrice > 0 && levels.length) {
    let closest = levels[0];
    let best = Math.abs(levels[0].price - currentPrice);
    for (const level of levels) {
      const dist = Math.abs(level.price - currentPrice);
      if (dist < best) {
        best = dist;
        closest = level;
      }
    }
    const inside = currentPrice <= scale.priceAtMinBoost + 1 && currentPrice >= scale.priceAtMaxBoost - 1;
    if (inside) closest.current = true;
  }
  return levels;
}
