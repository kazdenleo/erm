import {
  OZON_COMMISSION_PERCENT_LE100,
  OZON_COMMISSION_PERCENT_LE300,
  OZON_COMMISSION_TIER_300,
  applyOzonPercentAbove300FromOwnPrice,
  attachOzonTierRatesToCalculator,
  computeLearnedOzonLowTierRates,
  extractOzonCommissionTierContext,
  mergeLearnedOzonLowTierRates,
  mergeOzonPercentAbove300,
  modeOfOzonCommissionPercents,
  ozonCommissionPriceTier,
  resolveOzonSalesCommissionPercent,
} from '../src/utils/ozonCommissionTiers.js';
import { calculateMinPrice } from '../src/services/min-price-calculator.service.js';

describe('ozonCommissionTiers', () => {
  test('tiers by price', () => {
    expect(ozonCommissionPriceTier(100)).toBe('le100');
    expect(ozonCommissionPriceTier(101)).toBe('le300');
    expect(ozonCommissionPriceTier(300)).toBe('le300');
    expect(ozonCommissionPriceTier(301)).toBe('gt300');
  });

  test('≤300 uses fixed or API band rate; >300 needs category rate', () => {
    expect(
      resolveOzonSalesCommissionPercent(90, { apiPercent: 17, apiPrice: 90 })
    ).toBe(17);
    expect(
      resolveOzonSalesCommissionPercent(250, { apiPercent: 23, apiPrice: 250 })
    ).toBe(23);
    expect(
      resolveOzonSalesCommissionPercent(250, { apiPercent: 15, apiPrice: 400 })
    ).toBe(OZON_COMMISSION_PERCENT_LE300);
    expect(
      resolveOzonSalesCommissionPercent(337, {
        apiPercent: 23,
        apiPrice: 250,
        percentAbove300: 15,
      })
    ).toBe(15);
    expect(
      resolveOzonSalesCommissionPercent(337, { apiPercent: 23, apiPrice: 250 })
    ).toBeNull();
    // Legacy без basis: 23% — это mid-tier, не категория
    expect(resolveOzonSalesCommissionPercent(337, { apiPercent: 23 })).toBeNull();
    expect(resolveOzonSalesCommissionPercent(337, { apiPercent: 17 })).toBeNull();
    // Legacy без basis: высокий % считаем категориальным
    expect(resolveOzonSalesCommissionPercent(337, { apiPercent: 47 })).toBe(47);
    expect(
      resolveOzonSalesCommissionPercent(400, { apiPercent: 12, apiPrice: 400 })
    ).toBe(12);
  });

  test('applyOzonPercentAbove300FromOwnPrice when price >300', () => {
    const calc = applyOzonPercentAbove300FromOwnPrice({
      price: 450,
      commission_price_basis: 450,
      commissions: { FBS: { percent: 14, value: 0 } },
    });
    expect(calc.commissions.FBS.percent_above_300).toBe(14);
  });

  test('mergeOzonPercentAbove300 does not overwrite existing', () => {
    const merged = mergeOzonPercentAbove300(
      {
        commissions: {
          FBS: { percent: 23, percent_above_300: 11 },
        },
      },
      { FBS: 18 }
    );
    expect(merged.commissions.FBS.percent_above_300).toBe(11);
    const filled = mergeOzonPercentAbove300(
      { commissions: { FBS: { percent: 23 } } },
      { FBS: 18 }
    );
    expect(filled.commissions.FBS.percent_above_300).toBe(18);
  });
});

