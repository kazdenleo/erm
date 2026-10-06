import { buildAssemblyNextRecommendation } from './assemblyNextRecommendation.js';

describe('buildAssemblyNextRecommendation', () => {
  test('берёт первый заказ группы: комплект и упаковка', () => {
    const order = {
      id: 42,
      orderId: '1',
      marketplace: 'ozon',
      productId: 10,
      productName: 'Набор фильтров',
      offerId: 'KIT-1',
      quantity: 1,
      warehouseId: 5,
      isKit: true,
      packingDisplayValue: 'Пакет zip',
      assemblyCompositionLines: [
        { article: 'A1', quantity: 1, name: 'Фильтр A', displayAttributeValue: '' },
        { article: 'B2', quantity: 2, name: 'Фильтр B', displayAttributeValue: '' },
      ],
    };
    const hint = buildAssemblyNextRecommendation({
      key: 'ozon|o:1',
      rows: [order],
      primary: order,
    });
    expect(hint.isKit).toBe(true);
    expect(hint.productName).toBe('Набор фильтров');
    expect(hint.warehouseId).toBe(5);
    expect(hint.packingDisplayValue).toBe('Пакет zip');
    expect(hint.orderDbId).toBe(42);
    expect(hint.orderDbIds).toEqual([42]);
    expect(hint.marketplaceOrderId).toBe('1');
    expect(hint.components).toEqual([
      { article: 'A1', quantity: 1, productId: null, name: 'Фильтр A', displayAttributeValue: '' },
      { article: 'B2', quantity: 2, productId: null, name: 'Фильтр B', displayAttributeValue: '' },
    ]);
  });

  test('обычный товар без состава', () => {
    const order = {
      orderId: '2',
      marketplace: 'wildberries',
      productId: 20,
      productName: 'Фильтр',
      productSku: 'CN1115',
      quantity: 1,
      isKit: false,
    };
    const hint = buildAssemblyNextRecommendation({
      key: 'wb|o:2',
      rows: [order],
      primary: order,
    });
    expect(hint.isKit).toBe(false);
    expect(hint.article).toBe('CN1115');
    expect(hint.components.length).toBe(1);
  });

  test('пустая группа — null', () => {
    expect(buildAssemblyNextRecommendation(null)).toBeNull();
  });
});
