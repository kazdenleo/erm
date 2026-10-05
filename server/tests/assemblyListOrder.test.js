import {
  assemblyListOrderIndex,
  assemblyListOrderKey,
  pickFirstByAssemblyListOrder,
} from '../src/utils/assemblyListOrder.js';

describe('assemblyListOrderKey', () => {
  test('normalizes marketplace aliases', () => {
    expect(assemblyListOrderKey('wildberries', '123')).toBe('wb|123');
    expect(assemblyListOrderKey('WB', ' 123 ')).toBe('wb|123');
    expect(assemblyListOrderKey('yandex', '7')).toBe('ym|7');
    expect(assemblyListOrderKey('ozon', '')).toBe('');
  });
});

describe('pickFirstByAssemblyListOrder', () => {
  const candidates = [
    { marketplace: 'ozon', orderId: 'C' },
    { marketplace: 'wildberries', orderId: 'B' },
    { marketplace: 'ozon', orderId: 'A' },
  ];

  test('picks the order that comes first in the assembly table', () => {
    const index = assemblyListOrderIndex([
      { marketplace: 'ozon', orderId: 'X' },
      { marketplace: 'wb', orderId: 'B' },
      { marketplace: 'ozon', orderId: 'A' },
      { marketplace: 'ozon', orderId: 'C' },
    ]);
    expect(pickFirstByAssemblyListOrder(candidates, index)).toEqual({
      marketplace: 'wildberries',
      orderId: 'B',
    });
  });

  test('falls back to candidate order when none are in the list', () => {
    const index = assemblyListOrderIndex([{ marketplace: 'ozon', orderId: 'Z' }]);
    expect(pickFirstByAssemblyListOrder(candidates, index)).toEqual(candidates[0]);
  });

  test('listed orders win over unlisted ones', () => {
    const index = assemblyListOrderIndex([{ marketplace: 'ozon', orderId: 'A' }]);
    expect(pickFirstByAssemblyListOrder(candidates, index)).toEqual(candidates[2]);
  });

  test('returns null for empty candidates', () => {
    expect(pickFirstByAssemblyListOrder([], new Map())).toBeNull();
  });
});
