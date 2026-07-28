import {
  ymWeightGramsToKg,
  extractMinPriceCommissionPercent,
  hasUsableCommissionPercent,
  shouldSkipEmptyCategoryOverwrite,
  shouldSkipEmptyCalculatorOverwrite,
  isCommissionCacheStale,
  evaluateCommissionRefreshHealth,
  notifyCommissionIssue,
  _resetNotifyCooldownForTests,
  COMMISSION_CACHE_STALE_DAYS,
} from '../src/utils/commissionGuards.js';
import { calculateMinPrice } from '../src/services/min-price-calculator.service.js';

describe('ymWeightGramsToKg', () => {
  test('converts grams to kg with 3 decimals', () => {
    expect(ymWeightGramsToKg(1000)).toBe(1);
    expect(ymWeightGramsToKg(1500)).toBe(1.5);
    expect(ymWeightGramsToKg(1234)).toBe(1.234);
    expect(ymWeightGramsToKg(1)).toBe(0.001);
  });

  test('rejects invalid weight', () => {
    expect(ymWeightGramsToKg(null)).toBeNull();
    expect(ymWeightGramsToKg('')).toBeNull();
    expect(ymWeightGramsToKg('abc')).toBeNull();
  });
});

describe('shouldSkipEmptyCategoryOverwrite', () => {
  test('blocks good → empty', () => {
    expect(
      shouldSkipEmptyCategoryOverwrite([{ key: 'FBS', percent: 32 }], [])
    ).toBe(true);
  });

  test('allows empty → empty and good → good', () => {
    expect(shouldSkipEmptyCategoryOverwrite([], [])).toBe(false);
    expect(
      shouldSkipEmptyCategoryOverwrite([{ key: 'FBS', percent: 32 }], [{ key: 'FBS', percent: 33 }])
    ).toBe(false);
  });

  test('allows first write of empty when nothing stored', () => {
    expect(shouldSkipEmptyCategoryOverwrite(null, [])).toBe(false);
  });
});

describe('shouldSkipEmptyCalculatorOverwrite / hasUsableCommissionPercent', () => {
  const goodOzon = { commissions: { FBS: { percent: 35 } } };
  const emptyCalc = { commissions: { FBS: { percent: 0 } } };
  const missingCalc = { commissions: {} };

  test('detects usable commission', () => {
    expect(hasUsableCommissionPercent(goodOzon, 'ozon')).toBe(true);
    expect(hasUsableCommissionPercent(emptyCalc, 'ozon')).toBe(false);
    expect(hasUsableCommissionPercent(missingCalc, 'ozon')).toBe(false);
    expect(extractMinPriceCommissionPercent(goodOzon, 'ozon')).toBe(35);
  });

  test('WB uses FBO for min price', () => {
    const wb = { commissions: { FBO: { percent: 28 }, FBS: { percent: 40 } } };
    expect(extractMinPriceCommissionPercent(wb, 'wb')).toBe(28);
    expect(hasUsableCommissionPercent(wb, 'wb')).toBe(true);
  });

  test('blocks good calculator → empty overwrite', () => {
    expect(shouldSkipEmptyCalculatorOverwrite(goodOzon, emptyCalc, 'ozon')).toBe(true);
    expect(shouldSkipEmptyCalculatorOverwrite(goodOzon, missingCalc, 'ozon')).toBe(true);
    expect(shouldSkipEmptyCalculatorOverwrite(emptyCalc, goodOzon, 'ozon')).toBe(false);
  });
});

describe('calculateMinPrice refuses zero commission', () => {
  const base = {
    acquiring: 1,
    processing_cost: 30,
    logistics_cost: 100,
    commissions: { FBS: { percent: 0, delivery_amount: 0, return_amount: 0 } },
  };

  test('returns null instead of inventing default / underpricing', () => {
    const price = calculateMinPrice(500, base, 'ozon', 50, {
      organization_tax_system: null,
      organization_vat: 'NO_VAT',
    });
    expect(price).toBeNull();
  });

  test('still calculates with real commission', () => {
    const price = calculateMinPrice(
      500,
      { ...base, commissions: { FBS: { percent: 35, delivery_amount: 0, return_amount: 0 } } },
      'ozon',
      50,
      { organization_tax_system: null, organization_vat: 'NO_VAT' }
    );
    expect(price).not.toBeNull();
    expect(price).toBeGreaterThan(500);
  });
});

describe('evaluateCommissionRefreshHealth', () => {
  test('flags empty rise and failure', () => {
    expect(
      evaluateCommissionRefreshHealth({
        beforeFilled: 10,
        beforeEmpty: 1,
        afterFilled: 8,
        afterEmpty: 3,
      }).unhealthy
    ).toBe(true);

    expect(
      evaluateCommissionRefreshHealth({
        beforeFilled: 10,
        beforeEmpty: 1,
        afterFilled: 10,
        afterEmpty: 1,
        error: 'boom',
      }).failed
    ).toBe(true);

    expect(
      evaluateCommissionRefreshHealth({
        beforeFilled: 10,
        beforeEmpty: 2,
        afterFilled: 12,
        afterEmpty: 0,
      }).unhealthy
    ).toBe(false);
  });
});

describe('isCommissionCacheStale', () => {
  test('stale when older than N days or missing', () => {
    expect(isCommissionCacheStale(null, 5)).toBe(true);
    const old = new Date(Date.now() - (COMMISSION_CACHE_STALE_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(isCommissionCacheStale(old, COMMISSION_CACHE_STALE_DAYS)).toBe(true);
    const fresh = new Date();
    expect(isCommissionCacheStale(fresh, COMMISSION_CACHE_STALE_DAYS)).toBe(false);
  });
});

describe('notifyCommissionIssue on refresh failure path', () => {
  beforeEach(() => {
    _resetNotifyCooldownForTests();
  });

  test('emits commission_refresh_failed type', async () => {
    const n = await notifyCommissionIssue({
      type: 'commission_refresh_failed',
      severity: 'error',
      force: true,
      message: 'test refresh failed',
      source: 'test',
    });
    expect(n).not.toBeNull();
    expect(n.type).toBe('commission_refresh_failed');
    expect(n.message).toContain('test refresh failed');
  });
});
