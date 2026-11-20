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
  resolvePushPriceModes,
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

  test('resolvePushPriceModes defaults to min-only', () => {
    delete process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
    expect(resolvePushPriceModes()).toEqual({ pushMinPrice: true, pushSellingPrice: false });
    expect(resolvePushPriceModes({ pushMinPrice: true, pushSellingPrice: true })).toEqual({
      pushMinPrice: true,
      pushSellingPrice: true,
    });
    expect(resolvePushPriceModes({ syncSellingPriceToMin: true })).toEqual({
      pushMinPrice: true,
      pushSellingPrice: true,
    });
    expect(isSyncSellingPriceToMinEnabled({ pushMinPrice: true, pushSellingPrice: true })).toBe(
      true
    );
  });

  test('both modes: Ozon needs push when price or min differ', () => {
    expect(
      needsOzonMinPricePush({
        erpFloor: 100,
        mpMinPrice: 100,
        mpPrice: 150,
        sellingTarget: 100,
        pushMinPrice: true,
        pushSellingPrice: true,
      })
    ).toBe(true);
    expect(
      needsOzonMinPricePush({
        erpFloor: 100,
        mpMinPrice: 100,
        mpPrice: 100,
        sellingTarget: 100,
        pushMinPrice: true,
        pushSellingPrice: true,
      })
    ).toBe(false);
  });

  test('min-only: Ozon pushes min_price when selling stays above floor', () => {
    expect(
      needsOzonMinPricePush({
        erpFloor: 100,
        mpMinPrice: 100,
        mpPrice: 150,
        pushMinPrice: true,
        pushSellingPrice: false,
      })
    ).toBe(false);
    expect(
      needsOzonMinPricePush({
        erpFloor: 100,
        mpMinPrice: 90,
        mpPrice: 150,
        pushMinPrice: true,
        pushSellingPrice: false,
      })
    ).toBe(true);
    expect(
      needsOzonMinPricePush({
        erpFloor: 100,
        mpMinPrice: 90,
        mpPrice: 80,
        pushMinPrice: true,
        pushSellingPrice: false,
      })
    ).toBe(false);
  });

  test('selling-only: WB when effective != selling target', () => {
    expect(
      needsWbFloorPush({
        erpFloor: 900,
        price: 1000,
        discount: 10,
        sellingTarget: 900,
        pushMinPrice: false,
        pushSellingPrice: true,
      })
    ).toBe(false);
    expect(
      needsWbFloorPush({
        erpFloor: 800,
        price: 1000,
        discount: 10,
        sellingTarget: 800,
        pushMinPrice: false,
        pushSellingPrice: true,
      })
    ).toBe(true);
  });

  test('min-only: WB never pushes', () => {
    expect(
      needsWbFloorPush({
        erpFloor: 901,
        price: 1000,
        discount: 10,
        pushMinPrice: true,
        pushSellingPrice: false,
      })
    ).toBe(false);
  });

  test('selling-only: YM when price != target', () => {
    expect(
      needsYmFloorPush({
        erpFloor: 500,
        currentPrice: 600,
        sellingTarget: 500,
        pushMinPrice: false,
        pushSellingPrice: true,
      })
    ).toBe(true);
    expect(
      needsYmFloorPush({
        erpFloor: 500,
        currentPrice: 500,
        sellingTarget: 500,
        pushMinPrice: false,
        pushSellingPrice: true,
      })
    ).toBe(false);
  });

  test('min-only: YM never pushes', () => {
    expect(
      needsYmFloorPush({
        erpFloor: 500,
        currentPrice: 400,
        pushMinPrice: true,
        pushSellingPrice: false,
      })
    ).toBe(false);
  });

  test('resolveOzonPushTargetPrice selling mode uses selling (not below floor if min on)', () => {
    expect(
      resolveOzonPushTargetPrice(3071, 2946, { pushMinPrice: true, pushSellingPrice: true })
    ).toBe(3071);
    expect(
      resolveOzonPushTargetPrice(3071, 3200, { pushMinPrice: true, pushSellingPrice: true })
    ).toBe(3200);
    expect(
      resolveOzonPushTargetPrice(3071, 3200, { pushMinPrice: false, pushSellingPrice: true })
    ).toBe(3200);
  });

  test('resolveOzonPushTargetPrice min-only uses current MP price', () => {
    expect(
      resolveOzonPushTargetPrice(2000, 1500, { pushMinPrice: true, pushSellingPrice: false }, 2800)
    ).toBe(2800);
  });

  test('buildOzonPriceImportEntry both modes sets selling and min', () => {
    const entry = buildOzonPriceImportEntry({
      floor: 2000,
      sellingTarget: 2800,
      ozonProductId: 1,
      pushMinPrice: true,
      pushSellingPrice: true,
    });
    expect(entry.price).toBe('2800');
    expect(entry.min_price).toBe('2000');
  });

  test('buildOzonPriceImportEntry min-only preserves MP selling', () => {
    const entry = buildOzonPriceImportEntry({
      floor: 2000,
      sellingTarget: 1500,
      ozonProductId: 1,
      currentMpPrice: 2800,
      pushMinPrice: true,
      pushSellingPrice: false,
    });
    expect(entry.price).toBe('2800');
    expect(entry.min_price).toBe('2000');
    expect(entry.old_price).toBeUndefined();
  });

  test('buildOzonPriceImportEntry selling-only omits min_price', () => {
    const entry = buildOzonPriceImportEntry({
      floor: 2000,
      sellingTarget: 2800,
      ozonProductId: 1,
      pushMinPrice: false,
      pushSellingPrice: true,
    });
    expect(entry.price).toBe('2800');
    expect(entry.min_price).toBeUndefined();
  });

  test('buildOzonPriceImportEntry min-only skips when selling <= floor', () => {
    expect(
      buildOzonPriceImportEntry({
        floor: 2000,
        sellingTarget: 2000,
        ozonProductId: 1,
        currentMpPrice: 2000,
        pushMinPrice: true,
        pushSellingPrice: false,
      })
    ).toBeNull();
  });

  test('buildOzonPriceImportEntry omits deprecated auto_action_enabled', () => {
    const entry = buildOzonPriceImportEntry({
      floor: 2000,
      sellingTarget: 2000,
      ozonProductId: 1,
      pushMinPrice: true,
      pushSellingPrice: true,
    });
    expect(entry.auto_action_enabled).toBeUndefined();
    expect(entry.manage_elastic_boosting_through_price).toBeUndefined();
    expect(entry.auto_add_to_ozon_actions_list_enabled).toBe('DISABLED');
  });

  test('buildOzonPriceImportEntry sends net_price from ERP cost', () => {
    const entry = buildOzonPriceImportEntry({
      floor: 2000,
      sellingTarget: 2000,
      ozonProductId: 1,
      netPrice: 850.4,
      pushMinPrice: true,
      pushSellingPrice: true,
    });
    expect(entry.net_price).toBe('850');
  });

  test('buildWbPriceUploadPayload selling mode uses selling target', () => {
    const pack = buildWbPriceUploadPayload({
      floor: 2569,
      sellingTarget: 2028,
      currentWbDiscount: 10,
      pushMinPrice: false,
      pushSellingPrice: true,
    });
    expect(pack.price).toBe(2028);
    expect(pack.discount).toBe(0);
    expect(pack.targetEff).toBe(2028);
  });

  test('buildWbPriceUploadPayload min-only returns null', () => {
    expect(
      buildWbPriceUploadPayload({
        floor: 2569,
        sellingTarget: 2569,
        pushMinPrice: true,
        pushSellingPrice: false,
      })
    ).toBeNull();
  });

  test('buildWbPriceUploadPayload with before tweaks list price', () => {
    const pack = buildWbPriceUploadPayload({
      floor: 2393,
      sellingTarget: 2393,
      priceBeforeDiscount: 5132,
      pushMinPrice: false,
      pushSellingPrice: true,
    });
    expect(pack.targetEff).toBe(2393);
    expect(pack.discount).toBe(53);
    expect(pack.price).toBe(wbPriceToMeetFloor(2393, 53));
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
