/**
 * QR короба Wildberries: `$Ts;…;TAS`.
 *
 * Пример: `$Ts;DJU;m5mZ;1;7uPlJPl;TAS`
 * Номер короба в ЛК WB (15655909) — первые 3 байта base64 техкода `7uPlJPl` (u24 BE).
 * Сегмент перед техкодом (`m5mZ` → 10197401) — другой ID, не номер из списка коробов.
 */

export function isWbCargoQrPayload(raw) {
  const s = String(raw || '').trim();
  // `$` иногда теряется сканером; `;TAS` иногда обрезается в UI/скане
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
  const parts = String(raw)
    .trim()
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  // отбрасываем хвостовой TAS, если есть
  if (/^TAS$/i.test(parts[parts.length - 1])) parts.pop();
  // $Ts + ≥2 служебных + тип/номер + техкод
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
  const n = u24Be(decodeBase64Bytes(tech), 0);
  // Номера коробов WB обычно 7–8 знаков
  if (n == null || n < 1_000_000 || n > 99_999_999) return null;
  return String(n);
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
  return tech ? `QR WB · ${tech}` : 'QR WB';
}

/** Для Excel: номер короба + полный payload для печати QR. */
export function splitWbCargoBarcodeForExport(raw) {
  const full = String(raw || '').trim();
  if (!full) return { boxId: '', printPayload: '' };
  if (!isWbCargoQrPayload(full)) {
    return { boxId: full, printPayload: full };
  }
  const boxId = decodeWbCargoBoxNumber(full) || decodeWbCargoTechCode(full) || full;
  return { boxId, printPayload: full };
}
