import { toOzonJsonId } from '../src/utils/ozonJsonId.js';

describe('toOzonJsonId', () => {
  test('keeps small integers as number', () => {
    expect(toOzonJsonId('50001234')).toBe(50001234);
    expect(toOzonJsonId(999)).toBe(999);
  });

  test('preserves long Ozon cargo ids as digit strings', () => {
    const id = '1000000000064728284';
    expect(toOzonJsonId(id)).toBe(id);
    expect(toOzonJsonId(id)).not.toBe(Number(id));
  });
});
