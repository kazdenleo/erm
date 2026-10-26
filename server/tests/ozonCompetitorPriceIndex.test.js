import { parseOzonCompetitorPriceIndex } from '../src/utils/ozonCompetitorPriceIndex.js';

describe('Ozon competitor price index', () => {
  test('reads competitor min price, not our price', () => {
    const parsed = parseOzonCompetitorPriceIndex({
      price: { price: '1990', marketing_seller_price: '1800' },
      price_indexes: {
        color_index: 'COLOR_INDEX_RED',
        ozon_index_data: {
          min_price: '1490.5',
          min_price_currency: 'RUB',
          price_index_value: 1.12,
        },
        external_index_data: { minimal_price: '1400' },
        self_marketplaces_index_data: { min_price: '2100' },
      },
    });
    expect(parsed).toEqual({
      competitor_min_price: 1490.5,
      external_min_price: 1400,
      price_index_value: 1.12,
      color_index: 'RED',
    });
  });

  test('empty index is nulls', () => {
    expect(parseOzonCompetitorPriceIndex({ price: { price: '100' } })).toEqual({
      competitor_min_price: null,
      external_min_price: null,
      price_index_value: null,
      color_index: null,
    });
  });

  test('ignores zero prices', () => {
    const parsed = parseOzonCompetitorPriceIndex({
      price_indexes: {
        color_index: 'WITHOUT_INDEX',
        ozon_index_data: { min_price: '0' },
      },
    });
    expect(parsed.competitor_min_price).toBeNull();
    expect(parsed.color_index).toBe('WITHOUT_INDEX');
  });
});
