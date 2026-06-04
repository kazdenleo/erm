/** Нормализация vendorCode WB (снятие хвостовой «;» и т.п. при вставке из Excel). */
const EDGE_JUNK_RE = /^[\s;,.:|«»"'`]+|[\s;,.:|«»"'`]+$/g;

export function sanitizeWbVendorCode(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  let prev;
  do {
    prev = v;
    v = v.replace(EDGE_JUNK_RE, '').trim();
  } while (v !== prev && v.length > 0);
  return v;
}
