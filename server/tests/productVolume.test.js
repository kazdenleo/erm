import {
  enrichCalculatorVolumeFromProduct,
  resolveProductVolumeLiters,
} from '../src/utils/productVolume.js';

describe('resolveProductVolumeLiters', () => {
  test('uses explicit volume', () => {
    expect(resolveProductVolumeLiters({ volume: 15 })).toBe(15);
  });

  test('computes from mm dimensions', () => {
    expect(resolveProductVolumeLiters({ length: 400, width: 250, height: 150 })).toBe(15);
  });

  test('prefers explicit volume over dimensions', () => {
    expect(resolveProductVolumeLiters({ volume: 12, length: 400, width: 250, height: 150 })).toBe(12);
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
});
