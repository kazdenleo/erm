import { describe, test, expect } from '@jest/globals';
import {
  outstandingShipmentQty,
  resolveKitOutstandingShipPlan,
  kitShipmentPlanAllowedQty
} from '../src/utils/outstandingShipmentQty.js';

describe('outstandingShipmentQty', () => {
  test('первая отгрузка: qty и резерв 1', () => {
    expect(outstandingShipmentQty(1, 0, 1)).toBe(1);
  });

  test('повторное закрытие без нового резерва — не списываем дважды', () => {
    expect(outstandingShipmentQty(1, 1, 0)).toBe(0);
  });

  test('повторный резерв после старого shipment — списываем наличие', () => {
    expect(outstandingShipmentQty(1, 1, 1)).toBe(1);
  });

  test('догоняющее списание без резерва', () => {
    expect(outstandingShipmentQty(1, 0, 0)).toBe(1);
  });

  test('частичная отгрузка', () => {
    expect(outstandingShipmentQty(2, 1, 1)).toBe(1);
  });
});

describe('resolveKitOutstandingShipPlan', () => {
  test('резерв на SKU комплекта', () => {
    expect(
      resolveKitOutstandingShipPlan({
        kitOrderQty: 1,
        wholeShipped: 0,
        kitsShippedViaComp: 0,
        kitNet: 1,
        compKitUnitsReserved: 0,
        physicalWhole: 1
      })
    ).toMatchObject({ wholeUnitsToShip: 1, componentKitUnitsToShip: 0 });
  });

  test('повторный резерв SKU после исторической отгрузки', () => {
    expect(
      resolveKitOutstandingShipPlan({
        kitOrderQty: 1,
        wholeShipped: 1,
        kitsShippedViaComp: 0,
        kitNet: 1,
        compKitUnitsReserved: 0,
        physicalWhole: 1
      })
    ).toMatchObject({ wholeUnitsToShip: 1, componentKitUnitsToShip: 0, orderKitsRemaining: 0 });
    expect(kitShipmentPlanAllowedQty(0, 1, 0)).toBe(1);
  });

  test('повторный резерв комплектующих после отгрузки', () => {
    expect(
      resolveKitOutstandingShipPlan({
        kitOrderQty: 1,
        wholeShipped: 0,
        kitsShippedViaComp: 1,
        kitNet: 0,
        compKitUnitsReserved: 1,
        physicalWhole: 0
      })
    ).toMatchObject({ wholeUnitsToShip: 0, componentKitUnitsToShip: 1, orderKitsRemaining: 0 });
  });

  test('идемпотентность: уже отгружено, резерва нет', () => {
    expect(
      resolveKitOutstandingShipPlan({
        kitOrderQty: 1,
        wholeShipped: 1,
        kitsShippedViaComp: 0,
        kitNet: 0,
        compKitUnitsReserved: 0,
        physicalWhole: 0
      })
    ).toMatchObject({ wholeUnitsToShip: 0, componentKitUnitsToShip: 0 });
  });
});
