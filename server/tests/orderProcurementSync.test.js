import {
  mergeStatusWithProcurement,
  shouldAdvanceFromProcurement,
} from '../src/services/orders.sync.service.js';

describe('shouldAdvanceFromProcurement', () => {
  test('allows forward logistics and assembly statuses', () => {
    for (const status of [
      'in_assembly',
      'wb_assembly',
      'assembled',
      'shipped',
      'in_transit',
      'delivered',
      'cancelled',
    ]) {
      expect(shouldAdvanceFromProcurement(status)).toBe(true);
    }
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

  test('advances when MP moved forward', () => {
    expect(mergeStatusWithProcurement({ status: 'in_procurement' }, 'shipped')).toBe('shipped');
    expect(mergeStatusWithProcurement({ status: 'in_procurement' }, 'cancelled')).toBe('cancelled');
  });

  test('passes through when not in procurement', () => {
    expect(mergeStatusWithProcurement({ status: 'new' }, 'shipped')).toBe('shipped');
  });
});
