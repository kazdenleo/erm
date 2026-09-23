import {
  filtersFromPricePushSettings,
  mergePricePushSettings,
  parsePricePushSettings,
  PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS,
  hasPricePushSchemeEnabled,
  isProductInPricePushScope,
  resolvePushFloorForMarketplace,
} from '../src/utils/pricePushSettings.js';

describe('pricePushSettings', () => {
  it('parsePricePushSettings defaults both schemes enabled', () => {
    const s = parsePricePushSettings({});
    expect(s.pushFbs).toBe(true);
    expect(s.pushFbo).toBe(true);
  });

  it('allows both FBS and FBO schemes disabled (do not push prices)', () => {
    const s = parsePricePushSettings({ pushFbs: false, pushFbo: false });
    expect(s.pushFbs).toBe(false);
    expect(s.pushFbo).toBe(false);
    expect(hasPricePushSchemeEnabled(s)).toBe(false);
    const merged = mergePricePushSettings({ pushFbs: true, pushFbo: true }, {
      pushFbs: false,
      pushFbo: false,
    });
    expect(merged.pushFbs).toBe(false);
    expect(merged.pushFbo).toBe(false);
  });

  it('resolvePushFloorForMarketplace returns null when both schemes off', () => {
    const row = { min_price: 1000, min_price_fbs: 1100, min_price_fbo: 1200 };
    expect(resolvePushFloorForMarketplace(row, 'ozon', { pushFbs: false, pushFbo: false })).toBe(null);
    expect(resolvePushFloorForMarketplace(row, 'wb', { pushFbs: false, pushFbo: false })).toBe(null);
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
