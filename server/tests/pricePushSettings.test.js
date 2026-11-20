import {
  filtersFromPricePushSettings,
  mergePricePushSettings,
  parsePricePushSettings,
  PRICE_PUSH_SCOPE_CATEGORIES_AND_PRODUCTS,
  hasPricePushSchemeEnabled,
  hasPricePushMarketplaceEnabled,
  enabledPushMarketplaces,
  resolvePushMarketplacesAllowList,
  isProductInPricePushScope,
  resolvePushFloorForMarketplace,
} from '../src/utils/pricePushSettings.js';

describe('pricePushSettings', () => {
  it('parsePricePushSettings defaults both schemes and Ozon min-only', () => {
    const s = parsePricePushSettings({});
    expect(s.pushFbs).toBe(true);
    expect(s.pushFbo).toBe(true);
    // Default legacy: all MP on + min only → Ozon min; WB/YM without selling stay off for content
    expect(s.marketplacePush.ozon).toEqual({ pushMinPrice: true, pushSellingPrice: false });
    expect(s.marketplacePush.wb.pushMinPrice).toBe(false);
    expect(s.marketplacePush.ym.pushMinPrice).toBe(false);
    expect(s.pushOzon).toBe(true);
    expect(s.pushMinPrice).toBe(true);
    expect(s.pushSellingPrice).toBe(false);
  });

  it('parses per-marketplace matrix', () => {
    const s = parsePricePushSettings({
      marketplacePush: {
        ozon: { pushMinPrice: true, pushSellingPrice: false },
        wb: { pushSellingPrice: true },
        ym: { pushMinPrice: true, pushSellingPrice: true },
      },
    });
    expect(s.marketplacePush.ozon).toEqual({ pushMinPrice: true, pushSellingPrice: false });
    expect(s.marketplacePush.wb).toEqual({ pushMinPrice: false, pushSellingPrice: true });
    // YM min forced off (no API field)
    expect(s.marketplacePush.ym).toEqual({ pushMinPrice: false, pushSellingPrice: true });
    expect(s.pushOzon).toBe(true);
    expect(s.pushWb).toBe(true);
    expect(s.pushYm).toBe(true);
    expect(s.pushMinPrice).toBe(true);
    expect(s.pushSellingPrice).toBe(true);
  });

  it('merges marketplacePush independently', () => {
    const merged = mergePricePushSettings(
      {
        marketplacePush: {
          ozon: { pushMinPrice: true, pushSellingPrice: false },
          wb: { pushSellingPrice: false },
          ym: { pushSellingPrice: false },
        },
      },
      {
        marketplacePush: {
          wb: { pushSellingPrice: true },
        },
      }
    );
    expect(merged.marketplacePush.ozon.pushMinPrice).toBe(true);
    expect(merged.marketplacePush.wb.pushSellingPrice).toBe(true);
    expect(merged.pushWb).toBe(true);
  });

  it('migrates legacy syncSellingPriceToMin to marketplace matrix', () => {
    expect(parsePricePushSettings({ syncSellingPriceToMin: true })).toMatchObject({
      pushMinPrice: true,
      pushSellingPrice: true,
      pushOzon: true,
    });
    expect(parsePricePushSettings({ syncSellingPriceToMin: false }).marketplacePush.ozon).toEqual({
      pushMinPrice: true,
      pushSellingPrice: false,
    });
  });

  it('parses marketplace flags and marketplaces array', () => {
    expect(
      enabledPushMarketplaces({
        pushOzon: true,
        pushWb: false,
        pushYm: true,
        pushSellingPrice: true,
      })
    ).toEqual(['ozon', 'ym']);
    expect(
      parsePricePushSettings({ marketplaces: ['wb', 'wildberries'], pushSellingPrice: true })
    ).toMatchObject({
      pushOzon: false,
      pushWb: true,
      pushYm: false,
    });
    expect(
      hasPricePushMarketplaceEnabled({
        marketplacePush: {
          ozon: { pushMinPrice: false, pushSellingPrice: false },
          wb: { pushSellingPrice: false },
          ym: { pushSellingPrice: false },
        },
      })
    ).toBe(false);
  });

  it('resolvePushMarketplacesAllowList intersects request with settings', () => {
    const settings = {
      marketplacePush: {
        ozon: { pushMinPrice: true, pushSellingPrice: false },
        wb: { pushSellingPrice: false },
        ym: { pushSellingPrice: true },
      },
    };
    expect(resolvePushMarketplacesAllowList(settings, null)).toEqual(['ozon', 'ym']);
    expect(resolvePushMarketplacesAllowList(settings, ['wb', 'ozon'])).toEqual(['ozon']);
    expect(resolvePushMarketplacesAllowList(settings, ['wb'])).toEqual([]);
    expect(
      resolvePushMarketplacesAllowList(
        {
          marketplacePush: {
            ozon: { pushMinPrice: false, pushSellingPrice: false },
            wb: { pushSellingPrice: false },
            ym: { pushSellingPrice: false },
          },
        },
        ['ozon']
      )
    ).toEqual([]);
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
