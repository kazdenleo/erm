/**
 * Нормализация списка упаковок товара: { barcode, units_per_box }.
 */

export function normalizeBoxPackagings(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const barcode = String(row.barcode ?? row.box_barcode ?? row.boxBarcode ?? '').trim();
    if (!barcode) continue;
    const units = Math.floor(Number(row.units_per_box ?? row.unitsPerBox ?? row.units ?? 0));
    if (!Number.isFinite(units) || units <= 0) continue;
    const key = barcode.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ barcode, units_per_box: units });
  }
  return out;
}

/** Совместимость: одиночные поля → массив упаковок. */
export function boxPackagingsFromLegacy(product) {
  if (!product || typeof product !== 'object') return [];
  if (Array.isArray(product.box_packagings) || Array.isArray(product.boxPackagings)) {
    return normalizeBoxPackagings(product.box_packagings ?? product.boxPackagings);
  }
  return normalizeBoxPackagings([
    {
      barcode: product.box_barcode ?? product.boxBarcode,
      units_per_box: product.units_per_box ?? product.unitsPerBox,
    },
  ]);
}

export function legacyFieldsFromBoxPackagings(packagings) {
  const list = normalizeBoxPackagings(packagings);
  if (!list.length) return { box_barcode: null, units_per_box: null };
  return { box_barcode: list[0].barcode, units_per_box: list[0].units_per_box };
}

/** Найти упаковку по скану (точное совпадение или только цифры). */
export function matchBoxPackaging(packagings, scannedCode) {
  const code = String(scannedCode || '').trim();
  if (!code) return null;
  const list = normalizeBoxPackagings(packagings);
  const lower = code.toLowerCase();
  const digits = code.replace(/\D+/g, '');
  for (const row of list) {
    if (row.barcode.toLowerCase() === lower) return row;
  }
  if (digits) {
    for (const row of list) {
      if (row.barcode.replace(/\D+/g, '') === digits) return row;
    }
  }
  return null;
}

export default {
  normalizeBoxPackagings,
  boxPackagingsFromLegacy,
  legacyFieldsFromBoxPackagings,
  matchBoxPackaging,
};
