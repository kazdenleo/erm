import {
  mergeStatusWithProcurement,
  shouldAdvanceFromProcurement,
} from '../src/services/orders.sync.service.js';

describe('shouldAdvanceFromProcurement', () => {
  test('allows only logistics and cancel from marketplace', () => {
    for (const status of ['shipped', 'in_transit', 'delivered', 'cancelled']) {
      expect(shouldAdvanceFromProcurement(status)).toBe(true);
    }
  });

  test('does not pull assembly statuses from marketplace', () => {
    expect(shouldAdvanceFromProcurement('in_assembly')).toBe(false);
    expect(shouldAdvanceFromProcurement('wb_assembly')).toBe(false);
    expect(shouldAdvanceFromProcurement('assembled')).toBe(false);
  });

  test('blocks rollback to new or unknown', () => {
    expect(shouldAdvanceFromProcurement('new')).toBe(false);
    expect(shouldAdvanceFromProcurement('unknown')).toBe(false);
    expect(shouldAdvanceFromProcurement('')).toBe(false);
  });
});

describe('mergeStatusWithProcurement', () => {
  test('keeps in_procurement when MP still new', () => {
    expect(mergeStatusWithProcurement({ status: 'in_procurement' }, 'new')).toBe('in_procurement');
  });

  test('keeps in_procurement when MP reports assembly', () => {
    expect(mergeStatusWithProcurement({ status: 'in_procurement' }, 'in_assembly')).toBe(
      'in_procurement'
    );
    expect(mergeStatusWithProcurement({ status: 'in_procurement' }, 'assembled')).toBe(
      'in_procurement'
    );
  });

  test('advances when MP moved to logistics', () => {
    expect(mergeStatusWithProcurement({ status: 'in_procurement' }, 'shipped')).toBe('shipped');
    expect(mergeStatusWithProcurement({ status: 'in_procurement' }, 'cancelled')).toBe('cancelled');
  });

  test('passes through when not in procurement', () => {
    expect(mergeStatusWithProcurement({ status: 'new' }, 'shipped')).toBe('shipped');
  });
});
