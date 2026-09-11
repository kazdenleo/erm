/**
 * Сколько списать при закрытии отгрузки / сборке.
 * Нетто-резерв — текущий, а не накопительный: повторный резерв после старого shipment
 * должен снова уменьшить наличие, а не только снять резерв.
 */
export function outstandingShipmentQty(requestedQty, alreadyShipped, netReserved = 0) {
  const requested = Math.max(0, Math.floor(Number(requestedQty) || 0));
  const shipped = Math.max(0, Math.floor(Number(alreadyShipped) || 0));
  const net = Math.max(0, Math.floor(Number(netReserved) || 0));
  return Math.max(Math.max(0, requested - shipped), net);
}

/**
 * План списания комплекта: целый SKU и/или комплектующие.
 * Исторические shipment не обнуляют текущий резерв.
 */
export function resolveKitOutstandingShipPlan({
  kitOrderQty,
  wholeShipped,
  kitsShippedViaComp,
  kitNet,
  compKitUnitsReserved,
  physicalWhole
} = {}) {
  const qty = Math.max(1, Math.floor(Number(kitOrderQty) || 1));
  const wholeShippedN = Math.max(0, Math.floor(Number(wholeShipped) || 0));
  const viaComp = Math.max(0, Math.floor(Number(kitsShippedViaComp) || 0));
  const kitNetN = Math.max(0, Math.floor(Number(kitNet) || 0));
  const compRes = Math.max(0, Math.floor(Number(compKitUnitsReserved) || 0));
  const physical = Math.max(0, Math.floor(Number(physicalWhole) || 0));
  const orderKitsRemaining = Math.max(0, qty - wholeShippedN - viaComp);

  if (kitNetN > 0) {
    return {
      wholeUnitsToShip: kitNetN,
      componentKitUnitsToShip: 0,
      orderKitsRemaining
    };
  }

  const wholeUnitsToShip = Math.min(orderKitsRemaining, Math.max(0, physical - wholeShippedN));
  let componentKitUnitsToShip = Math.min(
    Math.max(0, orderKitsRemaining - wholeUnitsToShip),
    Math.max(0, compRes - viaComp)
  );
  if (wholeUnitsToShip === 0 && componentKitUnitsToShip === 0 && compRes > 0) {
    componentKitUnitsToShip = compRes;
  }
  return { wholeUnitsToShip, componentKitUnitsToShip, orderKitsRemaining };
}

export function kitShipmentPlanAllowedQty(orderKitsRemaining, kitNet, compKitUnitsReserved) {
  const remaining = Math.max(0, Math.floor(Number(orderKitsRemaining) || 0));
  const kit = Math.max(0, Math.floor(Number(kitNet) || 0));
  const comp = Math.max(0, Math.floor(Number(compKitUnitsReserved) || 0));
  return Math.max(remaining, kit, comp);
}
