import { orderMultipleFromKits, toOrderRounded } from '../src/utils/stockRunwayMath.js';

describe('orderMultipleFromKits', () => {
  test('есть прямые продажи — шаг 1', () => {
    expect(orderMultipleFromKits(5, [2])).toBe(1);
    expect(orderMultipleFromKits(1, [2, 2])).toBe(1);
  });

  test('только комплекты по 2 — шаг 2', () => {
    expect(orderMultipleFromKits(0, [2])).toBe(2);
    expect(orderMultipleFromKits(0, [2, 2])).toBe(2);
  });

  test('разные комплекты — НОД', () => {
    expect(orderMultipleFromKits(0, [2, 4])).toBe(2);
    expect(orderMultipleFromKits(0, [2, 3])).toBe(1);
  });

  test('нет комплектов — шаг 1', () => {
    expect(orderMultipleFromKits(0, [])).toBe(1);
    expect(orderMultipleFromKits(0, null)).toBe(1);
  });
});

describe('toOrderRounded', () => {
  test('TG-5119: нужно 5 при нуле — заказать 6', () => {
    expect(toOrderRounded({ need: 5, available: 0, incoming: 0, orderMultiple: 2 })).toBe(6);
  });

  test('с остатком 1 нужно 5 — докрутить до чётного итого', () => {
    expect(toOrderRounded({ need: 5, available: 1, incoming: 0, orderMultiple: 2 })).toBe(5);
  });

  test('есть прямые продажи / шаг 1 — без округления', () => {
    expect(toOrderRounded({ need: 5, available: 0, incoming: 0, orderMultiple: 1 })).toBe(5);
  });

  test('уже хватает — не заказывать ради кратности', () => {
    expect(toOrderRounded({ need: 5, available: 5, incoming: 0, orderMultiple: 2 })).toBe(0);
  });

  test('учёт в пути', () => {
    expect(toOrderRounded({ need: 5, available: 0, incoming: 1, orderMultiple: 2 })).toBe(5);
  });
});
