/**
 * Контракт: при обязательной отправке API отказ поставщика = откат локальной закупки.
 * Успешный Basket_Add / ambiguous timeout — не откатываем принятое.
 */

import {
  supplierSubmitNeedsRollback,
  rollbackItemsForSupplierSubmit,
  basketItemIdsForRollback,
} from '../src/utils/supplierSubmitRollback.js';
import {
  hasRecentSupplierAccept,
  rememberSupplierAccept,
  _clearRecentSupplierAcceptsForTests,
} from '../src/utils/recentSupplierAccept.js';

describe('supplier submit rollback contract', () => {
  test('full reject from any supplier triggers rollback', () => {
    expect(
      supplierSubmitNeedsRollback(
        {
          submitted: false,
          reason: 'basket_rejected',
          message: 'Блокировка покупки у поставщика',
        },
        { apiSubmitRequired: true }
      )
    ).toBe(true);
    expect(
      supplierSubmitNeedsRollback(
        {
          submitted: false,
          reason: 'submit_error',
          message: 'Moskvorechie HTTP 500',
        },
        { apiSubmitRequired: true }
      )
    ).toBe(true);
  });

  test('success does not rollback', () => {
    expect(
      supplierSubmitNeedsRollback({ submitted: true, message: 'ok' }, { apiSubmitRequired: true })
    ).toBe(false);
  });

  test('accepted Basket_Add lines are never full-rolled-back', () => {
    expect(
      supplierSubmitNeedsRollback(
        {
          submitted: false,
          reason: 'submit_error',
          message: 'mark failed',
          lines: [{ productId: 49, basketItemId: 273111280 }],
        },
        { apiSubmitRequired: true }
      )
    ).toBe(false);
  });

  test('partial with failedLines triggers rollback of failed only', () => {
    expect(
      supplierSubmitNeedsRollback(
        {
          submitted: true,
          partial: true,
          lines: [{ productId: 1, basketItemId: 10 }],
          failedLines: [{ productId: 2, reason: 'basket_rejected' }],
        },
        { apiSubmitRequired: true }
      )
    ).toBe(true);

    const items = [
      { productId: 1, quantity: 1 },
      { productId: 2, quantity: 1 },
    ];
    expect(
      rollbackItemsForSupplierSubmit(items, {
        lines: [{ productId: 1, basketItemId: 10 }],
        failedLines: [{ productId: 2 }],
      }).map((i) => i.productId)
    ).toEqual([2]);
  });

  test('ambiguous timeout does not rollback', () => {
    expect(
      supplierSubmitNeedsRollback(
        {
          submitted: false,
          reason: 'ambiguous_submit',
          ambiguousSuccess: true,
        },
        { apiSubmitRequired: true }
      )
    ).toBe(false);
  });

  test('skipped (API not required path) does not rollback', () => {
    expect(
      supplierSubmitNeedsRollback(
        { submitted: false, skipped: true, reason: 'submit_disabled' },
        { apiSubmitRequired: true }
      )
    ).toBe(false);
  });

  test('without API requirement never rollbacks', () => {
    expect(
      supplierSubmitNeedsRollback({ submitted: false, reason: 'all_failed' }, { apiSubmitRequired: false })
    ).toBe(false);
  });

  test('basketItemIdsForRollback only for rolled-back products', () => {
    expect(
      basketItemIdsForRollback(
        {
          lines: [
            { productId: 1, basketItemId: 100 },
            { productId: 2, basketItemId: 200 },
          ],
        },
        [{ productId: 2 }]
      )
    ).toEqual([200]);
  });
});

describe('recent supplier accept anti-dupe', () => {
  beforeEach(() => {
    _clearRecentSupplierAcceptsForTests();
  });

  test('remembers accept for order+product', () => {
    expect(hasRecentSupplierAccept(1, 10, 49)).toBe(false);
    rememberSupplierAccept(1, 10, 49);
    expect(hasRecentSupplierAccept(1, 10, 49)).toBe(true);
    expect(hasRecentSupplierAccept(1, 10, 50)).toBe(false);
  });
});
