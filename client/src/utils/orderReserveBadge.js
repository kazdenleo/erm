/** Плашка резерва: зелёная только при полном покрытии со склада; иначе серая (в пути / частично). */

/**
 * Числа для плашки «зарезервировано/нужно» в единицах строки заказа (комплект = 1 шт заказа).
 * Знаменатель — qty/needQty заказа; числитель не выше need (лишний резерв в журнале не раздувает плашку).
 */
export function orderReserveBadgeCounts({ qty, reservedQty, needQty }) {
  const displayQty = Number.isFinite(Number(qty)) && Number(qty) > 0 ? Number(qty) : 1;
  let n = Math.max(0, Number(needQty) || 0);
  if (n < 1) n = displayQty;
  const rRaw = Math.max(0, Number(reservedQty) || 0);
  const r = Math.min(rRaw, n);
  return { reserved: r, need: n, displayQty };
}

export function groupReserveCoverageKind(ordersOrLines) {
  let anyIncoming = false;
  let anyOnHand = false;
  for (const item of ordersOrLines || []) {
    const k = String(item.reserveCoverage ?? item.reserve_coverage ?? 'none').toLowerCase();
    if (k === 'on_hand') anyOnHand = true;
    if (k === 'incoming' || k === 'uncovered') anyIncoming = true;
  }
  if (anyIncoming) return 'incoming';
  if (anyOnHand) return 'on_hand';
  return 'none';
}

/**
 * Визуальный вид плашки количества:
 * — зелёный: полный резерв со склада;
 * — серый: есть резерв с «в пути» или частичный;
 * — none: резерва нет (в UI — просто цифра без плашки).
 */
export function reserveBadgeVisualKind(coverageKind, { reservedQty = 0, needQty = 0 } = {}) {
  const r = Math.max(0, Number(reservedQty) || 0);
  const n = Math.max(0, Number(needQty) || 0);
  const fully = n > 0 && r >= n;
  if (coverageKind === 'on_hand' && fully) return 'on_hand';
  if (r > 0) return 'incoming';
  return 'none';
}

export function reserveBadgeClassName(coverageKind, counts = null) {
  const kind =
    counts != null ? reserveBadgeVisualKind(coverageKind, counts) : coverageKind === 'on_hand' ? 'on_hand' : 'incoming';
  if (kind === 'on_hand') return 'orders-reserve-badge orders-reserve-badge--on-hand';
  if (kind === 'none') return 'orders-reserve-badge orders-reserve-badge--uncovered';
  return 'orders-reserve-badge orders-reserve-badge--incoming';
}

export function formatOrderReserveBadgeTitle({
  reservedQty,
  needQty,
  lines,
  orders,
  isGroup,
  coverageKind
}) {
  const visual = reserveBadgeVisualKind(coverageKind, { reservedQty, needQty });
  const fully = needQty > 0 && reservedQty >= needQty ? ' (полностью)' : ' (частично)';
  const sourceHint =
    visual === 'on_hand'
      ? '\nПокрытие: со склада (в наличии).'
      : coverageKind === 'on_hand' && reservedQty < needQty
        ? '\nПокрытие: со склада, но резерв неполный.'
        : '\nПокрытие: с участием товара в пути или резерв неполный.';
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
      const src = k === 'on_hand' ? ' склад' : r > 0 ? ' в пути' : '';
      return `${label}: ${r}/${n}${src}`;
    })
    .join('\n');
  return `${head}\n${detail}`;
}
