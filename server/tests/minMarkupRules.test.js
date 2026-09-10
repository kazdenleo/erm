import {
  parseMinMarkupRules,
  resolveMinMarkupFromRules,
  markupRubFromTier,
} from '../src/utils/minMarkupRules.js';
import { resolveMarketplaceMinProfit } from '../src/utils/marketplaceMinProfit.js';
import { isProductInPricePushScope, parsePricePushSettings } from '../src/utils/pricePushSettings.js';

describe('minMarkupRules', () => {
  it('resolves percent and rub tiers by cost', () => {
    const rules = parseMinMarkupRules([
      {
        id: '1',
        scope: 'all',
        tiers: [
          { costFrom: 0, costTo: 1000, mode: 'percent', value: 50 },
          { costFrom: 1000, costTo: null, mode: 'rub', value: 200 },
        ],
      },
    ]);
    expect(resolveMinMarkupFromRules({ id: 1, cost: 400 }, rules).rub).toBe(200);
    expect(resolveMinMarkupFromRules({ id: 1, cost: 1500 }, rules).rub).toBe(200);
    expect(markupRubFromTier(400, { mode: 'percent', value: 50 })).toBe(200);
  });

  it('applies optional minRub floor', () => {
    expect(markupRubFromTier(40, { mode: 'percent', value: 50, minRub: 80 })).toBe(80);
    expect(markupRubFromTier(400, { mode: 'percent', value: 50, minRub: 80 })).toBe(200);
    const rules = parseMinMarkupRules([
      {
        id: '1',
        scope: 'all',
        tiers: [{ costFrom: 0, costTo: 100, mode: 'percent', value: 50, minRub: 100 }],
      },
    ]);
    expect(resolveMinMarkupFromRules({ id: 1, cost: 40 }, rules).rub).toBe(100);
  });

  it('prefers product scope over all', () => {
    const rules = parseMinMarkupRules([
      { id: 'all', scope: 'all', tiers: [{ costFrom: 0, costTo: null, mode: 'rub', value: 10 }] },
      {
        id: 'p',
        scope: 'products',
        productIds: [5],
        tiers: [{ costFrom: 0, costTo: null, mode: 'rub', value: 99 }],
      },
    ]);
    expect(resolveMinMarkupFromRules({ id: 5, cost: 100 }, rules).rub).toBe(99);
    expect(resolveMinMarkupFromRules({ id: 6, cost: 100 }, rules).rub).toBe(10);
  });

  it('respects rule excludeProductIds', () => {
    const rules = parseMinMarkupRules([
      {
        id: 'all',
        scope: 'all',
        excludeProductIds: [7],
        tiers: [{ costFrom: 0, costTo: null, mode: 'rub', value: 50 }],
      },
    ]);
    expect(resolveMinMarkupFromRules({ id: 7, cost: 100 }, rules)).toBeNull();
  });

  it('does not apply a card min_price of 150 when a cheaper-cost rule matches', () => {
    const rules = parseMinMarkupRules([
      {
        id: 'cheap',
        scope: 'all',
        tiers: [{ costFrom: 0, costTo: 100, mode: 'rub', value: 40 }],
      },
    ]);
    expect(resolveMinMarkupFromRules({ id: 11401, cost: 80, min_price: 150 }, rules).rub).toBe(40);
    expect(resolveMinMarkupFromRules({ id: 11401, cost: 120, min_price: 150 }, rules)).toBeNull();
    expect(
      resolveMarketplaceMinProfit(
        {
          id: 11401,
          cost: 80,
          min_price: 150,
          min_profit_ozon: 200,
          profileMinMarkupRules: rules,
        },
        'ozon',
        50
      )
    ).toBe(40);
  });
});

describe('price push exclusions', () => {
  it('isProductInPricePushScope excludes listed products', () => {
    const settings = parsePricePushSettings({
      scope: 'all',
      excludeProductIds: [10, 11],
    });
    expect(isProductInPricePushScope({ id: 9 }, settings)).toBe(true);
    expect(isProductInPricePushScope({ id: 10 }, settings)).toBe(false);
  });
});
