import {
  computeSellingPriceFromInputs,
  defaultStrategyConfig,
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

  test('ceiling wins even if below floor', () => {
    const r = computeSellingPriceFromInputs({
      mode: 'floor',
      config: {},
      floor: 1500,
      cost: 300,
      ceiling: 1000,
    });
    expect(r.sellingPrice).toBe(1000);
    expect(r.cappedByCeiling).toBe(true);
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
});
