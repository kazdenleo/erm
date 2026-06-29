import { describe, test, expect } from '@jest/globals';
import {
  allocateKitReservePriority,
  resolveComplementaryKitReserveUnits,
  kitWholeReserveExcessAtWarehouse
} from '../src/services/kitStock.service.js';

describe('allocateKitReservePriority', () => {
  test('1 целый на складе, 3 комплекта в заказе — 1 целый + 2 из комплектующих', () => {
    const alloc = allocateKitReservePriority(3, {
      physicalOnHand: 1,
      wholeReserveAvail: 1,
      fromComponents: 7,
      fromComponentsOnHand: 7
    });
    expect(alloc).toEqual({
      kitsToReserve: 3,
      fromWhole: 1,
      fromComponents: 2,
      fromWholeOnHand: 1,
      fromComponentsOnHand: 2,
      fromWholeIncoming: 0,
      fromComponentsIncoming: 0
    });
  });

  test('без целых — только комплектующие с наличия', () => {
    const alloc = allocateKitReservePriority(3, {
      physicalOnHand: 0,
      wholeReserveAvail: 0,
      fromComponents: 5,
      fromComponentsOnHand: 5
    });
    expect(alloc).toEqual({
      kitsToReserve: 3,
      fromWhole: 0,
      fromComponents: 3,
      fromWholeOnHand: 0,
      fromComponentsOnHand: 3,
      fromWholeIncoming: 0,
      fromComponentsIncoming: 0
    });
  });

  test('только целые, комплектующих не хватает', () => {
    const alloc = allocateKitReservePriority(3, {
      physicalOnHand: 2,
      wholeReserveAvail: 2,
      fromComponents: 0,
      fromComponentsOnHand: 0
    });
    expect(alloc).toEqual({
      kitsToReserve: 2,
      fromWhole: 2,
      fromComponents: 0,
      fromWholeOnHand: 2,
      fromComponentsOnHand: 0,
      fromWholeIncoming: 0,
      fromComponentsIncoming: 0
    });
  });

  test('с allowIncoming — комплектующие с наличия раньше целых «в пути»', () => {
    const alloc = allocateKitReservePriority(
      9,
      {
        physicalOnHand: 3,
        wholeReserveAvail: 3,
        wholeAvail: 8,
        wholeIncomingAvail: 5,
        fromComponents: 2,
        fromComponentsOnHand: 2,
        fromComponentsIncoming: 0
      },
      { allowIncoming: true }
    );
    expect(alloc).toEqual({
      kitsToReserve: 9,
      fromWhole: 7,
      fromComponents: 2,
      fromWholeOnHand: 3,
      fromComponentsOnHand: 2,
      fromWholeIncoming: 4,
      fromComponentsIncoming: 0
    });
  });

  test('с allowIncoming — после целых «в пути» комплектующие «в пути»', () => {
    const alloc = allocateKitReservePriority(
      10,
      {
        physicalOnHand: 1,
        wholeReserveAvail: 1,
        wholeAvail: 4,
        wholeIncomingAvail: 3,
        fromComponents: 8,
        fromComponentsOnHand: 2,
        fromComponentsIncoming: 6
      },
      { allowIncoming: true }
    );
    expect(alloc).toEqual({
      kitsToReserve: 10,
      fromWhole: 4,
      fromComponents: 6,
      fromWholeOnHand: 1,
      fromComponentsOnHand: 2,
      fromWholeIncoming: 3,
      fromComponentsIncoming: 4
    });
  });
});

describe('resolveComplementaryKitReserveUnits', () => {
  test('комплементарный резерв 1+2 при заказе 3', () => {
    expect(resolveComplementaryKitReserveUnits(1, 2, 3)).toBe(3);
  });

  test('дубль 3+3 при заказе 3 — max', () => {
    expect(resolveComplementaryKitReserveUnits(3, 3, 3)).toBe(3);
  });

  test('только целые', () => {
    expect(resolveComplementaryKitReserveUnits(2, 0, 3)).toBe(2);
  });
});

describe('kitWholeReserveExcessAtWarehouse', () => {
  test('нет лишнего', () => {
    expect(kitWholeReserveExcessAtWarehouse(3, 3)).toBe(0);
  });

  test('scoped больше global', () => {
    expect(kitWholeReserveExcessAtWarehouse(8, 3)).toBe(5);
  });
});
