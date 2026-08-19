import {
  formatPriceChangeGrounds,
  formatPriceChangeReason,
} from '../src/services/marketplacePriceChanges.service.js';

describe('formatPriceChangeGrounds', () => {
  test('explains hybrid steps: margin, competitor, sales', () => {
    const lines = formatPriceChangeGrounds({
      mode: 'hybrid',
      strategyName: 'Гибрид',
      steps: [
        { step: 'target_margin', margin_percent: 25, cost: 400, price: 500 },
        {
          step: 'competitor',
          applied: true,
          competitorAgg: 990,
          offset_percent: -1,
          price: 980,
        },
        {
          step: 'sales',
          applied: true,
          band: 'low',
          perDay: 0.05,
          soldQty: 1,
          windowDays: 14,
          price: 931,
        },
      ],
    });
    expect(lines.some((l) => l.includes('Целевая маржа'))).toBe(true);
    expect(lines.some((l) => l.includes('Конкуренты'))).toBe(true);
    expect(lines.some((l) => l.includes('Продажи'))).toBe(true);
  });

  test('min recalc fallback', () => {
    const lines = formatPriceChangeGrounds({ source: 'min_recalc' });
    expect(lines[0]).toMatch(/минимум/i);
  });
});

describe('formatPriceChangeReason', () => {
  test('manual', () => {
    expect(formatPriceChangeReason({ source: 'manual' })).toBe(
      'Ручное изменение фактической цены'
    );
  });

  test('strategy by name', () => {
    expect(
      formatPriceChangeReason({ source: 'strategy', strategyName: 'Гибрид', mode: 'hybrid' })
    ).toBe('Стратегия «Гибрид» (Гибрид)');
  });
});
