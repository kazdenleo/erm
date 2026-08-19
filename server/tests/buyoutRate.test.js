import {
  computeBuyoutPercent,
  resolveMarketplaceBuyoutRate,
} from '../src/utils/marketplaceBuyoutRate.js';

describe('marketplaceBuyoutRate', () => {
  test('computeBuyoutPercent needs min sample', () => {
    expect(computeBuyoutPercent(1, 0, 3)).toBeNull();
    expect(computeBuyoutPercent(2, 1, 3)).toBe(67);
    expect(computeBuyoutPercent(97, 3, 3)).toBe(97);
  });

  test('resolveMarketplaceBuyoutRate prefers per-mp', () => {
    const p = { buyout_rate: 95, buyout_rate_ozon: 80, buyout_rate_wb: 90 };
    expect(resolveMarketplaceBuyoutRate(p, 'ozon')).toBe(80);
    expect(resolveMarketplaceBuyoutRate(p, 'wb')).toBe(90);
    expect(resolveMarketplaceBuyoutRate(p, 'ym')).toBe(95);
  });

  test('weighted fbs+fbo sample', () => {
    expect(computeBuyoutPercent(10 + 20, 2 + 3, 3)).toBe(86);
  });
});
