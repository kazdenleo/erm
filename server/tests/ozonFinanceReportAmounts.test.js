import { extractOzonFinanceAmounts } from '../src/utils/ozonFinanceReportAmounts.js';
import { buildOrderBreakdownFromLines } from '../src/utils/marketplaceReportBreakdown.js';

describe('extractOzonFinanceAmounts', () => {
  test('client return after purchase reverses commission, not logistics', () => {
    const amounts = extractOzonFinanceAmounts({
      operation_type: 'ClientReturnAgentOperation',
      accruals_for_sale: -1200,
      sale_commission: 216,
      amount: -984,
      return_delivery_charge: 0,
      services: [],
    });
    expect(amounts.retail_amount).toBe(0);
    expect(amounts.commission_amount).toBe(-216);
    expect(amounts.logistics_amount).toBe(0);
    expect(amounts.payout_amount).toBe(-984);
  });

  test('return without accruals stays a logistics charge', () => {
    const amounts = extractOzonFinanceAmounts({
      operation_type: 'ClientReturnAgentOperation',
      accruals_for_sale: 0,
      sale_commission: 0,
      amount: -75,
      services: [],
    });
    expect(amounts.logistics_amount).toBe(75);
    expect(amounts.commission_amount).toBe(0);
  });
});

describe('buildOrderBreakdownFromLines', () => {
  test('sale and its reversal net out in retail and commission', () => {
    const sale = {
      marketplace: 'ozon',
      operation_type: 'OperationAgentDeliveredToCustomer',
      raw_json: { accruals_for_sale: 1200, sale_commission: -216, services: [] },
    };
    const reversal = {
      marketplace: 'ozon',
      operation_type: 'ClientReturnAgentOperation',
      raw_json: { accruals_for_sale: -1200, sale_commission: 216, services: [] },
    };
    const b = buildOrderBreakdownFromLines([sale, reversal]);
    expect(b.totals.retail).toBe(0);
    expect(b.totals.commission).toBe(0);
    expect(b.totals.logistics).toBe(0);
  });
});
