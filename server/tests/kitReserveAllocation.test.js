import { describe, test, expect } from '@jest/globals';
import {
  allocateKitReservePriority,
  resolveComplementaryKitReserveUnits
} from '../src/services/kitStock.service.js';

describe('allocateKitReservePriority', () => {
  test('1 целый на складе, 3 комплекта в заказе — 1 целый + 2 из комплектующих', () => {
    const alloc = allocateKitReservePriority(3, {
      physicalOnHand: 1,
      wholeReserveAvail: 1,
      fromComponents: 7
    });
    expect(alloc).toEqual({
      kitsToReserve: 3,
      fromWhole: 1,
      fromComponents: 2
    });
  });

  test('без целых — только комплектующие', () => {
    const alloc = allocateKitReservePriority(3, {
      physicalOnHand: 0,
      wholeReserveAvail: 0,
      fromComponents: 5
    });
    expect(alloc).toEqual({
      kitsToReserve: 3,
      fromWhole: 0,
      fromComponents: 3
    });
  });

  test('только целые, комплектующих не хватает', () => {
    const alloc = allocateKitReservePriority(3, {
      physicalOnHand: 2,
      wholeReserveAvail: 2,
      fromComponents: 0
    });
    expect(alloc).toEqual({
      kitsToReserve: 2,
      fromWhole: 2,
      fromComponents: 0
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
