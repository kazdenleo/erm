import {
  normalizeOzonAdsPercent,
  computeDrrPercent,
  applyOzonAdsPromotion,
} from '../src/utils/ozonAdsPromotion.js';

describe('ozonAdsPromotion', () => {
  test('normalize percent', () => {
    expect(normalizeOzonAdsPercent(0.08)).toBe(8);
    expect(normalizeOzonAdsPercent(8)).toBe(8);
    expect(normalizeOzonAdsPercent(-1)).toBe(null);
  });

  test('compute DRR', () => {
    expect(computeDrrPercent(800, 10000)).toBe(8);
    expect(computeDrrPercent(100, 100)).toBe(null); // below min revenue
    expect(computeDrrPercent(0, 10000)).toBe(0);
  });

  test('apply to calculator', () => {
    const out = applyOzonAdsPromotion({ commissions: {} }, 7.5, 'ads');
    expect(out.ads_promotion_percent).toBe(7.5);
    expect(out.ads_promotion_source).toBe('ads');
  });
});
