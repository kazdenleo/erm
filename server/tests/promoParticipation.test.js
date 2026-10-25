import { joinBlockMessage, ozonEntryPrice, promoJoinDecision } from '../src/utils/promoParticipation.js';

describe('promoJoinDecision', () => {
  test('allows entry at or above the floor', () => {
    expect(promoJoinDecision({ entryPrice: 1500, floor: 1500 }).ok).toBe(true);
    expect(promoJoinDecision({ entryPrice: 1600, floor: 1500 }).ok).toBe(true);
  });

  test('blocks entry below the floor', () => {
    const decision = promoJoinDecision({ entryPrice: 1000, floor: 1500 });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('below_floor');
    expect(joinBlockMessage(decision.reason)).toMatch(/ниже минимальной/);
  });

  test('blocks entry when the floor is unknown', () => {
    expect(promoJoinDecision({ entryPrice: 1000, floor: null }).reason).toBe('no_floor');
  });

  test('ozon entry price prefers the current action price', () => {
    expect(ozonEntryPrice({ action_price: 900, alert_max_action_price: 800 })).toBe(900);
    expect(ozonEntryPrice({ action_price: 0, max_action_price: 700 })).toBe(700);
  });
});
