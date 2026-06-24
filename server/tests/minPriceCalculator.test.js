import { calculateMinPrice } from '../src/services/min-price-calculator.service.js';

const baseCalculator = {
  acquiring: 1,
  processing_cost: 30,
  logistics_cost: 519,
  commissions: {
    FBS: { percent: 44, first_mile_amount: 30, direct_flow_trans_amount: 519 },
  },
};

const product = {
  cost: 653.25,
  minPrice: 50,
  organization_tax_system: null,
  organization_vat: 'NO_VAT',
};

describe('calculateMinPrice brand promotion', () => {
  test('includes brand promotion in price so net profit meets target', () => {
    const without = calculateMinPrice(653.25, baseCalculator, 'ozon', 50, product);
    const withPromo = calculateMinPrice(
      653.25,
      { ...baseCalculator, brand_promotion_percent: 1, brand_promotion_source: 'brand' },
      'ozon',
      50,
      product
    );
    expect(without).not.toBeNull();
    expect(withPromo).not.toBeNull();
    expect(withPromo).toBeGreaterThan(without);

    const commission = 0.44;
    const acquiring = 0.01;
    const brand = 0.01;
    const price = withPromo;
    const mp =
      30 + 519 + price * commission + Math.ceil(price * acquiring) + price * brand;
    const net = price - 653.25 - mp;
    expect(net).toBeGreaterThanOrEqual(49.5);
    expect(net).toBeLessThanOrEqual(51);
  });
});
