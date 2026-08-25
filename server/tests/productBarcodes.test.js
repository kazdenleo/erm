import {
  buildEan13,
  ean13CheckDigit,
  mergeBarcodesFromMarketplace,
  needsGeneratedBarcodeForPush,
  pickBarcodeForMarketplace,
} from '../src/utils/productBarcodes.js';

describe('productBarcodes EAN and MP tags', () => {
  test('builds valid EAN-13 check digit', () => {
    expect(ean13CheckDigit('400638133393')).toBe('1');
    expect(buildEan13('400638133393')).toBe('4006381333931');
  });

  test('needs generated barcode when empty or without MP icons', () => {
    expect(needsGeneratedBarcodeForPush([])).toBe(true);
    expect(needsGeneratedBarcodeForPush([{ barcode: '4601234567890', marketplaces: [] }])).toBe(true);
    expect(needsGeneratedBarcodeForPush([{ barcode: '4601234567890', marketplaces: ['ozon'] }])).toBe(
      false
    );
  });

  test('tags generated barcode with marketplaces it was sent to', () => {
    const rows = [{ barcode: '2000001230008', marketplaces: [] }];
    const afterOzon = mergeBarcodesFromMarketplace(rows, ['2000001230008'], 'ozon');
    expect(afterOzon[0].marketplaces).toEqual(['ozon']);
    const afterWb = mergeBarcodesFromMarketplace(afterOzon, ['2000001230008'], 'wb');
    expect(afterWb[0].marketplaces).toEqual(['ozon', 'wb']);
    expect(pickBarcodeForMarketplace(afterWb, 'wb')).toBe('2000001230008');
  });
});
