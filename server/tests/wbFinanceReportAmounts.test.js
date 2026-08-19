import { extractWbFinanceAmounts } from '../src/utils/wbFinanceReportAmounts.js';

describe('extractWbFinanceAmounts', () => {
  test('sale uses retail_price as commission base, not discounted retail_amount', () => {
    const amounts = extractWbFinanceAmounts({
      supplier_oper_name: 'Продажа',
      quantity: 1,
      retail_price: 742,
      retail_amount: 640,
      commission_percent: 50,
      ppvz_sales_commission: 220.49,
      acquiring_fee: 25.6,
      ppvz_for_pay: 345.4,
      delivery_rub: 0,
    });
    expect(amounts.retail_amount).toBe(742);
    expect(amounts.commission_amount).toBe(371);
    expect(amounts.acquiring_amount).toBe(25.6);
    expect(amounts.payout_amount).toBe(345.4);
    expect(amounts.logistics_amount).toBe(0);
  });

  test('logistics line keeps report for_pay (usually 0)', () => {
    const amounts = extractWbFinanceAmounts({
      supplier_oper_name: 'Логистика',
      quantity: 0,
      retail_amount: 0,
      delivery_rub: 93.63,
      ppvz_for_pay: 0,
    });
    expect(amounts.retail_amount).toBe(0);
    expect(amounts.logistics_amount).toBe(93.63);
    expect(amounts.payout_amount).toBe(0);
  });

  test('sale payout stays for_pay and is not reduced by a zero delivery_rub', () => {
    const amounts = extractWbFinanceAmounts({
      supplier_oper_name: 'Продажа',
      quantity: 1,
      retail_price: 742,
      retail_amount: 640,
      commission_percent: 50,
      acquiring_fee: 25.6,
      ppvz_for_pay: 345.4,
      delivery_rub: 0,
    });
    expect(amounts.payout_amount).toBe(345.4);
  });
});
