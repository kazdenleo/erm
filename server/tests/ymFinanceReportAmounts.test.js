import { extractYmFinanceAmounts } from '../src/utils/ymFinanceReportAmounts.js';
import { buildYmLineBreakdown, buildAmountTooltips, buildOrderBreakdownFromLines } from '../src/utils/marketplaceReportBreakdown.js';

describe('YM finance amounts', () => {
  test('баллы за скидку Маркета (начисление) — выручка, не удержание', () => {
    const amounts = extractYmFinanceAmounts({
      transactionType: 'Начисление',
      transactionSource: 'Баллы за скидку Маркета',
      offerOrServiceName: 'Воздушные фильтры NORDFIL AN1010',
      transactionSum: 290,
    });
    expect(amounts.other_deductions).toBe(0);
    expect(amounts.retail_amount).toBe(290);
    expect(amounts.payout_amount).toBe(290);
  });

  test('скидка за совместные акции (списание) — прочее удержание', () => {
    const amounts = extractYmFinanceAmounts({
      transactionType: 'Списание',
      transactionSource: 'Скидка за участие в совместных акциях',
      offerOrServiceName: 'Размещение товарных предложений',
      transactionSum: -212.13,
    });
    expect(amounts.other_deductions).toBeCloseTo(212.13);
    expect(amounts.payout_amount).toBeCloseTo(-212.13);
  });

  test('приём платежа — эквайринг, не прочее', () => {
    const amounts = extractYmFinanceAmounts({
      transactionType: 'Удержание',
      transactionSource: 'Оплата услуг Маркета',
      offerOrServiceName: 'Приём платежа',
      transactionSum: -0.12,
    });
    expect(amounts.acquiring_amount).toBeCloseTo(0.12);
    expect(amounts.other_deductions).toBe(0);
  });
});

describe('YM breakdown tooltip labels', () => {
  test('баллы не попадают в прочее и подписываются источником, не товаром', () => {
    const parts = buildYmLineBreakdown({
      marketplace: 'ym',
      retail_amount: 290,
      other_deductions: 0,
      raw_json: {
        transactionType: 'Начисление',
        transactionSource: 'Баллы за скидку Маркета',
        offerOrServiceName: 'Воздушные фильтры NORDFIL AN1010',
        transactionSum: 290,
      },
    });
    expect(parts.other).toEqual([]);
    expect(parts.retail[0].label).toBe('Баллы за скидку Маркета');
    expect(parts.retail[0].amount).toBe(290);
  });

  test('совместная акция в прочем подписывается источником, не оффером', () => {
    const parts = buildYmLineBreakdown({
      marketplace: 'ym',
      other_deductions: 212.13,
      raw_json: {
        transactionType: 'Списание',
        transactionSource: 'Скидка за участие в совместных акциях',
        offerOrServiceName: 'Размещение товарных предложений',
        transactionSum: -212.13,
      },
    });
    expect(parts.other[0].label).toBe('Скидка за участие в совместных акциях');
    expect(parts.other[0].amount).toBeCloseTo(212.13);
  });

  test('подсказка «Прочее» для приёма платежа + акции', () => {
    const breakdown = buildOrderBreakdownFromLines([
      {
        marketplace: 'ym',
        acquiring_amount: 0.12,
        raw_json: {
          transactionType: 'Удержание',
          transactionSource: 'Оплата услуг Маркета',
          offerOrServiceName: 'Приём платежа',
          transactionSum: -0.12,
        },
      },
      {
        marketplace: 'ym',
        other_deductions: 212,
        raw_json: {
          transactionType: 'Списание',
          transactionSource: 'Скидка за участие в совместных акциях',
          offerOrServiceName: 'Воздушные фильтры NORDFIL AN1010',
          transactionSum: -212,
        },
      },
    ]);
    const tips = buildAmountTooltips(breakdown);
    expect(tips.other).toContain('Приём платежа');
    expect(tips.other).toContain('Скидка за участие в совместных акциях');
    expect(tips.other).not.toContain('Воздушные фильтры');
  });
});
