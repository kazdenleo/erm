/**
 * Unit-тесты отправки поставщику по заказу (не по всей закупке).
 */

import {
  parseSourceOrdersEntries,
  selectLinesForOrderSupplierSubmit,
  sourceEntryMatchesOrderScope,
  quantityForOrderScopeLine,
} from '../src/utils/orderSupplierSubmitScope.js';

const scopeWb = {
  marketplace: 'wildberries',
  orderId: '5262142663',
  lookupIds: ['5262142663'],
  marketplaceVariants: ['wildberries', 'wb'],
};

const linePending = {
  purchase_item_id: 1,
  product_id: 78,
  expected_quantity: 1,
  source_orders: [
    { marketplace: 'wb', orderId: '5262142663' },
    { marketplace: 'wb', orderId: '9999999999', supplierSubmittedAt: '2026-06-24T10:00:00Z' },
  ],
};

const lineSubmitted = {
  purchase_item_id: 2,
  product_id: 79,
  expected_quantity: 1,
  source_orders: [
    {
      marketplace: 'wb',
      orderId: '5262142663',
      supplierSubmittedAt: '2026-06-24T15:25:44Z',
    },
  ],
};

describe('parseSourceOrdersEntries', () => {
  test('парсит JSON-строку и camelCase/snake_case', () => {
    const raw = JSON.stringify([
      { marketplace: 'wb', order_id: '1', supplier_submitted_at: '2026-01-01' },
    ]);
    expect(parseSourceOrdersEntries(raw)).toEqual([
      {
        marketplace: 'wb',
        orderId: '1',
        supplierSubmittedAt: '2026-01-01',
        supplierBasketItemId: null,
      },
    ]);
  });
});

describe('sourceEntryMatchesOrderScope', () => {
  test('сопоставляет wb и wildberries', () => {
    expect(
      sourceEntryMatchesOrderScope(
        { marketplace: 'wb', orderId: '5262142663' },
        scopeWb
      )
    ).toBe(true);
    expect(
      sourceEntryMatchesOrderScope(
        { marketplace: 'wildberries', orderId: '5262142663' },
        scopeWb
      )
    ).toBe(true);
    expect(
      sourceEntryMatchesOrderScope({ marketplace: 'wb', orderId: 'other' }, scopeWb)
    ).toBe(false);
  });
});

describe('selectLinesForOrderSupplierSubmit', () => {
  test('берёт только неотправленные позиции выбранного заказа', () => {
    const lines = selectLinesForOrderSupplierSubmit(
      [linePending, lineSubmitted],
      scopeWb
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].product_id).toBe(78);
    expect(lines[0].expected_quantity).toBe(1);
  });

  test('не возвращает строки, если заказ уже отправлен', () => {
    expect(selectLinesForOrderSupplierSubmit([lineSubmitted], scopeWb)).toHaveLength(0);
  });

  test('force отправляет всю строку независимо от supplierSubmittedAt', () => {
    const lines = selectLinesForOrderSupplierSubmit([lineSubmitted], scopeWb, { force: true });
    expect(lines).toHaveLength(1);
    expect(lines[0].expected_quantity).toBe(1);
  });
});

describe('quantityForOrderScopeLine', () => {
  test('считает pending entries, а не всю expected_quantity при нескольких заказах', () => {
    const line = {
      expected_quantity: 3,
      source_orders: [
        { marketplace: 'wb', orderId: '5262142663' },
        { marketplace: 'wb', orderId: '5262142663' },
        { marketplace: 'wb', orderId: '111', supplierSubmittedAt: '2026-01-01' },
      ],
    };
    expect(quantityForOrderScopeLine(line, scopeWb)).toBe(2);
  });
});
