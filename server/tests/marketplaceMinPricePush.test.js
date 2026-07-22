import {
  floorRub,
  normalizeMpOfferId,
  pricesRoughlyEqual,
  wbEffectivePrice,
  wbPriceToMeetFloor,
  needsOzonMinPricePush,
  needsWbFloorPush,
  needsYmFloorPush,
  pushForProduct,
  pushForAllProfiles,
  reconcileBelowFloor,
} from '../src/services/marketplaceMinPricePush.service.js';

describe('marketplaceMinPricePush helpers', () => {
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

  test('needsOzonMinPricePush', () => {
    expect(needsOzonMinPricePush({ erpFloor: 100, mpMinPrice: 100, mpPrice: 150 })).toBe(false);
    expect(needsOzonMinPricePush({ erpFloor: 100, mpMinPrice: 90, mpPrice: 150 })).toBe(true);
    expect(needsOzonMinPricePush({ erpFloor: 100, mpMinPrice: 100, mpPrice: 80 })).toBe(true);
  });

  test('needsWbFloorPush skips unknown current', () => {
    expect(needsWbFloorPush({ erpFloor: 900, price: 1000, discount: 10 })).toBe(false);
    expect(needsWbFloorPush({ erpFloor: 901, price: 1000, discount: 10 })).toBe(true);
    expect(needsWbFloorPush({ erpFloor: 900, price: null, discount: 10 })).toBe(false);
  });

  test('needsYmFloorPush skips unknown current', () => {
    expect(needsYmFloorPush({ erpFloor: 500, currentPrice: 600 })).toBe(false);
    expect(needsYmFloorPush({ erpFloor: 500, currentPrice: 400 })).toBe(true);
    expect(needsYmFloorPush({ erpFloor: 500, currentPrice: null })).toBe(false);
  });
});

describe('marketplaceMinPricePush exports', () => {
  test('exports pushForProduct, pushForAllProfiles, reconcileBelowFloor', () => {
    expect(typeof pushForProduct).toBe('function');
    expect(typeof pushForAllProfiles).toBe('function');
    expect(typeof reconcileBelowFloor).toBe('function');
  });
});
