import { describe, test, expect } from '@jest/globals';
import { computeIncomingWarehouseTransferLegs } from '../src/utils/stockWarehouseReassign.js';

describe('computeIncomingWarehouseTransferLegs', () => {
  test('pending 10, journal 1 — списать 1, начислить 10', () => {
    expect(
      computeIncomingWarehouseTransferLegs({
        pendingQty: 10,
        documentNetOnSource: 1,
        warehouseIncomingNet: 5,
      })
    ).toEqual({ subtractQty: 1, addQty: 10 });
  });

  test('pending 10, journal 10 — симметричный перенос', () => {
    expect(
      computeIncomingWarehouseTransferLegs({
        pendingQty: 10,
        documentNetOnSource: 10,
        warehouseIncomingNet: 10,
      })
    ).toEqual({ subtractQty: 10, addQty: 10 });
  });

  test('pending 10, journal 0 — только начисление на новый склад', () => {
    expect(
      computeIncomingWarehouseTransferLegs({
        pendingQty: 10,
        documentNetOnSource: 0,
        warehouseIncomingNet: 0,
      })
    ).toEqual({ subtractQty: 0, addQty: 10 });
  });

  test('pending 10, journal 20 — перенос только 10 (не +20)', () => {
    expect(
      computeIncomingWarehouseTransferLegs({
        pendingQty: 10,
        documentNetOnSource: 20,
        warehouseIncomingNet: 20,
      })
    ).toEqual({ subtractQty: 10, addQty: 10 });
  });

  test('складской net ниже documentNet — списание ограничено складом', () => {
    expect(
      computeIncomingWarehouseTransferLegs({
        pendingQty: 10,
        documentNetOnSource: 8,
        warehouseIncomingNet: 3,
      })
    ).toEqual({ subtractQty: 3, addQty: 10 });
  });

  test('симметричный режим без pendingQty', () => {
    expect(
      computeIncomingWarehouseTransferLegs({
        transferQty: 4,
        warehouseIncomingNet: 2,
      })
    ).toEqual({ subtractQty: 2, addQty: 2 });
  });
});