describe('calculateMinPrice Ozon price tiers', () => {
  const taxProfile = { vatRate: 0, incomeTaxRate: 0, incomeTaxOnRevenue: false };

  const cheapSkuCalculator = {
    price: 250,
    commission_price_basis: 250,
    acquiring: 1,
    processing_cost: 0,
    logistics_cost: 13,
    commissions: {
      FBS: {
        percent: 23,
        value: 0,
        delivery_amount: 25,
        return_amount: 0,
        first_mile_amount: 0,
        direct_flow_trans_amount: 13,
      },
    },
  };

  test('cheap SKU without percent_above_300 fails closed when min would exceed 300', () => {
    const price = calculateMinPrice(
      149,
      cheapSkuCalculator,
      'ozon',
      50,
      { buyout_rate_ozon: 100 },
      null,
      null,
      taxProfile,
      'FBS',
      0
    );
    // С 23% мин. цена для такой базы обычно >300; без категориальной ставки — null
    if (price != null) {
      expect(price).toBeLessThanOrEqual(OZON_COMMISSION_TIER_300);
    } else {
      expect(price).toBeNull();
    }
  });

  test('cheap SKU + percent_above_300 uses category rate above 300, not 23%', () => {
    const calc = {
      ...cheapSkuCalculator,
      commissions: {
        FBS: {
          ...cheapSkuCalculator.commissions.FBS,
          percent_above_300: 12,
        },
      },
    };
    const ctx = extractOzonCommissionTierContext(calc, 'FBS');
    expect(resolveOzonSalesCommissionPercent(337, ctx)).toBe(12);
    expect(resolveOzonSalesCommissionPercent(250, ctx)).toBe(23);

    const price = calculateMinPrice(
      149,
      calc,
      'ozon',
      50,
      { buyout_rate_ozon: 100 },
      null,
      null,
      taxProfile,
      'FBS',
      0
    );
    expect(price).not.toBeNull();
    expect(price).toBeGreaterThan(OZON_COMMISSION_TIER_300);
    // При 23% комиссия была бы выше → мин. цена заметно больше, чем при 12%
    const priceWith23Only = calculateMinPrice(
      149,
      {
        ...cheapSkuCalculator,
        // симулируем старое поведение: одна ставка 23% и «как будто» цена API >300
        price: 400,
        commission_price_basis: 400,
        commissions: {
          FBS: { ...cheapSkuCalculator.commissions.FBS, percent: 23, percent_above_300: 23 },
        },
      },
      'ozon',
      50,
      { buyout_rate_ozon: 100 },
      null,
      null,
      taxProfile,
      'FBS',
      0
    );
    expect(priceWith23Only).not.toBeNull();
    expect(price).toBeLessThan(priceWith23Only);
  });

  test('defaults for empty API band still use published 17/23', () => {
    expect(OZON_COMMISSION_PERCENT_LE100).toBe(17);
    expect(OZON_COMMISSION_PERCENT_LE300).toBe(23);
    expect(
      resolveOzonSalesCommissionPercent(50, { apiPercent: 12, apiPrice: 500 })
    ).toBe(17);
  });

  test('learned tier_rates override hardcoded fallbacks when API band unknown', () => {
    const calc = attachOzonTierRatesToCalculator(
      { commissions: { FBS: { percent: 12, percent_above_300: 12 } }, price: 500, commission_price_basis: 500 },
      { le100: 18, le300: 25, source: 'learned_api' }
    );
    const ctx = extractOzonCommissionTierContext(calc, 'FBS');
    expect(resolveOzonSalesCommissionPercent(80, ctx)).toBe(18);
    expect(resolveOzonSalesCommissionPercent(200, ctx)).toBe(25);
    expect(resolveOzonSalesCommissionPercent(400, ctx)).toBe(12);
  });
});

describe('learn Ozon low-tier rates from API samples', () => {
  test('mode picks dominant percent per band', () => {
    expect(modeOfOzonCommissionPercents([23, 23, 23, 20, 23])).toBe(23);
    const learned = computeLearnedOzonLowTierRates(
      [
        { price: 90, percentFbs: 17 },
        { price: 80, percentFbs: 17 },
        { price: 95, percentFbs: 17 },
        { price: 200, percentFbs: 23 },
        { price: 250, percentFbs: 23 },
        { price: 280, percentFbs: 23 },
        { price: 400, percentFbs: 12 },
      ],
      { minSamples: 3 }
    );
    expect(learned.le100).toBe(17);
    expect(learned.le300).toBe(23);
    expect(learned.samplesLe100).toBe(3);
    expect(learned.samplesLe300).toBe(3);
  });

  test('merge keeps previous when new band has too few samples', () => {
    const merged = mergeLearnedOzonLowTierRates(
      { le100: 17, le300: 23 },
      { le100: null, le300: 25 }
    );
    expect(merged.le100).toBe(17);
    expect(merged.le300).toBe(25);
  });

  test('does not learn band with fewer than minSamples', () => {
    const learned = computeLearnedOzonLowTierRates(
      [
        { price: 90, percentFbs: 19 },
        { price: 200, percentFbs: 24 },
        { price: 210, percentFbs: 24 },
        { price: 220, percentFbs: 24 },
      ],
      { minSamples: 3 }
    );
    expect(learned.le100).toBeNull();
    expect(learned.le300).toBe(24);
  });
});
