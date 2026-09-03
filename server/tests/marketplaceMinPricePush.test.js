import {
  floorRub,
  normalizeMpOfferId,
  pricesRoughlyEqual,
  wbEffectivePrice,
  wbPriceToMeetFloor,
  resolveOzonPushTargetPrice,
  buildOzonPriceImportEntry,
  buildWbPriceUploadPayload,
  buildYmOfferPrice,
  needsOzonMinPricePush,
  needsWbFloorPush,
  needsYmFloorPush,
  isSyncSellingPriceToMinEnabled,
  pushForProduct,
  pushForAllProfiles,
  reconcileBelowFloor,
} from '../src/services/marketplaceMinPricePush.service.js';

describe('marketplaceMinPricePush helpers', () => {
  const prevSync = process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;

  afterEach(() => {
    if (prevSync === undefined) delete process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
    else process.env.MARKETPLACE_SYNC_PRICE_TO_MIN = prevSync;
  });

  test('floorRub rounds up to whole rubles', () => {
    expect(floorRub(100)).toBe(100);
    expect(floorRub(100.01)).toBe(101);
    expect(floorRub(0)).toBe(1);
    expect(floorRub(-5)).toBeNull();
    expect(floorRub(null)).toBeNull();
  });

  test('normalizeMpOfferId strips trailing semicolons', () => {
    expect(normalizeMpOfferId('AN1048;')).toBe('AN1048');
    expect(normalizeMpOfferId(' AN1003;; ')).toBe('AN1003');
    expect(normalizeMpOfferId('')).toBeNull();
  });

  test('pricesRoughlyEqual within ±1 ₽', () => {
    expect(pricesRoughlyEqual(100, 100.5)).toBe(true);
    expect(pricesRoughlyEqual(100, 102)).toBe(false);
  });

  test('wbEffectivePrice and wbPriceToMeetFloor', () => {
    expect(wbEffectivePrice(1000, 10)).toBe(900);
    expect(wbEffectivePrice(1000, 0)).toBe(1000);
    expect(wbPriceToMeetFloor(900, 10)).toBe(1000);
    expect(wbPriceToMeetFloor(901, 10)).toBe(1002);
  });

  test('sync-to-min (default): Ozon needs push when price != floor', () => {
    delete process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
    expect(isSyncSellingPriceToMinEnabled()).toBe(true);
    expect(needsOzonMinPricePush({ erpFloor: 100, mpMinPrice: 100, mpPrice: 150 })).toBe(true);
    expect(needsOzonMinPricePush({ erpFloor: 100, mpMinPrice: 100, mpPrice: 100 })).toBe(false);
    expect(needsOzonMinPricePush({ erpFloor: 100, mpMinPrice: 90, mpPrice: 100 })).toBe(true);
  });

  test('floor-only mode: Ozon allows price above floor', () => {
    process.env.MARKETPLACE_SYNC_PRICE_TO_MIN = '0';
    expect(needsOzonMinPricePush({ erpFloor: 100, mpMinPrice: 100, mpPrice: 150 })).toBe(false);
    expect(needsOzonMinPricePush({ erpFloor: 100, mpMinPrice: 90, mpPrice: 150 })).toBe(true);
    expect(needsOzonMinPricePush({ erpFloor: 100, mpMinPrice: 100, mpPrice: 80 })).toBe(true);
  });

  test('sync-to-min: WB when effective != floor', () => {
    delete process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
    expect(needsWbFloorPush({ erpFloor: 900, price: 1000, discount: 10 })).toBe(false);
    expect(needsWbFloorPush({ erpFloor: 800, price: 1000, discount: 10 })).toBe(true);
    expect(needsWbFloorPush({ erpFloor: 950, price: 1000, discount: 10 })).toBe(true);
    expect(needsWbFloorPush({ erpFloor: 900, price: null, discount: 10 })).toBe(false);
  });

  test('floor-only: WB only when effective < floor', () => {
    process.env.MARKETPLACE_SYNC_PRICE_TO_MIN = 'false';
    expect(needsWbFloorPush({ erpFloor: 900, price: 1000, discount: 10 })).toBe(false);
    expect(needsWbFloorPush({ erpFloor: 800, price: 1000, discount: 10 })).toBe(false);
    expect(needsWbFloorPush({ erpFloor: 901, price: 1000, discount: 10 })).toBe(true);
  });

  test('sync-to-min: YM when price != floor', () => {
    delete process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
    expect(needsYmFloorPush({ erpFloor: 500, currentPrice: 600 })).toBe(true);
    expect(needsYmFloorPush({ erpFloor: 500, currentPrice: 500 })).toBe(false);
    expect(needsYmFloorPush({ erpFloor: 500, currentPrice: 400 })).toBe(true);
    expect(needsYmFloorPush({ erpFloor: 500, currentPrice: null })).toBe(false);
  });

  test('floor-only: YM only when price < floor', () => {
    process.env.MARKETPLACE_SYNC_PRICE_TO_MIN = 'off';
    expect(needsYmFloorPush({ erpFloor: 500, currentPrice: 600 })).toBe(false);
    expect(needsYmFloorPush({ erpFloor: 500, currentPrice: 400 })).toBe(true);
  });

  test('resolveOzonPushTargetPrice sync mode uses floor', () => {
    delete process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
    expect(resolveOzonPushTargetPrice(3071, 2946)).toBe(3071);
  });

  test('resolveOzonPushTargetPrice floor-only uses max(selling, floor)', () => {
    process.env.MARKETPLACE_SYNC_PRICE_TO_MIN = '0';
    expect(resolveOzonPushTargetPrice(3071, 2946)).toBe(3071);
    expect(resolveOzonPushTargetPrice(3071, 3200)).toBe(3200);
  });

  test('buildOzonPriceImportEntry keeps price >= min_price', () => {
    delete process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
    const entry = buildOzonPriceImportEntry({
      floor: 3071,
      sellingTarget: 2946,
      ozonProductId: 1063548244,
    });
    expect(entry.price).toBe('3071');
    expect(entry.min_price).toBe('3071');
  });

  test('buildWbPriceUploadPayload sync mode uses exact price without stale WB discount', () => {
    delete process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
    const pack = buildWbPriceUploadPayload({
      floor: 2569,
      sellingTarget: 2028,
      currentWbDiscount: 10,
    });
    expect(pack.price).toBe(2569);
    expect(pack.discount).toBe(0);
    expect(pack.targetEff).toBe(2569);
  });

  test('buildWbPriceUploadPayload uses ERP before and discount when not sync-to-min', () => {
    process.env.MARKETPLACE_SYNC_PRICE_TO_MIN = '0';
    const pack = buildWbPriceUploadPayload({
      floor: 2569,
      sellingTarget: 2569,
      priceBeforeDiscount: 3200,
      discountPercent: 20,
    });
    expect(pack.price).toBe(3200);
    expect(pack.discount).toBe(20);
  });

  test('buildWbPriceUploadPayload sync+before tweaks list price so after ≈ floor', () => {
    delete process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
    const pack = buildWbPriceUploadPayload({
      floor: 2393,
      sellingTarget: 4105,
      priceBeforeDiscount: 5132,
    });
    expect(pack.targetEff).toBe(2393);
    expect(pack.discount).toBe(53);
    expect(pack.price).toBe(wbPriceToMeetFloor(2393, 53));
    const eff = wbEffectivePrice(pack.price, pack.discount);
    expect(eff).toBeGreaterThanOrEqual(2393 - 0.01);
    expect(Math.abs(eff - 2393)).toBeLessThan(1);
  });

  test('buildYmOfferPrice sets discountBase when discount 5–99%', () => {
    const price = buildYmOfferPrice({ value: 2500, priceBeforeDiscount: 3000 });
    expect(price.value).toBe(2500);
    expect(price.discountBase).toBe(3000);
    expect(price.currencyId).toBe('RUR');
  });

  test('buildYmOfferPrice omits discountBase when discount below 5%', () => {
    const price = buildYmOfferPrice({ value: 2900, priceBeforeDiscount: 3000 });
    expect(price.value).toBe(2900);
    expect(price.discountBase).toBeUndefined();
  });
});

describe('marketplaceMinPricePush exports', () => {
  test('exports pushForProduct, pushForAllProfiles, reconcileBelowFloor', () => {
    expect(typeof pushForProduct).toBe('function');
    expect(typeof pushForAllProfiles).toBe('function');
    expect(typeof reconcileBelowFloor).toBe('function');
  });
});
