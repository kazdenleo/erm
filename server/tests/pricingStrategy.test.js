import {
  computeSellingPriceFromInputs,
  defaultStrategyConfig,
  normalizeStrategyMarketplace,
  resolveTargetMarginPrice,
  rulePriority,
} from '../src/services/pricingStrategy.service.js';

describe('pricingStrategy computeSellingPriceFromInputs', () => {
  test('floor mode equals floor', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'floor',
      config: {},
      floor: 900.2,
      cost: 300,
    });
    expect(r.sellingPrice).toBe(901);
    expect(r.floor).toBe(901);
  });

  test('competitor undercut on wb', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'competitor',
      config: defaultStrategyConfig('competitor'),
      floor: 800,
      cost: 300,
      competitorPrices: [1000, 1100],
      marketplace: 'wb',
    });
    // min 1000 * 0.99 = 990
    expect(r.sellingPrice).toBe(990);
  });

  test('ozon skips competitor and stays at floor for competitor mode', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'competitor',
      config: defaultStrategyConfig('competitor'),
      floor: 800,
      cost: 300,
      competitorPrices: [1000],
      marketplace: 'ozon',
    });
    expect(r.sellingPrice).toBe(800);
  });

  test('never below floor', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'competitor',
      config: {
        ...defaultStrategyConfig('competitor'),
        competitor: { enabled: true, agg: 'min', offset_percent: -50, offset_rub: 0 },
      },
      floor: 900,
      cost: 300,
      competitorPrices: [1000],
      marketplace: 'wb',
    });
    expect(r.sellingPrice).toBe(900);
  });

  test('sales high raises price', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'sales',
      config: defaultStrategyConfig('sales'),
      floor: 1000,
      cost: 300,
      velocity: { perDay: 5, soldQty: 70, windowDays: 14 },
      previousSelling: 1000,
      marketplace: 'wb',
    });
    expect(r.sellingPrice).toBeGreaterThan(1000);
  });

  test('ceiling caps strategy above max price', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'competitor',
      config: defaultStrategyConfig('competitor'),
      floor: 800,
      cost: 300,
      competitorPrices: [2000],
      marketplace: 'wb',
      ceiling: 1200,
    });
    // min 2000 * 0.99 = 1980 → потолок 1200
    expect(r.sellingPrice).toBe(1200);
    expect(r.ceiling).toBe(1200);
    expect(r.cappedByCeiling).toBe(true);
  });

  test('ceiling below floor does not lower the price', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'floor',
      config: {},
      floor: 1500,
      cost: 300,
      ceiling: 1000,
    });
    expect(r.sellingPrice).toBe(1500);
    expect(r.cappedByCeiling).toBe(false);
    expect(r.ceilingBelowFloor).toBe(true);
    expect(r.details.steps.some((s) => s.step === 'ceiling_below_floor')).toBe(true);
  });

  test('band hold does not keep previous above ceiling', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'floor',
      config: { band_percent: 10, max_change_percent: null },
      floor: 1000,
      cost: 300,
      previousSelling: 1005,
      ceiling: 1000,
    });
    expect(r.sellingPrice).toBe(1000);
    expect(r.heldByBand).toBe(false);
  });

  test('normalizeStrategyMarketplace maps aliases', () => {
    expect(normalizeStrategyMarketplace('wildberries')).toBe('wb');
    expect(normalizeStrategyMarketplace('yandex')).toBe('ym');
    expect(normalizeStrategyMarketplace('ozon')).toBe('ozon');
    expect(normalizeStrategyMarketplace('all')).toBe(null);
  });

  test('rulePriority prefers product+marketplace over brand', () => {
    expect(rulePriority('product', 'wb')).toBeGreaterThan(rulePriority('product', null));
    expect(rulePriority('product', null)).toBeGreaterThan(rulePriority('brand', 'wb'));
    expect(rulePriority('brand', null)).toBeGreaterThan(rulePriority('category', null));
    expect(rulePriority('category', null)).toBeGreaterThan(rulePriority('profile', null));
  });

  test('target margin without calculator raises above floor', () => {
    expect(resolveTargetMarginPrice({ marginPercent: 10, floor: 1000, cost: 300 })).toBe(1100);
  });

  test('target_margin mode uses marketplace target price when provided', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'target_margin',
      config: { target_margin_percent: 10, band_percent: 0, max_change_percent: null },
      floor: 1000,
      cost: 300,
      targetMarginPrice: 1300,
      previousSelling: 1000,
    });
    expect(r.sellingPrice).toBe(1300);
  });

  test('band does not block climb toward target_margin', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'target_margin',
      config: { target_margin_percent: 10, band_percent: 2, max_change_percent: null },
      floor: 2800,
      cost: 1000,
      targetMarginPrice: 2878,
      previousSelling: 2831,
    });
    expect(r.sellingPrice).toBe(2878);
    expect(r.heldByBand).toBe(false);
  });

  test('resolveTargetMarginPrice rises when buyout is lower than default 95', () => {
    const calc = {
      acquiring: 1,
      brand_promotion_percent: 1,
      logistics_cost: 63,
      processing_cost: 0,
      commissions: {
        FBS: {
          percent: 47,
          return_amount: 623,
          delivery_amount: 25,
          direct_flow_trans_amount: 63,
        },
      },
    };
    const atDefaultBuyout = resolveTargetMarginPrice({
      marginPercent: 10,
      floor: 3022,
      cost: 1047.54,
      additionalExpenses: 10,
      calculator: calc,
      marketplace: 'ozon',
      product: {},
      scheme: 'FBS',
      sppPercent: 20,
      taxProfile: { vatRate: 0, incomeTaxRate: 0.15, incomeTaxOnRevenue: false },
    });
    const at50Buyout = resolveTargetMarginPrice({
      marginPercent: 10,
      floor: 3022,
      cost: 1047.54,
      additionalExpenses: 10,
      calculator: calc,
      marketplace: 'ozon',
      product: { buyout_rate: 50 },
      scheme: 'FBS',
      sppPercent: 20,
      taxProfile: { vatRate: 0, incomeTaxRate: 0.15, incomeTaxOnRevenue: false },
    });
    expect(at50Buyout).toBeGreaterThan(atDefaultBuyout);
    expect(at50Buyout).toBeGreaterThan(3022);
  });
});
