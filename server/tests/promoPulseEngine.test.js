import {
  advancePhase,
  appendPhaseLog,
  daysInBOver30d,
  evaluateOffer,
  pickBestLevel,
} from '../src/services/promoPulse/engine.js';

const capsFull = { join: true, leave: true, setLevel: true, levels: true, percentOffJoin: true };

const policy = {
  phase_a_days: 14,
  phase_b_days: 7,
  max_b_share_30d: 0.333,
  require_profit_ge_markup: true,
  allow_below_floor_stock: false,
  new_product_base_days: 14,
};

const levels = [
  { boost: 15, price: 1100, profit_rub: 80, below_floor: false, current: true },
  { boost: 25, price: 1050, profit_rub: 40, below_floor: false },
  { boost: 40, price: 900, profit_rub: -10, below_floor: true, join_block_reason: 'below_floor' },
];

describe('promoPulse engine', () => {
  test('pickBestLevel берёт макс. бустинг над полом и наценкой', () => {
    const offer = { markup_rub: 50, levels };
    const best = pickBestLevel(offer, policy, 'normal');
    expect(best.boost).toBe(15);
  });

  test('сток может глубже пола при допуске', () => {
    const offer = {
      markup_rub: 50,
      levels: levels.map((l) => ({ ...l, profit_rub: 20 })),
    };
    const best = pickBestLevel(offer, { ...policy, allow_below_floor_stock: true, require_profit_ge_markup: false }, 'stock');
    expect(best.boost).toBe(40);
  });

  test('фаза A: выход из эластичного', () => {
    const decision = evaluateOffer({
      offer: {
        marketplace: 'ozon',
        action_id: '1',
        external_product_id: 10,
        our_product_id: 5,
        list_price: 1300,
        participating: true,
        can_leave: true,
        can_join: false,
        kind: 'elastic',
        levels,
        markup_rub: 50,
      },
      policy,
      phase: 'A',
      capabilities: capsFull,
    });
    expect(decision.type).toBe('leave');
    expect(decision.price).toBe(1300);
  });

  test('фаза B: set_level на лучший допустимый', () => {
    const offerLevels = [
      { boost: 15, price: 1200, profit_rub: 90, below_floor: false, current: true },
      { boost: 30, price: 1150, profit_rub: 70, below_floor: false },
    ];
    const decision = evaluateOffer({
      offer: {
        marketplace: 'ozon',
        action_id: '1',
        external_product_id: 10,
        our_product_id: 5,
        participating: true,
        can_leave: true,
        can_set_level: true,
        kind: 'elastic',
        levels: offerLevels,
        markup_rub: 50,
      },
      policy,
      phase: 'B',
      capabilities: capsFull,
    });
    expect(decision.type).toBe('set_level');
    expect(decision.level).toBe(30);
    expect(decision.price).toBe(1150);
  });

  test('advancePhase A→B→C→A', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const afterA = advancePhase({
      phase: 'A',
      phaseStartedAt: t0.toISOString(),
      now: new Date('2026-01-20T00:00:00Z'),
      phaseADays: 14,
      phaseBDays: 7,
      phaseCDays: 1,
    });
    expect(afterA.phase).toBe('B');
    const afterB = advancePhase({
      phase: 'B',
      phaseStartedAt: afterA.phase_started_at,
      now: new Date('2026-01-28T00:00:00Z'),
      phaseADays: 14,
      phaseBDays: 7,
      phaseCDays: 1,
    });
    expect(afterB.phase).toBe('C');
    const stillC = advancePhase({
      phase: 'C',
      phaseStartedAt: afterB.phase_started_at,
      now: new Date('2026-01-28T12:00:00Z'),
      phaseADays: 14,
      phaseBDays: 7,
      phaseCDays: 1,
    });
    expect(stillC.phase).toBe('C');
    const afterC = advancePhase({
      phase: 'C',
      phaseStartedAt: afterB.phase_started_at,
      now: new Date('2026-01-29T00:00:00Z'),
      phaseADays: 14,
      phaseBDays: 7,
      phaseCDays: 1,
    });
    expect(afterC.phase).toBe('A');
  });

  test('фаза C: leave', () => {
    const decision = evaluateOffer({
      offer: {
        marketplace: 'ozon',
        action_id: '1',
        external_product_id: 10,
        our_product_id: 5,
        list_price: 1300,
        participating: true,
        can_leave: true,
        kind: 'elastic',
        levels,
        markup_rub: 50,
      },
      policy,
      phase: 'C',
      capabilities: capsFull,
    });
    expect(decision.type).toBe('leave');
  });

  test('WB без leave: фаза C → skip', () => {
    const capsWb = { join: true, leave: false, setLevel: false, levels: false, percentOffJoin: true };
    const decision = evaluateOffer({
      offer: {
        marketplace: 'wb',
        action_id: '99',
        external_product_id: 111,
        our_product_id: 5,
        entry_price: 900,
        list_price: 1200,
        floor: 800,
        markup_rub: 50,
        profit_rub: 80,
        participating: true,
        can_leave: false,
        can_join: false,
        kind: 'percent_off',
      },
      policy,
      phase: 'C',
      capabilities: capsWb,
    });
    expect(decision.type).toBe('skip');
  });

  test('фаза B: join %-акции без уровней', () => {
    const capsYm = { join: true, leave: true, setLevel: false, levels: false, percentOffJoin: true };
    const decision = evaluateOffer({
      offer: {
        marketplace: 'ym',
        action_id: 'p1',
        external_product_id: 'SKU-1',
        our_product_id: 5,
        entry_price: 950,
        floor: 800,
        markup_rub: 40,
        profit_rub: 70,
        participating: false,
        can_join: true,
        can_leave: false,
        kind: 'percent_off',
      },
      policy,
      phase: 'B',
      capabilities: capsYm,
    });
    expect(decision.type).toBe('join');
    expect(decision.price).toBe(950);
  });

  test('доля B режет normal в C, hero остаётся в B', () => {
    const offer = {
      marketplace: 'ozon',
      action_id: '1',
      external_product_id: 10,
      our_product_id: 5,
      participating: true,
      can_leave: true,
      can_set_level: true,
      kind: 'elastic',
      levels: [
        { boost: 20, price: 1100, profit_rub: 80, below_floor: false, current: true },
      ],
      markup_rub: 50,
      list_price: 1300,
    };
    const cut = evaluateOffer({
      offer,
      policy: { ...policy, max_b_share_30d: 0.2 },
      segment: 'normal',
      phase: 'B',
      capabilities: capsFull,
      daysInB30d: 10,
    });
    expect(cut.type).toBe('leave');
    expect(cut.phase).toBe('C');

    const hero = evaluateOffer({
      offer,
      policy: { ...policy, max_b_share_30d: 0.2 },
      segment: 'hero',
      phase: 'B',
      capabilities: capsFull,
      daysInB30d: 10,
    });
    expect(hero.type).toBe('skip');
    expect(hero.phase).toBe('B');
  });

  test('daysInBOver30d считает журнал и открытую B', () => {
    const now = new Date('2026-02-01T00:00:00Z');
    const days = daysInBOver30d({
      now,
      states: [
        {
          phase: 'B',
          phase_started_at: '2026-01-28T00:00:00Z',
          phase_log: [
            { phase: 'B', start: '2026-01-10T00:00:00Z', end: '2026-01-15T00:00:00Z' },
          ],
        },
      ],
    });
    expect(days).toBeCloseTo(9, 5); // 5 закрытых + 4 открытых
  });

  test('appendPhaseLog закрывает B', () => {
    const log = appendPhaseLog([], {
      fromPhase: 'B',
      fromStartedAt: '2026-01-01T00:00:00Z',
      toPhase: 'C',
      at: new Date('2026-01-05T00:00:00Z'),
    });
    expect(log).toHaveLength(1);
    expect(log[0].phase).toBe('B');
    expect(log[0].end).toBe('2026-01-05T00:00:00.000Z');
  });
});
