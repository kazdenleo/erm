import { wbOrderPriceToRub, normalizeWbOrderDetailPrices } from '../src/services/orders.sync.service.js';

describe('wbOrderPriceToRub', () => {
  test('divides WB kopecks to rubles', () => {
    expect(wbOrderPriceToRub({ convertedPrice: 152900 })).toBe(1529);
    expect(wbOrderPriceToRub({ price: 10000 })).toBe(100);
    expect(wbOrderPriceToRub({ convertedFinalPrice: 80850, convertedPrice: 90000 })).toBe(808.5);
  });

  test('prefers convertedFinalPrice then convertedPrice', () => {
    expect(wbOrderPriceToRub({ convertedFinalPrice: 20000, convertedPrice: 30000, price: 40000 })).toBe(200);
  });

  test('handles empty', () => {
    expect(wbOrderPriceToRub(null)).toBe(0);
    expect(wbOrderPriceToRub({})).toBe(0);
  });
});

describe('normalizeWbOrderDetailPrices', () => {
  test('converts live API fields to rubles', () => {
    const out = normalizeWbOrderDetailPrices({
      id: 1,
      price: 10000,
      convertedPrice: 9900,
    });
    expect(out.price).toBe(100);
    expect(out.convertedPrice).toBe(99);
    expect(out.priceRub).toBe(99);
  });
});
