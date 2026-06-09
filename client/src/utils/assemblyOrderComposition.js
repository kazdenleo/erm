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

function skuFromReserveLineLabel(label) {
  const s = String(label ?? '').trim();
  if (!s) return '';
  const noSuffix = s
    .replace(/\s*\([=×x]\d+[^)]*в комплекте\)\s*$/iu, '')
    .replace(/\s*\(×\d+[^)]*\)\s*$/u, '')
    .trim();
  const dotIdx = noSuffix.lastIndexOf('·');
  if (dotIdx >= 0) {
    const tail = noSuffix.slice(dotIdx + 1).trim();
    if (tail) return tail;
  }
  return noSuffix;
}

function articleFromReserveLine(line, rows) {
  const kind = String(line?.lineKind ?? line?.line_kind ?? '').toLowerCase();
  const isComponent = kind === 'component';

  const lineSku = line?.productSku ?? line?.product_sku;
  if (lineSku != null && String(lineSku).trim() !== '') {
    return String(lineSku).trim();
  }

  const label = String(line?.label ?? line?.productName ?? line?.product_name ?? '').trim();
  if (isComponent && label) {
    const fromLabel = skuFromReserveLineLabel(label);
    if (fromLabel) return fromLabel;
  }

  if (!isComponent) {
    const offer = line?.offerId ?? line?.offer_id;
    if (offer != null && String(offer).trim() !== '') {
      return String(offer).trim();
    }
  }

  const pid = Number(line?.productId ?? line?.product_id);
  if (Number.isFinite(pid) && pid > 0) {
    const row = (rows || []).find((r) => Number(r.productId ?? r.product_id) === pid);
    if (row) {
      const art = orderLineArticle(row);
      if (art !== '—') return art;
    }
  }

  if (label) {
    const fromLabel = skuFromReserveLineLabel(label);
    if (fromLabel) return fromLabel;
  }
  return label || '—';
}

function reserveLineKey(line) {
  const kind = String(line?.lineKind ?? line?.line_kind ?? 'product').toLowerCase();
  const pid = line?.productId ?? line?.product_id ?? '';
  const oid = line?.orderRowDbId ?? line?.order_row_db_id ?? line?.orderLineId ?? '';
  return `${kind}|${pid}|${oid}`;
}

function partsFromAssemblyComposition(rows) {
  const parts = [];
  for (const o of rows || []) {
    const acl = o.assemblyCompositionLines ?? o.assembly_composition_lines;
    if (!Array.isArray(acl) || !acl.length) continue;
    for (const line of acl) {
      const article =
        line.article ??
        line.sku ??
        line.productSku ??
        line.product_sku ??
        line.offerId ??
        line.offer_id;
      const qty = line.quantity ?? line.qty ?? line.needQty ?? line.need_qty ?? 0;
      const q = Math.max(0, Number(qty) || 0);
      if (q <= 0) continue;
      parts.push(compositionPart(article, q));
    }
  }
  return parts.length ? parts : null;
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
    const need = Number(line.needQty ?? line.need_qty) || 0;
    const displayQty = reserved > 0 ? reserved : need;
    if (displayQty <= 0) continue;
    const key = reserveLineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(compositionPart(articleFromReserveLine(line, rows), displayQty));
  }
  return parts.length ? parts : null;
}

/**
 * Строки состава для таблицы сборки: «артикул - количество» (каждая — отдельная строка в UI).
 * Для комплекта — полный BOM из каталога (все комплектующие), не путь резерва.
 */
export function getAssemblyOrderCompositionLines(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return [];

  const fromAssembly = partsFromAssemblyComposition(list);
  if (fromAssembly) return fromAssembly;

  const fromReserve = partsFromReserveLines(list);
  if (fromReserve) return fromReserve;

  return list.map((o) => {
    const article = orderLineArticle(o);
    const reserved = Number(o.reservedQty ?? o.reserved_qty) || 0;
    const qty = reserved > 0 ? reserved : Math.max(1, Number(o.quantity) || 1);
    const art = article !== '—' ? article : String(o.productName ?? o.product_name ?? '—').trim() || '—';
    return compositionPart(art, qty);
  });
}

/** Плоский текст для title / подсказки. */
export function formatAssemblyOrderComposition(rows) {
  const lines = getAssemblyOrderCompositionLines(rows);
  return lines.length ? lines.join('\n') : '—';
}
