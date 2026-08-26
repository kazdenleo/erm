import {
  buildEan13,
  ean13CheckDigit,
  mergeBarcodesFromMarketplace,
  needsGeneratedBarcodeForPush,
  pickBarcodeForMarketplace,
  barcodeToSendToMarketplace,
  barcodesToSendToMarketplace,
  coerceBarcodeString,
  isCorruptBarcodeString,
  barcodesFromWbGeneratePayload,
  omitEmptyBarcodesFromProductPatch,
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

  test('sends existing barcode to MP that has no badge yet', () => {
    const rows = [{ barcode: '2055267952997', marketplaces: ['ym'] }];
    expect(barcodeToSendToMarketplace(rows, 'ozon')).toBe('2055267952997');
    expect(barcodeToSendToMarketplace(rows, 'wb')).toBe('2055267952997');
    expect(barcodeToSendToMarketplace(rows, 'ym')).toBe('2055267952997');
  });

  test('prefers barcode already tagged for the target MP', () => {
    const rows = [
      { barcode: '111', marketplaces: ['ym'] },
      { barcode: '222', marketplaces: ['ozon'] },
    ];
    expect(barcodeToSendToMarketplace(rows, 'ozon')).toBe('222');
  });

  test('prefers untagged barcode over other-MP tags', () => {
    const rows = [
      { barcode: '111', marketplaces: ['ym'] },
      { barcode: '222', marketplaces: [] },
    ];
    expect(barcodeToSendToMarketplace(rows, 'ozon')).toBe('222');
  });

  test('omits empty barcodes from push patch so save-and-send does not wipe ШК', () => {
    expect(omitEmptyBarcodesFromProductPatch({ name: 'A', barcodes: [] })).toEqual({ name: 'A' });
    expect(omitEmptyBarcodesFromProductPatch({ barcodes: [{ barcode: '', marketplaces: [] }] })).toEqual({});
    expect(omitEmptyBarcodesFromProductPatch({ barcodes: null })).toEqual({});
    expect(omitEmptyBarcodesFromProductPatch({ barcodes: '' })).toEqual({});
    expect(
      omitEmptyBarcodesFromProductPatch({ barcodes: [{ barcode: '4601234567890', marketplaces: [] }] })
    ).toEqual({ barcodes: [{ barcode: '4601234567890', marketplaces: [] }] });
  });

  test('sends remaining ERP barcodes for a marketplace, not extras already deleted', () => {
    const rows = [
      { barcode: 'AAA', marketplaces: ['ozon'] },
      { barcode: 'BBB', marketplaces: ['wb'] },
    ];
    expect(barcodesToSendToMarketplace(rows, 'ozon')).toEqual(['AAA']);
    expect(barcodesToSendToMarketplace(rows, 'wb')).toEqual(['BBB']);
  });
});

describe('WB generate payload and corrupt barcodes', () => {
  test('extracts barcode from WB object instead of String(object)', () => {
    expect(coerceBarcodeString({ barcode: '2037000000001' })).toBe('2037000000001');
    expect(coerceBarcodeString({ skus: ['2037000000002'] })).toBe('2037000000002');
    expect(String({ barcode: '2037000000001' })).toBe('[object Object]');
    expect(coerceBarcodeString('[object Object]')).toBe('');
    expect(isCorruptBarcodeString('[object Object]')).toBe(true);
  });

  test('parses WB /content/v2/barcodes shapes', () => {
    expect(barcodesFromWbGeneratePayload({ data: ['2037000000003'] })).toEqual(['2037000000003']);
    expect(barcodesFromWbGeneratePayload({ data: [{ barcode: '2037000000004' }] })).toEqual([
      '2037000000004',
    ]);
    expect(barcodesFromWbGeneratePayload({ data: [{ foo: 1 }] })).toEqual([]);
    expect(barcodesFromWbGeneratePayload({ data: { barcodes: ['2037000000005'] } })).toEqual([
      '2037000000005',
    ]);
  });
});
