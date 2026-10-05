import {
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
  test('prefers lower_barcode', () => {
    expect(
      ozonStickerNumberFromPosting({
        barcodes: { lower_barcode: '201026795970000', upper_barcode: 'UP-1' },
      })
    ).toBe('201026795970000');
  });

  test('falls back to upper_barcode', () => {
    expect(
      ozonStickerNumberFromPosting({
        barcodes: { upper_barcode: 'UP-1' },
      })
    ).toBe('UP-1');
  });

  test('returns null without barcodes', () => {
    expect(ozonStickerNumberFromPosting({ posting_number: '1-1' })).toBeNull();
    expect(ozonStickerNumberFromPosting(null)).toBeNull();
  });
});

describe('ozonAssemblyStickerFromPosting', () => {
  test('returns barcode only', () => {
    expect(
      ozonAssemblyStickerFromPosting({
        order_number: '74369038-0308',
        posting_number: '74369038-0308-1',
        barcodes: { lower_barcode: '201026795970000' },
      })
    ).toBe('201026795970000');
  });

  test('does not fall back to order_number or posting', () => {
    expect(
      ozonAssemblyStickerFromPosting({
        order_number: '74369038-0308',
        posting_number: '74369038-0308-1',
      })
    ).toBeNull();
  });
});
