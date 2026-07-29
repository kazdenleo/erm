import {
  enrichCalculatorVolumeFromProduct,
  resolveProductVolumeLiters,
  resolveMarketplaceVolumeLiters,
} from '../src/utils/productVolume.js';

describe('resolveProductVolumeLiters', () => {
  test('uses explicit volume when no dimensions', () => {
    expect(resolveProductVolumeLiters({ volume: 15 })).toBe(15);
  });

  test('computes from mm dimensions', () => {
    expect(resolveProductVolumeLiters({ length: 400, width: 250, height: 150 })).toBe(15);
  });

  test('prefers dimensions over explicit volume', () => {
    expect(resolveProductVolumeLiters({ volume: 12, length: 400, width: 250, height: 150 })).toBe(15);
  });

  test('returns null when no data', () => {
    expect(resolveProductVolumeLiters({})).toBeNull();
  });
});

describe('enrichCalculatorVolumeFromProduct', () => {
  test('replaces Ozon volumetric kg mistaken as liters', () => {
    const out = enrichCalculatorVolumeFromProduct(
      { volume_weight: 3, commissions: { FBS: { percent: 44 } } },
      { length: 400, width: 250, height: 150 }
    );
    expect(out.volume_weight).toBe(15);
  });

  test('uses WB attrs when marketplace=wb', () => {
    const out = enrichCalculatorVolumeFromProduct(
      { volume_weight: 3 },
      {
        length: 400,
        width: 250,
        height: 150,
        wb_attributes: { 12153433: 200, 7594048: 214, 7594043: 35 },
      },
      'wb'
    );
    expect(out.volume_weight).toBe(resolveMarketplaceVolumeLiters({
      wb_attributes: { 12153433: 200, 7594048: 214, 7594043: 35 },
    }, 'wb'));
    expect(out.marketplace).toBe('wb');
  });
});
