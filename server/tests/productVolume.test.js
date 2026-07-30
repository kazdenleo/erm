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
  test('without marketplace keeps ERP dims', () => {
    const out = enrichCalculatorVolumeFromProduct(
      { volume_weight: 3, commissions: { FBS: { percent: 44 } } },
      { length: 400, width: 250, height: 150 }
    );
    expect(out.volume_weight).toBe(15);
  });

  test('uses WB pack attrs when marketplace=wb', () => {
    const product = {
      length: 400,
      width: 250,
      height: 150,
      wb_attributes: { 90849: 26, 90745: 10, 90846: 10 },
    };
    const out = enrichCalculatorVolumeFromProduct({ volume_weight: 3 }, product, 'wb');
    expect(out.volume_weight).toBe(resolveMarketplaceVolumeLiters(product, 'wb'));
    expect(out.volume_weight).toBe(2.6);
    expect(out.marketplace).toBe('wb');
  });

  test('WB without pack dims — null (no ERP)', () => {
    const out = enrichCalculatorVolumeFromProduct(
      { volume_weight: 3 },
      { length: 400, width: 250, height: 150, volume: 15 },
      'wb'
    );
    expect(out.volume_weight).toBeNull();
    expect(out.volume_source).toBe('wb:missing_packaging');
  });

  test('Ozon without attrs — null (no ERP)', () => {
    const out = enrichCalculatorVolumeFromProduct(
      { volume_weight: 3 },
      { length: 400, width: 250, height: 150 },
      'ozon'
    );
    expect(out.volume_weight).toBeNull();
    expect(out.volume_source).toBe('ozon:missing_packaging');
  });
});
