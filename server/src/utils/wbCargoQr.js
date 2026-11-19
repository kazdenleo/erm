/**
 * QR короба Wildberries: `$Ts;…;TAS`.
 *
 * Пример: `$Ts;DJU;m5mZ;1;7uPlJPl;TAS`
 * Номер короба в ЛК WB (15655909) — первые 3 байта base64 техкода `7uPlJPl` (u24 BE).
 */

const WB_QR_RE = /\$?Ts;[^\s$]+(?:;[^\s$]+)*;TAS/i;

/** Если сканер продублировал QR — берём первый полный `$Ts;…;TAS`. */
export function normalizeWbCargoQrPayload(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(WB_QR_RE);
  return m ? m[0].replace(/^ts;/i, '$Ts;').replace(/^Ts;/, '$Ts;') : s;
}

export function isWbCargoQrPayload(raw) {
  const s = normalizeWbCargoQrPayload(raw);
  if (!/^\$?Ts;/i.test(s)) return false;
  const parts = s.split(';').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 5;
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

function splitWbCargoQrParts(raw) {
  if (!isWbCargoQrPayload(raw)) return null;
  const parts = normalizeWbCargoQrPayload(raw)
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (/^TAS$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length < 5) return null;
  return parts;
}

/** Техкод (последний сегмент перед TAS). */
export function decodeWbCargoTechCode(raw) {
  const parts = splitWbCargoQrParts(raw);
  if (!parts) return null;
  const tech = parts[parts.length - 1];
  return tech && !/^\$?Ts$/i.test(tech) ? tech : null;
}

/**
 * Номер короба как в ЛК WB (цифры в списке «Упаковка и печать ШК»).
 * Берётся из техкода: base64 → u24 BE.
 */
export function decodeWbCargoBoxNumber(raw) {
  const tech = decodeWbCargoTechCode(raw);
  if (!tech) return null;
  const bytes = decodeBase64Bytes(tech);
  // Актуальные этикетки WB: номер в первых 3 байтах (7uPlJPl → 15655909).
  // Старый/чужой формат BJm* начинается с 0x04 — номер портала из него не извлечь.
  const n = u24Be(bytes, 0);
  if (n == null || n < 1_000_000 || n > 99_999_999) return null;
  return String(n);
}

/** Похоже на товарный EAN/штрихкод, а не на QR короба WB. */
export function looksLikeProductBarcodeNotWbCargo(raw) {
  const s = String(raw || '').trim();
  if (!s || isWbCargoQrPayload(s)) return false;
  return /^\d{8,14}$/.test(s);
}

/**
 * Подпись для UI: номер короба как в ЛК WB.
 * Пример: `$Ts;DJU;m5mZ;1;7uPlJPl;TAS` → `15655909`
 */
export function formatCargoBarcodeLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return '—';
  const boxNo = decodeWbCargoBoxNumber(s);
  if (boxNo) return boxNo;
  if (!isWbCargoQrPayload(s)) return s;
  const tech = decodeWbCargoTechCode(s);
  // Не показываем «QR WB · …» — это выглядит как мусор; техкод оставляем как есть.
  return tech || 'QR WB';
}

/** Для Excel: номер короба + полный payload для печати QR. */
export function splitWbCargoBarcodeForExport(raw) {
  const full = normalizeWbCargoQrPayload(raw);
  if (!full) return { boxId: '', printPayload: '' };
  if (!isWbCargoQrPayload(full)) {
    return { boxId: full, printPayload: full };
  }
  const boxId = decodeWbCargoBoxNumber(full) || decodeWbCargoTechCode(full) || full;
  return { boxId, printPayload: full };
}
