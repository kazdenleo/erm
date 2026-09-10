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

  test('min recalc lists concrete driver changes', () => {
    const lines = formatPriceChangeGrounds({
      source: 'min_recalc',
      driverChanges: [
        { label: 'Комиссия', unit: '%', before: 16, after: 18 },
        { label: 'Логистика', unit: '₽', before: 80, after: 95 },
      ],
    });
    expect(lines.some((l) => l.includes('Комиссия'))).toBe(true);
    expect(lines.some((l) => l.includes('Логистика'))).toBe(true);
    expect(lines.join(' ')).not.toMatch(/себестоимость или наценка/i);
  });

  test('min recalc fallback without drivers shows min delta', () => {
    const lines = formatPriceChangeGrounds({
      source: 'min_recalc',
      minPriceBefore: 3147,
      minPriceAfter: 3145,
    });
    expect(lines[0]).toMatch(/3147/);
    expect(lines[0]).toMatch(/3145/);
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
