import { computeProcurementDeficit } from '../src/utils/orderProcurementCoverage.js';
import {
  isSourceEntrySupplierSubmitted,
  parseSourceOrdersEntries,
} from '../src/utils/orderSupplierSubmitScope.js';

describe('auto procurement anti-duplicate coverage', () => {
  test('deficit is zero when purchased covers need', () => {
    const c = computeProcurementDeficit({
      quantityNeeded: 2,
      quantityReserved: 0,
      quantityPurchased: 2,
    });
    expect(c.deficit).toBe(0);
  });

  test('deficit shrinks by reserved + purchased', () => {
    const c = computeProcurementDeficit({
      quantityNeeded: 5,
      quantityReserved: 2,
      quantityPurchased: 2,
    });
    expect(c.deficit).toBe(1);
  });

  test('source order submit flags survive parse', () => {
    const entries = parseSourceOrdersEntries([
      { marketplace: 'ozon', orderId: '1', supplierSubmittedAt: '2026-07-21T00:00:00.000Z' },
      { marketplace: 'ozon', orderId: '2' },
    ]);
    expect(isSourceEntrySupplierSubmitted(entries[0])).toBe(true);
    expect(isSourceEntrySupplierSubmitted(entries[1])).toBe(false);
  });
});
