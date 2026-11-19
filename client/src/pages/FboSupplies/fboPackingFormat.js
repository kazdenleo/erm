/** Форматирование объёма и массы для сборки FBO. */

/**
 * QR короба WB: `$Ts;…;TAS`.
 * Номер из ЛК (напр. 15655909) — в техкоде: base64 → u24 BE.
 * Пример: `$Ts;DJU;m5mZ;1;7uPlJPl;TAS` → `15655909`
 */

export function isWbCargoQrPayload(raw) {
  const s = String(raw || '').trim();
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
    if (typeof atob === 'function') {
      const bin = atob(t);
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    }
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(t, 'base64'));
    }
  } catch {
    /* ignore */
  }
  return null;
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
  if (/^TAS$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length < 5) return null;
  return parts;
}

export function decodeWbCargoTechCode(raw) {
  const parts = splitWbCargoQrParts(raw);
  if (!parts) return null;
  const tech = parts[parts.length - 1];
  return tech && !/^\$?Ts$/i.test(tech) ? tech : null;
}

/** Номер короба как в ЛК WB (список коробов). */
export function decodeWbCargoBoxNumber(raw) {
  const tech = decodeWbCargoTechCode(raw);
  if (!tech) return null;
  const n = u24Be(decodeBase64Bytes(tech), 0);
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

/** В системных сообщениях подменяет payload на короткую подпись. */
export function humanizeWbCargoQrInText(text) {
  const s = String(text || '');
  if (!/\$?Ts;/i.test(s)) return s;
  return s.replace(/\$?Ts;[^\s;]+(?:;[^\s;]+)*/gi, (m) => formatCargoBarcodeLabel(m));
}

export function fmtVolumeL(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 10) return `${n.toFixed(2)} л`;
  return `${n.toFixed(1)} л`;
}

export function fmtWeightG(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(2)} кг`;
  return `${Math.round(n)} г`;
}

export function fmtWeightKg(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${n.toFixed(2)} кг`;
}

export function cargoWeightExceededMessage(cargo) {
  if (!cargo?.weightExceeded) return null;
  const kind = cargo.cargoKind === 'pallet' ? 'паллета' : 'короб';
  const tareG = Number(cargo.palletTareWeightG) || 0;
  const tarePart = tareG > 0 ? ` (включая паллету ${fmtWeightG(tareG)})` : '';
  return `Превышен вес грузоместа (${kind}): ${fmtWeightG(cargo.totalWeightG)}${tarePart} при лимите ${fmtWeightKg(cargo.weightLimitKg)}`;
}

export function cargoWeightSummary(cargo) {
  const goods = fmtWeightG(cargo?.goodsWeightG ?? cargo?.totalWeightG);
  const tareG = Number(cargo?.palletTareWeightG) || 0;
  if (cargo?.cargoKind === 'pallet' && tareG > 0) {
    return `${goods} товар + ${fmtWeightG(tareG)} паллета = ${fmtWeightG(cargo.totalWeightG)}`;
  }
  return fmtWeightG(cargo?.totalWeightG);
}

export function fmtExpiryDate(v) {
  if (v == null || v === '') return '—';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split('-');
    return `${d}.${m}.${y}`;
  }
  const dt = new Date(v);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('ru-RU');
}
