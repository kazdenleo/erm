/** Плашка резерва: зелёная — со склада, серая — с участием «в пути». */

/**
 * Числа для плашки «зарезервировано/нужно» (в штуках для комплекта).
 * Если резерв в штуках, а needQty ещё в комплектах (2/1), подтягиваем знаменатель.
 */
export function orderReserveBadgeCounts({ qty, reservedQty, needQty }) {
  const displayQty = Number.isFinite(Number(qty)) && Number(qty) > 0 ? Number(qty) : 1;
  const r = Math.max(0, Number(reservedQty) || 0);
  let n = Math.max(0, Number(needQty) || 0);
  if (n < 1) n = displayQty;
  if (r > n && n === displayQty) n = r;
  return { reserved: r, need: n, displayQty };
}

export function groupReserveCoverageKind(ordersOrLines) {
  let anyIncoming = false;
  let anyOnHand = false;
  let anyUncovered = false;
  for (const item of ordersOrLines || []) {
    const k = String(item.reserveCoverage ?? item.reserve_coverage ?? 'none').toLowerCase();
    if (k === 'on_hand') anyOnHand = true;
    if (k === 'incoming') anyIncoming = true;
    if (k === 'uncovered') anyUncovered = true;
  }
  if (anyUncovered) return 'uncovered';
  if (anyIncoming) return 'incoming';
  if (anyOnHand) return 'on_hand';
  return 'none';
}

export function reserveBadgeClassName(coverageKind) {
  if (coverageKind === 'on_hand') return 'orders-reserve-badge orders-reserve-badge--on-hand';
  if (coverageKind === 'incoming') return 'orders-reserve-badge orders-reserve-badge--incoming';
  if (coverageKind === 'uncovered') return 'orders-reserve-badge orders-reserve-badge--uncovered';
  return 'orders-reserve-badge orders-reserve-badge--uncovered';
}

export function formatOrderReserveBadgeTitle({
  reservedQty,
  needQty,
  lines,
  orders,
  isGroup,
  coverageKind
}) {
  const fully = needQty > 0 && reservedQty >= needQty ? ' (полностью)' : '';
  const sourceHint =
    coverageKind === 'on_hand'
      ? '\nПокрытие: со склада (в наличии).'
      : coverageKind === 'incoming'
        ? '\nПокрытие: с участием товара в пути.'
        : coverageKind === 'uncovered'
          ? '\nПокрытие: резерв без остатка и без ожидаемой поставки (снимите резерв или добавьте закупку).'
          : '';
  const head = `Зарезервировано ${reservedQty} из ${needQty}${fully}${sourceHint}`;
  const pool = [];
  if (Array.isArray(lines) && lines.length) pool.push(...lines);
  else if (isGroup && Array.isArray(orders)) pool.push(...orders);
  else if (Array.isArray(orders) && orders.length) pool.push(orders[0]);
  const detailLines = [];
  for (const o of pool) {
    const rl = o.reserveLines ?? o.reserve_lines;
    if (Array.isArray(rl)) detailLines.push(...rl);
    else if (o.productId != null || o.label) detailLines.push(o);
  }
  if (!detailLines.length) {
    return `${head}\nТовары и комплектующие по заказу`;
  }
  const detail = detailLines
    .map((l) => {
      const label = String(l.label || l.productName || 'Позиция').trim();
      const r = Number(l.reservedQty) || 0;
      const n = Number(l.needQty) || 0;
      const k = l.reserveCoverage ?? l.reserve_coverage;
      const src =
        k === 'on_hand' ? ' склад' : k === 'incoming' ? ' в пути' : k === 'uncovered' ? ' без покрытия' : '';
      return `${label}: ${r}/${n}${src}`;
    })
    .join('\n');
  return `${head}\n${detail}`;
}
