import {
  orderStickerCellValue,
  ozonOrderNumberFromPostingNumber,
} from './orderStickerDisplay.js';

describe('ozonOrderNumberFromPostingNumber', () => {
  test('strips posting index', () => {
    expect(ozonOrderNumberFromPostingNumber('74369038-0308-1')).toBe('74369038-0308');
  });
});

describe('orderStickerCellValue', () => {
  test('Ozon: только ШК этикетки, без posting и order_number', () => {
    expect(
      orderStickerCellValue({
        marketplace: 'ozon',
        status: 'in_assembly',
        orderId: '74369038-0308-1',
        assemblyStickerNumber: '201026795970000',
      })
    ).toBe('201026795970000');
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
