import {
  orderHasAssemblySticker,
  orderStickerCellValue,
  ozonOrderNumberFromPostingNumber,
  ozonStickerMissing,
} from './orderStickerDisplay.js';

describe('ozonOrderNumberFromPostingNumber', () => {
  test('strips posting index', () => {
    expect(ozonOrderNumberFromPostingNumber('74369038-0308-1')).toBe('74369038-0308');
  });
});

describe('orderStickerCellValue', () => {
  test('Ozon: номер с этикетки, без posting и order_number', () => {
    expect(
      orderStickerCellValue({
        marketplace: 'ozon',
        status: 'in_assembly',
        orderId: '74369038-0308-1',
        assemblyStickerNumber: 'ii50048401925',
      })
    ).toBe('ii50048401925');
  });

  test('Ozon: старый числовой lower_barcode не показываем', () => {
    expect(
      orderStickerCellValue({
        marketplace: 'ozon',
        status: 'assembled',
        orderId: '0231280304-0006-1',
        assemblyStickerNumber: '302085861110000',
      })
    ).toBe('—');
  });

  test('Ozon: не подставляет order_number вместо стикера', () => {
    expect(
      orderStickerCellValue({
        marketplace: 'ozon',
        status: 'assembled',
        orderId: '74369038-0308-1',
        assemblyStickerNumber: '74369038-0308',
      })
    ).toBe('—');
  });

  test('ozonStickerMissing: нужен догруз для старого lower_barcode, не нужен для ii…', () => {
    const base = { marketplace: 'ozon', status: 'assembled', orderId: '0231280304-0006-1' };
    expect(ozonStickerMissing({ ...base, assemblyStickerNumber: '302085861110000' })).toBe(true);
    expect(ozonStickerMissing(base)).toBe(true);
    expect(ozonStickerMissing({ ...base, assemblyStickerNumber: 'ii50048401925' })).toBe(false);
    expect(ozonStickerMissing({ ...base, marketplace: 'wildberries' })).toBe(false);
  });

  test('Ozon: без ШК — прочерк', () => {
    expect(
      orderStickerCellValue({
        marketplace: 'ozon',
        status: 'in_assembly',
        orderId: '74369038-0308-1',
      })
    ).toBe('—');
  });

  test('WB: номер стикера как есть', () => {
    expect(
      orderStickerCellValue({
        marketplace: 'wildberries',
        status: 'in_assembly',
        orderId: '5956322304',
        assemblyStickerNumber: '1234567890',
      })
    ).toBe('1234567890');
  });
});

describe('orderHasAssemblySticker', () => {
  test('WB без стикера собирать нельзя, со стикером — можно', () => {
    const base = { marketplace: 'wildberries', status: 'in_assembly', orderId: '5956322304' };
    expect(orderHasAssemblySticker(base)).toBe(false);
    expect(orderHasAssemblySticker({ ...base, assemblyStickerNumber: '1234567890' })).toBe(true);
  });

  test('Ozon: числовой lower_barcode не считается стикером', () => {
    const base = { marketplace: 'ozon', status: 'in_assembly', orderId: '74369038-0308-1' };
    expect(orderHasAssemblySticker({ ...base, assemblyStickerNumber: '302085861110000' })).toBe(false);
    expect(orderHasAssemblySticker({ ...base, assemblyStickerNumber: 'ii50048401925' })).toBe(true);
  });

  test('Яндекс и ручные заказы стикер не требуют', () => {
    expect(orderHasAssemblySticker({ marketplace: 'yandex', orderId: '1' })).toBe(true);
    expect(orderHasAssemblySticker({ marketplace: 'manual', orderId: '2' })).toBe(true);
  });
});
