import { prioritizeAssemblyListOrder } from './prioritizeAssemblyListOrder.js';

describe('prioritizeAssemblyListOrder', () => {
  test('ставит заказы левой карточки первыми при общем SKU в очереди', () => {
    const list = [
      { marketplace: 'wildberries', orderId: 'AC' },
      { marketplace: 'wildberries', orderId: 'AB' },
      { marketplace: 'ozon', orderId: 'X' },
    ];
    const head = {
      rows: [{ marketplace: 'wildberries', orderId: 'AB' }],
    };
    expect(prioritizeAssemblyListOrder(list, head)).toEqual([
      { marketplace: 'wildberries', orderId: 'AB' },
      { marketplace: 'wildberries', orderId: 'AC' },
      { marketplace: 'ozon', orderId: 'X' },
    ]);
  });

  test('без headGroup возвращает исходный список', () => {
    const list = [{ marketplace: 'ozon', orderId: '1' }];
    expect(prioritizeAssemblyListOrder(list, null)).toEqual(list);
  });
});
