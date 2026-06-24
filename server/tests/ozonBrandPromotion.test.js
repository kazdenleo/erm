import {
  applyOzonBrandPromotionFallback,
  enrichOzonCalculatorFromBrandSettings,
  extractOzonBrandPromotionPercent,
  normalizeOzonBrandPromotionPercent,
} from '../src/utils/ozonBrandPromotion.js';

describe('normalizeOzonBrandPromotionPercent', () => {
  test('treats fraction as percent', () => {
    expect(normalizeOzonBrandPromotionPercent(0.01)).toBe(1);
  });

  test('keeps whole percent', () => {
    expect(normalizeOzonBrandPromotionPercent(1)).toBe(1);
    expect(normalizeOzonBrandPromotionPercent(1.5)).toBe(1.5);
  });
});

describe('extractOzonBrandPromotionPercent', () => {
  test('reads direct commissions field', () => {
    expect(
      extractOzonBrandPromotionPercent({
        commissions: { brand_promotion_percent: 1.2 },
      })
    ).toBe(1.2);
  });

  test('reads fuzzy key', () => {
    expect(
      extractOzonBrandPromotionPercent({
        commissions: { fbs_brand_promotion: 2 },
      })
    ).toBe(2);
  });

  test('returns null when absent', () => {
    expect(
      extractOzonBrandPromotionPercent({
        commissions: { sales_percent_fbs: 32 },
      })
    ).toBeNull();
  });
});

describe('applyOzonBrandPromotionFallback', () => {
  test('does not override positive API value', () => {
    const calc = { brand_promotion_percent: 1.5, brand_promotion_source: 'api' };
    expect(applyOzonBrandPromotionFallback(calc, 1)).toEqual(calc);
  });

  test('overrides zero API value from brand setting', () => {
    const out = applyOzonBrandPromotionFallback({ brand_promotion_percent: 0, brand_promotion_source: 'api' }, 1);
    expect(out.brand_promotion_percent).toBe(1);
    expect(out.brand_promotion_source).toBe('brand');
  });

  test('uses brand setting when API missing', () => {
    const out = applyOzonBrandPromotionFallback({ commissions: {} }, 1);
    expect(out.brand_promotion_percent).toBe(1);
    expect(out.brand_promotion_source).toBe('brand');
  });
});

describe('enrichOzonCalculatorFromBrandSettings', () => {
  test('enriches stored details when brand promo enabled', () => {
    const out = enrichOzonCalculatorFromBrandSettings(
      { commissions: { FBS: { percent: 20 } } },
      { enabled: true, percent: 1 }
    );
    expect(out.brand_promotion_percent).toBe(1);
    expect(out.brand_promotion_source).toBe('brand');
  });

  test('skips when disabled', () => {
    const calc = { commissions: { FBS: { percent: 20 } } };
    expect(enrichOzonCalculatorFromBrandSettings(calc, { enabled: false, percent: 1 })).toBe(calc);
  });
});
