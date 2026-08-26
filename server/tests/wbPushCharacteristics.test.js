import {
  applyErpBarcodesToWbCardSizes,
  buildWbCharacteristics,
} from '../src/utils/wbPushCharacteristics.js';

describe('WB push: ERP values must not be replaced by old card data', () => {
  test('shortened characteristic replaces the WB collection', () => {
    const chars = buildWbCharacteristics(
      { 111: '8K0129620' },
      [{ id: 111, value: ['8K0129620', '4G0129620', 'OLD'] }]
    );
    expect(chars).toEqual([{ id: 111, value: ['8K0129620'] }]);
  });

  test('empty ERP key does not keep the old WB value', () => {
    const chars = buildWbCharacteristics({ 111: '' }, [{ id: 111, value: ['OLD1', 'OLD2'] }]);
    expect(chars.find((c) => c.id === 111)).toBeUndefined();
  });

  test('characteristic absent in ERP is kept from WB', () => {
    const chars = buildWbCharacteristics({ 222: 'new' }, [{ id: 111, value: ['keep'] }]);
    expect(chars).toEqual(
      expect.arrayContaining([
        { id: 111, value: ['keep'] },
        { id: 222, value: ['new'] },
      ])
    );
  });

  test('single-size card sends remaining ERP barcodes instead of old WB SKUs', () => {
    const sizes = applyErpBarcodesToWbCardSizes(
      [{ chrtID: 1, techSize: '0', wbSize: '', skus: ['OLD1', 'OLD2', 'KEEP'] }],
      { barcodes: [{ barcode: 'KEEP', marketplaces: ['wb'] }] }
    );
    expect(sizes[0].skus).toEqual(['KEEP']);
    expect(sizes[0].chrtID).toBe(1);
  });

  test('multi-size card only drops SKUs that are no longer in ERP', () => {
    const sizes = applyErpBarcodesToWbCardSizes(
      [
        { chrtID: 1, techSize: 'S', wbSize: '', skus: ['S1'] },
        { chrtID: 2, techSize: 'M', wbSize: '', skus: ['M1'] },
      ],
      { barcodes: [{ barcode: 'S1', marketplaces: ['wb'] }] }
    );
    expect(sizes[0].skus).toEqual(['S1']);
    expect(sizes[1].skus).toEqual(['M1']);
  });
});
