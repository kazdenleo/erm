import { normalizeMarketplaceSku } from '../src/utils/marketplaceSku.js';

describe('normalizeMarketplaceSku', () => {
  test('strips trailing semicolon', () => {
    expect(normalizeMarketplaceSku('KN1038K;')).toBe('KN1038K');
  });

  test('keeps numeric nmId', () => {
    expect(normalizeMarketplaceSku('525212139')).toBe('525212139');
  });

  test('null for empty', () => {
    expect(normalizeMarketplaceSku('')).toBeNull();
    expect(normalizeMarketplaceSku(null)).toBeNull();
  });
});
