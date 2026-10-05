import { ozonPostingNumberFromOrderId, ozonStickerNumberFromPosting } from '../src/utils/ozonPosting.js';

describe('ozonPostingNumberFromOrderId', () => {
  test('strips multi-line suffix', () => {
    expect(ozonPostingNumberFromOrderId('12345-0001-1~2')).toBe('12345-0001-1');
  });

  test('keeps plain posting number', () => {
    expect(ozonPostingNumberFromOrderId('12345-0001-1')).toBe('12345-0001-1');
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
