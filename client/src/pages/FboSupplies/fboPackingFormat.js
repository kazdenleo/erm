/** Форматирование объёма и массы для сборки FBO. */

/**
 * QR короба WB: `$Ts;…;TAS`.
 * Сегменты: $Ts ; … ; … ; <номер короба> ; <техкод> ; TAS
 * Пример: `$Ts;EqN;yKGq;1;BJmumHmI;TAS` → номер 1, техкод BJmumHmI.
 * Числа из base64-сегментов — не номер из ЛК WB.
 */
export function isWbCargoQrPayload(raw) {
  const s = String(raw || '').trim();
  // `$` иногда теряется сканером в режиме клавиатуры
  return /^\$?Ts;/i.test(s) && /;TAS$/i.test(s);
}

function splitWbCargoQrParts(raw) {
  if (!isWbCargoQrPayload(raw)) return null;
  const parts = String(raw)
    .trim()
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 6) return null;
  return parts;
}

export function parseWbCargoQr(raw) {
  const parts = splitWbCargoQrParts(raw);
  if (!parts) return null;
  return {
    boxNo: parts[parts.length - 3] || '',
    tech: parts[parts.length - 2] || '',
    parts,
  };
}

/** Порядковый номер короба в поставке («Короб № N»). */
export function decodeWbCargoBoxNumber(raw) {
  const parsed = parseWbCargoQr(raw);
  if (!parsed) return null;
  if (!/^\d{1,6}$/.test(parsed.boxNo)) return null;
  return parsed.boxNo;
}

export function decodeWbCargoTechCode(raw) {
  const parsed = parseWbCargoQr(raw);
  if (!parsed?.tech) return null;
  return parsed.tech;
}

/**
 * Подпись для UI: как на этикетке WB.
 * Пример: `$Ts;EqN;yKGq;1;BJmumHmI;TAS` → `№ 1 · BJmumHmI`
 */
export function formatCargoBarcodeLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return '—';
  const parsed = parseWbCargoQr(s);
  if (!parsed) return s;
  const { boxNo, tech } = parsed;
  if (/^\d{1,6}$/.test(boxNo) && tech) return `№ ${boxNo} · ${tech}`;
  if (/^\d{1,6}$/.test(boxNo)) return `№ ${boxNo}`;
  if (tech) return tech;
  return 'QR WB';
}

/** В системных сообщениях подменяет payload на короткую подпись. */
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
