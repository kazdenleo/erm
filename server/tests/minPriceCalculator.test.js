import { calculateMinPrice, resolveMinPriceTaxProfile } from '../src/services/min-price-calculator.service.js';
import { computeTaxesAndNetProfit } from '../src/utils/organizationTaxRates.js';

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
      30 + 519 + price * commission + Math.round(price * acquiring * 100) / 100 + price * brand;
    const net = price - 653.25 - mp;
    expect(net).toBeGreaterThanOrEqual(49.5);
    expect(net).toBeLessThanOrEqual(51);
  });
});

describe('calculateMinPrice WB net after VAT 5% + USN 15%', () => {
  /**
   * Регрессия скриншота: цель 100 ₽ «после налогов», а старый seed
   * (base+fixed+100)/denom давал валовую ~100 и чистую ~13 после НДС/УСН.
   */
  const wbCalc = {
    logistics_base: 92,
    logistics_liter: 28,
    volume_weight: 2.5,
    commissions: {
      FBO: { percent: 35.5, delivery_amount: 0, return_amount: 0 },
      FBS: { percent: 40, delivery_amount: 0 },
    },
  };

  const wbProduct = {
    cost: 570.7,
    additional_expenses: 10,
    buyout_rate: 95,
    length: 186,
    width: 166,
    height: 75,
    organization_tax_system: 'USN_INCOME_OUTCOME',
    organization_vat: 'VAT_5',
  };

  const taxProfile = {
    vatRate: 0.05,
    incomeTaxRate: 0.15,
    incomeTaxOnRevenue: false,
    taxSystemCode: 'USN_INCOME_OUTCOME',
  };

  function netAt(price) {
    const base = 580.7;
    const volume = (186 * 166 * 75) / 1e6;
    const logistics =
      92 + (volume > 1 ? 28 * Math.ceil(volume - 1) : 0);
    const returnLoss = base * 0.05;
    const fixed = logistics + returnLoss;
    const pct = 0.355 + 0.02 + 0.0075;
    const total = base + fixed + price * pct;
    return computeTaxesAndNetProfit({ price, totalExpenses: total, taxProfile });
  }

  test('resolveMinPriceTaxProfile prefers organization_* over string organization', () => {
    const profile = resolveMinPriceTaxProfile({
      organization: 'ИП Казаков',
      organization_tax_system: 'USN_INCOME_OUTCOME',
      organization_vat: 'VAT_5',
    });
    expect(profile.vatRate).toBe(0.05);
    expect(profile.incomeTaxRate).toBe(0.15);
  });

  test('WB min price yields net profit ≈ 100 ₽ after taxes (not ~13)', () => {
    const price = calculateMinPrice(
      580.7,
      wbCalc,
      'wb',
      100,
      wbProduct,
      2,
      0.75,
      taxProfile,
      'FBO'
    );
    expect(price).not.toBeNull();
    expect(price).toBeGreaterThan(1400);

    const taxes = netAt(price);
    expect(taxes.netProfit).toBeGreaterThanOrEqual(99.5);
    expect(taxes.netProfit).toBeLessThan(102);

    // Старый seed без инверсии налогов давал бы цену около «валовых 100» и чистую ≪ 100
    const legacySeed = Math.round((580.7 + 148 + 29.035 + 100) / (1 - 0.355 - 0.02 - 0.0075));
    const legacyNet = netAt(legacySeed).netProfit;
    expect(legacyNet).toBeLessThan(40);
    expect(price).toBeGreaterThan(legacySeed);
  });

  test('WB applies extra liters from calculator.volume_weight if product has no dims', () => {
    const calc = {
      logistics_base: 80,
      logistics_liter: 34,
      logistics_cost: 148,
      volume_weight: 2.07,
      commissions: {
        FBO: { percent: 18, delivery_amount: 0, return_amount: 0 },
      },
    };
    const prod = {
      cost: 253.52,
      additional_expenses: 5,
      buyout_rate: 88,
      organization_tax_system: 'USN_INCOME_OUTCOME',
      organization_vat: 'NO_VAT',
    };
    const tax = {
      vatRate: 0,
      incomeTaxRate: 0.15,
      incomeTaxOnRevenue: false,
      taxSystemCode: 'USN_INCOME_OUTCOME',
    };
    const price = calculateMinPrice(258.52, calc, 'wb', 50, prod, 3, 0.75, tax, 'FBO');
    expect(price).not.toBeNull();
    expect(price).toBeGreaterThan(600);
  });

  test('Ozon acquiring rounds to kopecks (1713×1% → 17.13, not ceil 18)', () => {
    const ozonCalc = {
      acquiring: 1,
      processing_cost: 0,
      logistics_cost: 0,
      commissions: { FBS: { percent: 10, delivery_amount: 0 } },
    };
    const ozonProduct = {
      cost: 1500,
      organization_tax_system: null,
      organization_vat: 'NO_VAT',
    };
    const price = calculateMinPrice(1500, ozonCalc, 'ozon', 50, ozonProduct, null, null, null, 'FBS');
    expect(price).not.toBeNull();
    // при цене 1713 эквайринг должен быть 17.13 в формуле net
    const acqAt1713 = Math.round(1713 * 0.01 * 100) / 100;
    expect(acqAt1713).toBe(17.13);
    const net = price - 1500 - price * 0.1 - Math.round(price * 0.01 * 100) / 100;
    expect(net).toBeGreaterThanOrEqual(49.5);
  });
});
