import {
  filtersFromPricePushSettings,
  parsePricePushSettings,
  PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS,
  isProductInPricePushScope,
  resolvePushFloorForMarketplace,
} from '../src/utils/pricePushSettings.js';

describe('pricePushSettings', () => {
  it('parsePricePushSettings defaults both schemes enabled', () => {
    const s = parsePricePushSettings({});
    expect(s.pushFbs).toBe(true);
    expect(s.pushFbo).toBe(true);
  });

  it('resolvePushFloorForMarketplace uses FBS on Ozon when only FBS selected', () => {
    const row = { min_price: 1000, min_price_fbs: 1100, min_price_fbo: 1200 };
    expect(resolvePushFloorForMarketplace(row, 'ozon', { pushFbs: true, pushFbo: false })).toBe(1100);
  });

  it('resolvePushFloorForMarketplace uses max when both schemes selected', () => {
    const row = { min_price: 1000, min_price_fbs: 1100, min_price_fbo: 1200 };
    expect(resolvePushFloorForMarketplace(row, 'ozon', { pushFbs: true, pushFbo: true })).toBe(1200);
  });

  it('resolvePushFloorForMarketplace uses FBO on WB with legacy fallback', () => {
    const row = { min_price: 900, min_price_fbs: 800, min_price_fbo: null };
    expect(resolvePushFloorForMarketplace(row, 'wb', { pushFbs: false, pushFbo: true })).toBe(900);
    expect(resolvePushFloorForMarketplace(row, 'wb', { pushFbs: true, pushFbo: false })).toBe(800);
  });

  it('filtersFromPricePushSettings passes category and product ids together', () => {
    const filters = filtersFromPricePushSettings(
      {
        scope: PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS,
        categoryIds: ['12'],
        productIds: [1, 2],
      },
      6
    );
    expect(filters.profileId).toBe(6);
    expect(filters.categoryIds).toEqual(['12']);
    expect(filters.productIds).toEqual([1, 2]);
  });

  it('isProductInPricePushScope respects products list', () => {
    const settings = { scope: 'products', productIds: [294, 399] };
    expect(isProductInPricePushScope({ id: 294 }, settings)).toBe(true);
    expect(isProductInPricePushScope({ id: 100 }, settings)).toBe(false);
  });
});
