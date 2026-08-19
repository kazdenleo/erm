/**
 * Лимит резерва «с пути»: свободное incoming и clamp split on_hand/incoming.
 * Вынесено из orders.service, чтобы stockMovements не ломался на циклическом import.
 */

/** Свободное «в пути» по снимку supply (без meta-тегов). */
export function freeIncomingFromSupply({ onHand = 0, incoming = 0, reserved = 0 } = {}) {
  const H = Math.max(0, Math.floor(Number(onHand) || 0));
  const I = Math.max(0, Math.floor(Number(incoming) || 0));
  const R = Math.max(0, Math.floor(Number(reserved) || 0));
  const claimedIncoming = Math.max(0, R - H);
  return Math.max(0, I - claimedIncoming);
}

/**
 * Ужимает split on_hand/incoming и qty, чтобы не занять больше свободного «в пути».
 * @returns {{ qty: number, reserveFromOnHand: number, reserveFromIncoming: number }}
 */
export function clampReserveSplitToFreeIncoming(
  qtyWanted,
  { reserveFromOnHand = 0, reserveFromIncoming = 0, freeIncoming = 0, onHandHeadroom = 0 } = {}
) {
  let qty = Math.max(0, Math.floor(Number(qtyWanted) || 0));
  let fromOh = Math.max(0, Math.floor(Number(reserveFromOnHand) || 0));
  let fromInc = Math.max(0, Math.floor(Number(reserveFromIncoming) || 0));
  const freeInc = Math.max(0, Math.floor(Number(freeIncoming) || 0));
  const ohRoom = Math.max(0, Math.floor(Number(onHandHeadroom) || 0));

  if (qty < 1) return { qty: 0, reserveFromOnHand: 0, reserveFromIncoming: 0 };

  if (fromInc > freeInc) {
    const spill = fromInc - freeInc;
    fromInc = freeInc;
    const toOh = Math.min(spill, Math.max(0, ohRoom - fromOh));
    fromOh += toOh;
  }

  fromOh = Math.min(fromOh, ohRoom, qty);
  fromInc = Math.min(fromInc, freeInc, Math.max(0, qty - fromOh));

  let left = qty - fromOh - fromInc;
  if (left > 0) {
    const takeOh = Math.min(left, Math.max(0, ohRoom - fromOh));
    fromOh += takeOh;
    left -= takeOh;
  }
  if (left > 0) {
    const takeInc = Math.min(left, Math.max(0, freeInc - fromInc));
    fromInc += takeInc;
    left -= takeInc;
  }
  if (left > 0) qty -= left;

  if (qty < 1) return { qty: 0, reserveFromOnHand: 0, reserveFromIncoming: 0 };
  return {
    qty,
    reserveFromOnHand: fromOh,
    reserveFromIncoming: fromInc,
  };
}
