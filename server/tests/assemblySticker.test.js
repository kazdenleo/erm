import { orderHasAssemblySticker } from '../src/utils/assemblySticker.js';

describe('orderHasAssemblySticker', () => {
  test('WB: нужен непустой номер стикера', () => {
    expect(orderHasAssemblySticker({ marketplace: 'wildberries', assemblyStickerNumber: '' })).toBe(false);
    expect(orderHasAssemblySticker({ marketplace: 'wb', assembly_sticker_number: '123' })).toBe(true);
  });

  test('Ozon: числовой lower_barcode не считается стикером', () => {
    expect(orderHasAssemblySticker({ marketplace: 'ozon', assemblyStickerNumber: '302085861110000' })).toBe(false);
    expect(orderHasAssemblySticker({ marketplace: 'ozon', assemblyStickerNumber: 'ii50048401925' })).toBe(true);
  });

  test('Яндекс и ручные заказы стикер не требуют', () => {
    expect(orderHasAssemblySticker({ marketplace: 'yandex' })).toBe(true);
    expect(orderHasAssemblySticker({ marketplace: 'manual' })).toBe(true);
    expect(orderHasAssemblySticker(null)).toBe(false);
  });
});
