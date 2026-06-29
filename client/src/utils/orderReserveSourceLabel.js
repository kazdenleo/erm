/** Подпись источника резерва для списка в модалке остатков. */

export function formatReserveSourceLabel({
  reserveSource,
  reserveFromOnHand,
  reserveFromIncoming
} = {}) {
  const oh = Math.max(0, Number(reserveFromOnHand) || 0);
  const inc = Math.max(0, Number(reserveFromIncoming) || 0);
  const src =
    reserveSource ||
    (oh > 0 && inc > 0 ? 'mixed' : inc > 0 ? 'incoming' : oh > 0 ? 'on_hand' : null);

  if (!src) return null;
  if (src === 'on_hand') return 'С наличия';
  if (src === 'incoming') return 'В пути';
  if (src === 'mixed') {
    if (oh > 0 && inc > 0) return `${oh} с наличия, ${inc} в пути`;
    return 'Частично с наличия и в пути';
  }
  return null;
}
