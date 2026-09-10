import {
  formatPriceChangeGrounds,
  formatPriceChangeReason,
  formatMinRecalcReason,
  extractMinPriceDrivers,
  diffMinPriceDrivers,
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

  test('min recalc fallback without drivers has no redundant min delta', () => {
    const lines = formatPriceChangeGrounds({
      source: 'min_recalc',
      minPriceBefore: 3147,
      minPriceAfter: 3145,
    });
    expect(lines.length).toBe(0);
  });
});

describe('min recalc driver diff', () => {
  test('detects markup change from _inputs even if card still has old min_price', () => {
    const prev = extractMinPriceDrivers({
      commissions: { FBS: { percent: 23 } },
      _inputs: { minMarkup: 150, cost: 75, scheme: 'FBS' },
    }, { marketplace: 'ozon', scheme: 'FBS' });
    const next = extractMinPriceDrivers({
      commissions: { FBS: { percent: 23 } },
      _inputs: { minMarkup: 40, cost: 75, scheme: 'FBS' },
    }, { marketplace: 'ozon', scheme: 'FBS', minMarkup: 40, cost: 75 });
    const changes = diffMinPriceDrivers(prev, next);
    expect(changes.some((c) => c.key === 'markup' && c.before === 150 && c.after === 40)).toBe(true);
    expect(formatMinRecalcReason(changes)).toMatch(/Мин\. наценка/);
    expect(formatMinRecalcReason(changes)).toMatch(/150/);
    expect(formatMinRecalcReason(changes)).toMatch(/40/);
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
