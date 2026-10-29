import {
  shouldFailoverAfterSupplierSubmit,
  rollbackDemandItemsForFailover,
  sourceOrderRefsFromDemandItems,
  unfulfillableOrderRefs,
  orderRefKey,
} from '../src/utils/supplierProcurementFailover.js';

describe('shouldFailoverAfterSupplierSubmit', () => {
  test('полный отказ — failover', () => {
    expect(
      shouldFailoverAfterSupplierSubmit(
        { submitted: false, reason: 'basket_rejected', message: 'блок' },
        { apiSubmitRequired: true }
      )
    ).toBe(true);
  });

  test('частичный приём — failover', () => {
    expect(
      shouldFailoverAfterSupplierSubmit(
        {
          submitted: true,
          partial: true,
          lines: [{ productId: 1, basketItemId: 10 }],
          failedLines: [{ productId: 2, reason: 'basket_rejected' }],
        },
        { apiSubmitRequired: true }
      )
    ).toBe(true);
  });

  test('таймаут ambiguous — не failover (риск дубля)', () => {
    expect(
      shouldFailoverAfterSupplierSubmit(
        {
          submitted: false,
          ambiguousSuccess: true,
          reason: 'ambiguous_submit',
          failedLines: [{ productId: 1, ambiguous: true }],
        },
        { apiSubmitRequired: true }
      )
    ).toBe(false);
  });

  test('успех — не failover', () => {
    expect(
      shouldFailoverAfterSupplierSubmit({ submitted: true, lines: [{ productId: 1 }] }, { apiSubmitRequired: true })
    ).toBe(false);
  });
});

describe('rollbackDemandItemsForFailover', () => {
  const items = [
    { productId: 1, quantity: 1, sourceOrders: [{ marketplace: 'ozon', orderId: 'a' }] },
    { productId: 2, quantity: 1, sourceOrders: [{ marketplace: 'wb', orderId: 'b' }] },
  ];

  test('failedLines — только отвергнутые', () => {
    const out = rollbackDemandItemsForFailover(items, {
      lines: [{ productId: 1 }],
      failedLines: [{ productId: 2 }],
    });
    expect(out.map((x) => x.productId)).toEqual([2]);
  });

  test('полный отказ — все позиции', () => {
    expect(rollbackDemandItemsForFailover(items, { submitted: false, reason: 'all_failed' })).toHaveLength(2);
  });
});

describe('unfulfillableOrderRefs', () => {
  test('исключает уже покрытые заказы', () => {
    const failed = [
      {
        productId: 1,
        sourceOrders: [
          { marketplace: 'ozon', orderId: 'keep' },
          { marketplace: 'wb', orderId: 'cancel-me' },
        ],
      },
    ];
    const covered = new Set([orderRefKey('ozon', 'keep')]);
    const refs = unfulfillableOrderRefs(failed, covered);
    expect(refs.map((r) => r.orderId)).toEqual(['cancel-me']);
  });

  test('sourceOrderRefsFromDemandItems нормализует МП', () => {
    expect(
      sourceOrderRefsFromDemandItems([
        { sourceOrders: [{ marketplace: 'wildberries', orderId: '1' }] },
      ])
    ).toEqual([{ marketplace: 'wb', orderId: '1' }]);
  });
});
