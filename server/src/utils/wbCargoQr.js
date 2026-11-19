/**
 * QR короба Wildberries: при скане `$Ts;…;TAS` вместо короткого номера из ЛК.
 */

export function isWbCargoQrPayload(raw) {
  const s = String(raw || '').trim();
  return /^\$Ts;/i.test(s) && /;TAS$/i.test(s);
}

function decodeBase64Bytes(enc) {
  const raw = String(enc || '').trim();
  if (!raw) return null;
  try {
    let t = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return new Uint8Array(Buffer.from(t, 'base64'));
  } catch {
    return null;
  }
}

function u24Be(bytes, offset = 0) {
  if (!bytes || bytes.length < offset + 3) return null;
  return ((bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]) >>> 0;
}

/** Номер короба как в ЛК WB (цифры), из сегмента QR `$Ts;…;TAS`. */
export function decodeWbCargoBoxNumber(raw) {
  if (!isWbCargoQrPayload(raw)) return null;
  const parts = String(raw)
    .trim()
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 6) return null;
  const n = u24Be(decodeBase64Bytes(parts[2]), 0);
  if (n == null || n < 1000) return null;
  return String(n);
}

/** Техкод из QR (предпоследний сегмент перед TAS). */
export function decodeWbCargoTechCode(raw) {
  if (!isWbCargoQrPayload(raw)) return null;
  const parts = String(raw)
    .trim()
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const tech = parts[parts.length - 2];
  return tech || null;
}

/**
 * Подпись для UI / читаемый текст на этикетке.
 * Пример: `$Ts;EqN;yKGq;1;BJmumHmI;TAS` → `13148586`
 */
export function formatCargoBarcodeLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return '—';
  const boxNo = decodeWbCargoBoxNumber(s);
  if (boxNo) return boxNo;
  if (!isWbCargoQrPayload(s)) return s;
  const tech = decodeWbCargoTechCode(s);
  return tech ? `QR WB · ${tech}` : 'QR WB';
}

/** Для Excel: короткий номер в «ШК короба», полный payload — в колонке для печати. */
export function splitWbCargoBarcodeForExport(raw) {
  const full = String(raw || '').trim();
  if (!full) return { boxId: '', printPayload: '' };
  if (!isWbCargoQrPayload(full)) {
    return { boxId: full, printPayload: full };
  }
  const boxId = decodeWbCargoBoxNumber(full) || decodeWbCargoTechCode(full) || full;
  return { boxId, printPayload: full };
}
