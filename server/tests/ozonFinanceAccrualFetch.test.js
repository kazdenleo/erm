import {
  moneyAmount,
  normalizeAccrualToOperation,
  filterOzonFbsAccrualOperations,
} from '../src/utils/ozonFinanceAccrualFetch.js';
import { extractOzonFinanceAmounts } from '../src/utils/ozonFinanceReportAmounts.js';

describe('ozonFinanceAccrualFetch normalizeAccrualToOperation', () => {
  const types = new Map([
    ['1', { id: 1, code: 'Acquiring', name: 'Acquiring' }],
    ['32', { id: 32, code: 'Logistic', name: 'Logistic' }],
  ]);

  test('moneyAmount parses Money object', () => {
    expect(moneyAmount({ amount: '-8.72', currency: 'RUB' })).toBeCloseTo(-8.72);
    expect(moneyAmount('10')).toBe(10);
  });

  test('POSTING sale maps to OperationAgentDeliveredToCustomer with amounts', () => {
    const op = normalizeAccrualToOperation(
      {
        accrual_id: 1,
        date: '2026-10-20',
        total_amount: { amount: '306.50', currency: 'RUB' },
        unit_number: '123-001',
        accrued_category: 'POSTING',
        posting: {
          delivery_schema: 'Fbs',
          products: [
            {
              sku: 111,
              quantity: 1,
              commission: {
                seller_price: { amount: '790', currency: 'RUB' },
                sale_commission: { amount: '-379.20', currency: 'RUB' },
                sale_amount: { amount: '790', currency: 'RUB' },
              },
              delivery: {
                services: [{ type_id: 32, accrued: { amount: '-104.30', currency: 'RUB' } }],
              },
            },
          ],
        },
      },
      types
    );
    expect(op.operation_type).toBe('OperationAgentDeliveredToCustomer');
    expect(op.posting.posting_number).toBe('123-001');
    expect(op.accruals_for_sale).toBe(790);
    expect(op.amount).toBeCloseTo(306.5);
    expect(op.services[0].name).toBe('Logistic');
    const amounts = extractOzonFinanceAmounts(op);
    expect(amounts.retail_amount).toBe(790);
    expect(amounts.commission_amount).toBeCloseTo(379.2);
    expect(amounts.logistics_amount).toBeCloseTo(104.3);
    expect(amounts.payout_amount).toBeCloseTo(306.5);
  });

  test('POSTING storno maps to OperationAgentStornoDeliveredToCustomer', () => {
    const op = normalizeAccrualToOperation(
      {
        accrual_id: 2,
        date: '2026-10-20',
        total_amount: { amount: '-458.45', currency: 'RUB' },
        unit_number: '06541516-0959-1',
        accrued_category: 'POSTING',
        posting: {
          delivery_schema: 'Fbs',
          products: [
            {
              sku: 2885662087,
              quantity: 1,
              commission: {
                seller_price: { amount: '-865', currency: 'RUB' },
                sale_commission: { amount: '406.55', currency: 'RUB' },
                sale_amount: { amount: '-865', currency: 'RUB' },
              },
            },
          ],
        },
      },
      types
    );
    expect(op.operation_type).toBe('OperationAgentStornoDeliveredToCustomer');
    expect(op.accruals_for_sale).toBe(-865);
  });

  test('ITEM acquiring keeps unit_number and type name', () => {
    const op = normalizeAccrualToOperation(
      {
        accrual_id: 3,
        date: '2026-10-20',
        total_amount: { amount: '-8.72', currency: 'RUB' },
        unit_number: '123-001',
        accrued_category: 'ITEM',
        item_fees: {
          fees: [
            {
              sku: 111,
              quantity: 1,
              fees: [{ type_id: 1, accrued: { amount: '-8.72', currency: 'RUB' } }],
            },
          ],
        },
      },
      types
    );
    expect(op.operation_type).toBe('Acquiring');
    expect(op.posting.posting_number).toBe('123-001');
    expect(op.amount).toBeCloseTo(-8.72);
  });

  test('filterOzonFbsAccrualOperations keeps ITEM for FBS posting unit', () => {
    const sale = normalizeAccrualToOperation(
      {
        accrual_id: 1,
        date: '2026-10-20',
        total_amount: { amount: '100', currency: 'RUB' },
        unit_number: 'FBS-1',
        accrued_category: 'POSTING',
        posting: {
          delivery_schema: 'Fbs',
          products: [
            {
              sku: 1,
              quantity: 1,
              commission: { seller_price: { amount: '200', currency: 'RUB' }, sale_commission: { amount: '-50', currency: 'RUB' } },
            },
          ],
        },
      },
      types
    );
    const fee = normalizeAccrualToOperation(
      {
        accrual_id: 2,
        date: '2026-10-20',
        total_amount: { amount: '-2', currency: 'RUB' },
        unit_number: 'FBS-1',
        accrued_category: 'ITEM',
        item_fees: { fees: [{ sku: 1, fees: [{ type_id: 1, accrued: { amount: '-2', currency: 'RUB' } }] }] },
      },
      types
    );
    const fbo = normalizeAccrualToOperation(
      {
        accrual_id: 3,
        date: '2026-10-20',
        total_amount: { amount: '50', currency: 'RUB' },
        unit_number: 'FBO-9',
        accrued_category: 'POSTING',
        posting: {
          delivery_schema: 'Fbo',
          products: [
            {
              sku: 2,
              quantity: 1,
              commission: { seller_price: { amount: '100', currency: 'RUB' }, sale_commission: { amount: '-20', currency: 'RUB' } },
            },
          ],
        },
      },
      types
    );
    const filtered = filterOzonFbsAccrualOperations([sale, fee, fbo]);
    expect(filtered.map((o) => o.operation_id).sort()).toEqual([1, 2]);
  });
});
