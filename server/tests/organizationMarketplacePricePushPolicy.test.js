import { parseEnabledFlag, normalizeId } from '../src/utils/organizationMarketplacePricePushPolicy.js';

describe('organizationMarketplacePricePushPolicy', () => {
  test('normalizeId', () => {
    expect(normalizeId(3)).toBe(3);
    expect(normalizeId('12')).toBe(12);
    expect(normalizeId(null)).toBeNull();
    expect(normalizeId(0)).toBeNull();
  });

  test('parseEnabledFlag defaults to false', () => {
    expect(parseEnabledFlag(null)).toBe(false);
    expect(parseEnabledFlag({})).toBe(false);
    expect(parseEnabledFlag({ auto_push_marketplace_prices: false })).toBe(false);
    expect(parseEnabledFlag({ auto_push_marketplace_prices: true })).toBe(true);
    expect(parseEnabledFlag({ autoPushMarketplacePrices: '1' })).toBe(true);
  });
});
