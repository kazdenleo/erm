/** Артикул строки заказа: внутренний SKU, иначе offer_id. */
export function orderLineArticle(o) {
  if (!o) return '—';
  const v =
    o.productSku ??
    o.product_sku ??
    o.offerId ??
    o.offer_id ??
    (o.sku != null && o.sku !== '' ? String(o.sku) : null);
  const s = v != null ? String(v).trim() : '';
  return s !== '' ? s : '—';
}

function compositionPart(article, qty) {
  const a = String(article ?? '').trim() || '—';
  const q = Math.max(0, Number(qty) || 0);
  return `${a} - ${q}`;
}

function articleFromReserveLine(line, rows) {
  const offer = line?.offerId ?? line?.offer_id;
  if (offer != null && String(offer).trim() !== '') {
    return String(offer).trim();
  }
  const pid = Number(line?.productId ?? line?.product_id);
  if (Number.isFinite(pid) && pid > 0) {
    const row = (rows || []).find((r) => Number(r.productId ?? r.product_id) === pid);
    if (row) {
      const art = orderLineArticle(row);
      if (art !== '—') return art;
    }
  }
  const label = String(line?.label ?? line?.productName ?? line?.product_name ?? '').trim();
  const stripped = label.replace(/\s*\(×\d+[^)]*\)\s*$/u, '').trim();
  return stripped || label || '—';
}

function reserveLineKey(line) {
  const kind = String(line?.lineKind ?? line?.line_kind ?? 'product').toLowerCase();
  const pid = line?.productId ?? line?.product_id ?? '';
  const oid = line?.orderRowDbId ?? line?.order_row_db_id ?? line?.orderLineId ?? '';
  return `${kind}|${pid}|${oid}`;
}

function partsFromReserveLines(rows) {
  const reserveLines = [];
  for (const o of rows || []) {
    const rl = o.reserveLines ?? o.reserve_lines;
    if (Array.isArray(rl)) reserveLines.push(...rl);
  }
  if (!reserveLines.length) return null;

  const parts = [];
  const seen = new Set();
  for (const line of reserveLines) {
    const reserved = Number(line.reservedQty ?? line.reserved_qty) || 0;
    if (reserved <= 0) continue;
    const key = reserveLineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(compositionPart(articleFromReserveLine(line, rows), reserved));
  }
  return parts.length ? parts : null;
}

/**
 * Состав заказа для таблицы сборки: «артикул - количество».
 * Для комплекта — что забронировано: целый комплект или комплектующие по отдельности.
 */
export function formatAssemblyOrderComposition(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return '—';

  const fromReserve = partsFromReserveLines(list);
  if (fromReserve) return fromReserve.join(', ');

  const parts = list.map((o) => {
    const article = orderLineArticle(o);
    const reserved = Number(o.reservedQty ?? o.reserved_qty) || 0;
    const qty = reserved > 0 ? reserved : Math.max(1, Number(o.quantity) || 1);
    const art = article !== '—' ? article : String(o.productName ?? o.product_name ?? '—').trim() || '—';
    return compositionPart(art, qty);
  });
  return parts.join(', ');
}
