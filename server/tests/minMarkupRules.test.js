import {
  parseMinMarkupRules,
  resolveMinMarkupFromRules,
  markupRubFromTier,
} from '../src/utils/minMarkupRules.js';
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
