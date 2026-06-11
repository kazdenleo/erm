export function packedCellClass(packed, planned) {
  if (packed === planned) return 'ok';
  if (packed > planned) return 'over';
  if (packed > 0) return 'short';
  return 'none';
}
