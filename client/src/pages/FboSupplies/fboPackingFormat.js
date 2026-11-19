/** Форматирование объёма и массы для сборки FBO. */

/** Новый QR короба WB: при скане приходит `$Ts;…;TAS`, а не короткий номер из ЛК. */
export function isWbCargoQrPayload(raw) {
  const s = String(raw || '').trim();
  // `$` иногда теряется сканером в режиме клавиатуры
  return /^\$?Ts;/i.test(s) && /;TAS$/i.test(s);
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

/**
 * Номер короба как в ЛК WB (цифры), извлечённый из QR `$Ts;…;TAS`.
 * Полный QR остаётся штрихкодом для скана/печати.
 */
export function decodeWbCargoBoxNumber(raw) {
  if (!isWbCargoQrPayload(raw)) return null;
  const parts = String(raw)
    .trim()
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  // $Ts ; … ; <номер> ; … ; <техкод> ; TAS
  if (parts.length < 6) return null;
  const enc = parts[2];
  const bytes = decodeBase64Bytes(enc);
  const n = u24Be(bytes, 0);
  if (n == null || n < 1000) return null;
  return String(n);
}

/**
 * Подпись для UI: номер короба WB, иначе исходный ШК.
 * Пример: `$Ts;EqN;yKGq;1;BJmumHmI;TAS` → `13148586`
 */
export function formatCargoBarcodeLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return '—';
  const boxNo = decodeWbCargoBoxNumber(s);
  if (boxNo) return boxNo;
  if (!isWbCargoQrPayload(s)) return s;
  const parts = s.split(';').map((p) => p.trim()).filter(Boolean);
  const id = parts.length >= 3 ? parts[parts.length - 2] : '';
  return id ? `QR WB · ${id}` : 'QR WB';
}

/** В системных сообщениях («Новое грузоместо: $Ts;…») подменяет payload на короткую подпись. */
export function humanizeWbCargoQrInText(text) {
  const s = String(text || '');
  if (!/\$?Ts;/i.test(s) || !/;TAS/i.test(s)) return s;
  return s.replace(/\$?Ts;[^\s;]+(?:;[^\s;]+)*;TAS/gi, (m) => formatCargoBarcodeLabel(m));
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
