import {
  mapOzonPostings,
  mapWbOrders,
  mapYmOrders,
  mergeLines,
  ymdChunks,
  ymItemUnitPrice,
} from '../src/utils/marketplaceFboOrdersMap.js';

describe('marketplaceFboOrdersMap', () => {
  test('Ozon: позиция отправления, цена продавца, отмена', () => {
    const lines = mapOzonPostings([
      {
        posting_number: '0249111121-0036-1',
        status: 'awaiting_packaging',
        created_at: '2026-10-09T13:35:55.158990Z',
        products: [{ sku: 1558576561, name: 'Наконечник', quantity: 1, offer_id: 'DTSN2468-69LR', price: '3392.00' }],
        analytics_data: { warehouse_name: 'ЯРОСЛАВЛЬ_РФЦ' },
      },
      {
        posting_number: '1-1',
        status: 'cancelled',
        created_at: '2026-10-08T10:00:00Z',
        products: [{ sku: 1, offer_id: 'A', quantity: 2, price: '100' }],
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      order_id: '0249111121-0036-1',
      line_key: '1558576561',
      offer_id: 'DTSN2468-69LR',
      quantity: 1,
      price: 3392,
      is_cancelled: false,
      warehouse_name: 'ЯРОСЛАВЛЬ_РФЦ',
    });
    expect(lines[1]).toMatchObject({ quantity: 2, price: 100, is_cancelled: true });
  });

  test('WB: только склад WB, srid как номер, повтор берёт последнее изменение', () => {
    const base = {
      date: '2026-10-07T06:27:08',
      warehouseName: 'Коледино',
      supplierArticle: 'wb171plaig11',
      nmId: 223167899,
      subject: 'Щетки стеклоочистителя',
      brand: 'KURUMAKIT',
      priceWithDisc: 794,
      srid: 'eBb.r8dc55.0.0',
    };
    const lines = mapWbOrders([
      { ...base, warehouseType: 'Склад WB', isCancel: false },
      { ...base, srid: 'fbs-1', warehouseType: 'Склад продавца', isCancel: false },
      { ...base, warehouseType: 'Склад WB', isCancel: true },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      order_id: 'eBb.r8dc55.0.0',
      offer_id: 'wb171plaig11',
      sku: '223167899',
      quantity: 1,
      price: 794,
      is_cancelled: true,
      ordered_at: '2026-10-07T06:27:08+03:00',
    });
  });

  test('Яндекс: цена = покупатель + компенсация Маркета, статусы отмены', () => {
    const item = {
      offerName: 'Наконечник',
      marketSku: 103610100393,
      shopSku: 'DTSN2170-71RL',
      count: 1,
      prices: [
        { type: 'MARKETPLACE', costPerItem: 981, total: 981 },
        { type: 'BUYER', costPerItem: 1693, total: 1693 },
      ],
      warehouse: { name: 'Софьино' },
    };
    expect(ymItemUnitPrice(item)).toBe(2674);
    const lines = mapYmOrders([
      { id: 62757152321, creationDate: '2026-10-06', status: 'DELIVERY', items: [item] },
      { id: 2, creationDate: '2026-10-05', status: 'CANCELLED_BEFORE_PROCESSING', items: [item] },
    ]);
    expect(lines[0]).toMatchObject({
      order_id: '62757152321',
      line_key: 'DTSN2170-71RL',
      price: 2674,
      is_cancelled: false,
      ordered_at: '2026-10-06T12:00:00+03:00',
    });
    expect(lines[1].is_cancelled).toBe(true);
  });

  test('повтор позиции в заказе схлопывается со средневзвешенной ценой', () => {
    const merged = mergeLines([
      { order_id: '1', line_key: 'A', quantity: 1, price: 100 },
      { order_id: '1', line_key: 'A', quantity: 3, price: 200 },
    ]);
    expect(merged).toEqual([{ order_id: '1', line_key: 'A', quantity: 4, price: 175 }]);
  });

  test('период режется на куски включительно', () => {
    expect(ymdChunks('2026-07-01', '2026-08-15', 30)).toEqual([
      ['2026-07-01', '2026-07-30'],
      ['2026-07-31', '2026-08-15'],
    ]);
    expect(ymdChunks('2026-10-09', '2026-10-09', 30)).toEqual([['2026-10-09', '2026-10-09']]);
  });
});
