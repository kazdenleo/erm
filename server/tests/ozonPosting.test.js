import {
  isOzonLabelStickerNumber,
  ozonAssemblyStickerFromPosting,
  ozonOrderNumberFromPostingNumber,
  ozonPostingNumberFromOrderId,
  ozonStickerNumberFromPosting,
} from '../src/utils/ozonPosting.js';

describe('ozonPostingNumberFromOrderId', () => {
  test('strips multi-line suffix', () => {
    expect(ozonPostingNumberFromOrderId('12345-0001-1~2')).toBe('12345-0001-1');
  });

  test('keeps plain posting number', () => {
    expect(ozonPostingNumberFromOrderId('12345-0001-1')).toBe('12345-0001-1');
  });
});

describe('ozonOrderNumberFromPostingNumber', () => {
  test('strips posting index', () => {
    expect(ozonOrderNumberFromPostingNumber('74369038-0308-1')).toBe('74369038-0308');
    expect(ozonOrderNumberFromPostingNumber('71110719-0219-1')).toBe('71110719-0219');
  });
});

describe('ozonStickerNumberFromPosting', () => {
  test('takes scanit from label', () => {
    expect(
      ozonStickerNumberFromPosting({
        scanit: 'ii50048401925',
        barcodes: { lower_barcode: '302085861110000', upper_barcode: '302085861110000' },
      })
    ).toBe('ii50048401925');
  });

  test('ignores barcodes without scanit', () => {
    expect(
      ozonStickerNumberFromPosting({
        barcodes: { lower_barcode: '302085861110000', upper_barcode: '302085861110000' },
      })
    ).toBeNull();
  });

  test('returns null without data', () => {
    expect(ozonStickerNumberFromPosting({ posting_number: '1-1' })).toBeNull();
    expect(ozonStickerNumberFromPosting(null)).toBeNull();
  });
});

describe('isOzonLabelStickerNumber', () => {
  test('numeric legacy barcode is not a label sticker', () => {
    expect(isOzonLabelStickerNumber('302085861110000')).toBe(false);
    expect(isOzonLabelStickerNumber('')).toBe(false);
    expect(isOzonLabelStickerNumber('ii50048401925')).toBe(true);
  });
});

describe('ozonAssemblyStickerFromPosting', () => {
  test('does not fall back to order_number or posting', () => {
    expect(
      ozonAssemblyStickerFromPosting({
        order_number: '74369038-0308',
        posting_number: '74369038-0308-1',
      })
    ).toBeNull();
  });
});
