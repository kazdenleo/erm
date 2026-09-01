import {
  attachOrderEconomics,
  isWbNumericOrderId,
  isWbSridOrderId,
  orderLookupKeys,
} from '../src/utils/marketplaceOrderEconomics.js';

describe('marketplaceOrderEconomics', () => {
  test('WB order id helpers', () => {
    expect(isWbNumericOrderId('5420991920')).toBe(true);
    expect(isWbNumericOrderId('ey.ra30788bbc72d4a159b71ff3755158feb.0.0')).toBe(false);
    expect(isWbSridOrderId('ey.ra30788bbc72d4a159b71ff3755158feb.0.0')).toBe(true);
    expect(isWbSridOrderId('5420991920')).toBe(false);
  });

  test('orderLookupKeys strips Ozon ~n and YM :sku', () => {
    expect(orderLookupKeys('43536637-0509-1~1')).toEqual(['43536637-0509-1~1', '43536637-0509-1']);
    expect(orderLookupKeys('60267017346:AN1014M')).toEqual(['60267017346:AN1014M', '60267017346']);
    expect(orderLookupKeys('5488264444')).toEqual(['5488264444']);
  });

  test('attachOrderEconomics sums MP fees as costs, payout as received', () => {
    const out = attachOrderEconomics({
      retailAmount: 1000,
      costAmount: 200,
      expensesTotal: 150,
      payoutAmount: 850,
      commissionAmount: 100,
      logisticsAmount: 50,
    });
    expect(out.saleAmount).toBe(1000);
    expect(out.costsTotal).toBe(150);
    expect(out.receivedAmount).toBe(850);
    expect(out.revenueAmount).toBe(650);
  });

  test('WB revenue subtracts logistics, other MPs do not', () => {
    const wb = attachOrderEconomics({
      marketplace: 'wb',
      payoutAmount: 345,
      costAmount: 254,
      additionalExpensesAmount: 5,
      logisticsAmount: 96,
      expensesTotal: 0,
    });
    expect(wb.receivedAmount).toBe(345);
    expect(wb.revenueAmount).toBe(-10);
    const ozon = attachOrderEconomics({
      marketplace: 'ozon',
      payoutAmount: 475,
      costAmount: 200,
      additionalExpensesAmount: 5,
      logisticsAmount: 149,
      expensesTotal: 0,
    });
    expect(ozon.revenueAmount).toBe(270);
  });

  test('attachOrderEconomics does not include additional expenses in costsTotal', () => {
    const out = attachOrderEconomics({
      retailAmount: 1000,
      costAmount: 200,
      additionalExpensesAmount: 40,
      expensesTotal: 150,
      payoutAmount: 850,
    });
    expect(out.additionalExpensesAmount).toBe(40);
    expect(out.costsTotal).toBe(150);
  });
});
