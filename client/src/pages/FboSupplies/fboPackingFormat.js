/** Форматирование объёма и массы для сборки FBO. */

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
