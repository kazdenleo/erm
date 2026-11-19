/**
 * QR короба Wildberries: при скане `$Ts;…;TAS`.
 *
 * Структура (по наблюдаемым payload и документации WB):
 *   $Ts ; <…> ; <…> ; <номер короба> ; <техкод> ; TAS
 * Пример: `$Ts;EqN;yKGq;1;BJmumHmI;TAS`
 *   — номер короба в поставке: 1  (как «Короб № 1» в ЛК)
 *   — техкод: BJmumHmI
 *
 * Число из base64-сегментов — не номер из кабинета WB, его не показываем.
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
  // $Ts + ≥2 служебных + номер + техкод + TAS
  if (parts.length < 6) return null;
  return parts;
}

/** Разбор QR: номер короба (порядковый) и техкод с этикетки WB. */
export function parseWbCargoQr(raw) {
  const parts = splitWbCargoQrParts(raw);
  if (!parts) return null;
  const tech = parts[parts.length - 2] || '';
  const boxNo = parts[parts.length - 3] || '';
  return {
    boxNo,
    tech,
    parts,
  };
}

/** Порядковый номер короба в поставке («Короб № N»), если есть. */
export function decodeWbCargoBoxNumber(raw) {
  const parsed = parseWbCargoQr(raw);
  if (!parsed) return null;
  if (!/^\d{1,6}$/.test(parsed.boxNo)) return null;
  return parsed.boxNo;
}

/** Техкод из QR (предпоследний сегмент перед TAS). */
export function decodeWbCargoTechCode(raw) {
  const parsed = parseWbCargoQr(raw);
  if (!parsed?.tech) return null;
  return parsed.tech;
}

/**
 * Подпись для UI / текст на этикетке — как на стикере WB, не «угаданный» ID.
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
