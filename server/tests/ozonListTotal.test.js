import { ozonListTotal } from '../src/utils/ozonSellerApi.js';

describe('ozonListTotal', () => {
  test('prefers total_items over deprecated total', () => {
    expect(ozonListTotal({ result: { total_items: 42, total: 1 } })).toBe(42);
    expect(ozonListTotal({ total_items: 10, total: 99 })).toBe(10);
  });

  test('falls back to total then count', () => {
    expect(ozonListTotal({ result: { total: 7 } })).toBe(7);
    expect(ozonListTotal({ result: { count: 3 } })).toBe(3);
  });

  test('uses fallback when missing', () => {
    expect(ozonListTotal({}, 5)).toBe(5);
    expect(ozonListTotal(null, 0)).toBe(0);
  });
});
