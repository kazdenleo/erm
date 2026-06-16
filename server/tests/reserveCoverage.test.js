import { describe, expect, test } from '@jest/globals';
import { classifyOrderReserveCoverage } from '../src/services/orders.service.js';

describe('classifyOrderReserveCoverage', () => {
  test('полностью со склада', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 5, incoming: 0, reservedRaw: 1, orderReserved: 1 })
    ).toBe('on_hand');
  });

  test('со склада при нескольких резервах', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 2, incoming: 0, reservedRaw: 2, orderReserved: 1 })
    ).toBe('on_hand');
  });

  test('с пути, когда склада не хватает', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 0, incoming: 3, reservedRaw: 1, orderReserved: 1 })
    ).toBe('incoming');
  });

  test('смешанное покрытие — в пути', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 1, incoming: 2, reservedRaw: 2, orderReserved: 2 })
    ).toBe('incoming');
  });

  test('при нулевом incoming в снимке — всё равно в пути, если резерв есть', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 0, incoming: 0, reservedRaw: 1, orderReserved: 1 })
    ).toBe('incoming');
  });

  test('FIFO: incoming занят другими — резерв отображаем как в пути', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 0, incoming: 1, reservedRaw: 3, orderReserved: 2 })
    ).toBe('incoming');
  });
});
