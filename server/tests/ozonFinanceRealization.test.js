import {
  mapRealizationRowToOperations,
  summarizeRealizationOperations,
  stripPostingSaleRetailForRealization,
  monthsOverlappingRange,
} from '../src/utils/ozonFinanceRealization.js';
import { extractOzonFinanceAmounts } from '../src/utils/ozonFinanceReportAmounts.js';
import { normalizeAccrualToOperation } from '../src/utils/ozonFinanceAccrualFetch.js';

describe('ozonFinanceRealization', () => {
  test('monthsOverlappingRange covers Aug only', () => {
    expect(monthsOverlappingRange('2026-08-01', '2026-08-31')).toEqual([{ year: 2026, month: 8 }]);
  });

  test('maps delivery_commission.amount as sale revenue (1C / отчёт о реализации)', () => {
    const ops = mapRealizationRowToOperations(
      {
        rowNumber: 1,
        item: { offer_id: 'AN1048', sku: 111, name: 'Фильтр', barcode: '123' },
        delivery_commission: {
          amount: 181781.52,
          quantity: 10,
          commission: 61704.81,
          total: 120076.71,
        },
        return_commission: {
          amount: 1336,
          quantity: 1,
          commission: 200,
          total: -1136,
        },
      },
      { year: 2026, month: 8 }
    );
    expect(ops).toHaveLength(2);
    const sale = ops[0];
    const ret = ops[1];
    expect(sale.operation_type).toBe('OperationAgentDeliveredToCustomer');
    expect(sale.accruals_for_sale).toBeCloseTo(181781.52);
    expect(sale.realization_source).toBe(true);
    expect(sale.operation_date).toBe('2026-08-31');

    const saleAmt = extractOzonFinanceAmounts(sale);
    expect(saleAmt.retail_amount).toBeCloseTo(181781.52);
    expect(saleAmt.commission_amount).toBeCloseTo(61704.81);

    expect(ret.operation_type).toBe('OperationAgentStornoDeliveredToCustomer');
    expect(ret.accruals_for_sale).toBeCloseTo(-1336);
    const retAmt = extractOzonFinanceAmounts(ret);
    expect(retAmt.commission_amount).toBeCloseTo(-200);
    expect(retAmt.payout_amount).toBeCloseTo(-1136);

    const summary = summarizeRealizationOperations(ops);
    expect(summary.sold).toBeCloseTo(181781.52);
    expect(summary.returned).toBeCloseTo(1336);
    expect(summary.revenue).toBeCloseTo(181781.52 - 1336);
    expect(summary.commission).toBeCloseTo(61704.81 - 200);
  });

  test('stripPostingSaleRetailForRealization zeroes sale fields and POSTING logistics services', () => {
    const op = {
      accrued_category: 'POSTING',
      operation_type: 'OperationAgentDeliveredToCustomer',
      accruals_for_sale: 3596,
      sale_commission: -1582,
      amount: 1871.71,
      services: [{ name: 'MarketplaceServiceItemDirectFlowLogistic', price: -132 }],
    };
    const stripped = stripPostingSaleRetailForRealization(op);
    expect(stripped.accruals_for_sale).toBe(0);
    expect(stripped.sale_commission).toBe(0);
    expect(stripped.amount).toBe(0);
    expect(stripped.services).toHaveLength(0);
    const amounts = extractOzonFinanceAmounts(stripped);
    expect(amounts.retail_amount).toBe(0);
    expect(amounts.commission_amount).toBe(0);
    expect(amounts.logistics_amount).toBe(0);
    expect(amounts.payout_amount).toBe(0);
  });

  test('normalizePostingAccrual prefers sale_amount sum over seller_price', () => {
    const op = normalizeAccrualToOperation(
      {
        accrual_id: 9,
        date: '2026-08-15',
        total_amount: { amount: '100', currency: 'RUB' },
        unit_number: 'x-1',
        accrued_category: 'POSTING',
        posting: {
          delivery_schema: 'Fbs',
          products: [
            {
              sku: 1,
              quantity: 1,
              commission: {
                seller_price: { amount: '1000', currency: 'RUB' },
                sale_amount: { amount: '600', currency: 'RUB' },
                sale_commission: { amount: '-200', currency: 'RUB' },
              },
            },
            {
              sku: 2,
              quantity: 1,
              commission: {
                seller_price: { amount: '500', currency: 'RUB' },
                sale_amount: { amount: '400', currency: 'RUB' },
                sale_commission: { amount: '-100', currency: 'RUB' },
              },
            },
          ],
        },
      },
      new Map()
    );
    expect(op.accruals_for_sale).toBeCloseTo(1000); // 600+400, not 1000+500
    expect(op.sale_commission).toBeCloseTo(-300);
  });
});
