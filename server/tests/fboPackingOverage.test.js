/**
 * Контракт: лишний скан в сборке FBO не пишется без allowOverage.
 */
describe('fbo packing overage gate', () => {
  function shouldAskOverageConfirm({ packed, planned, allowOverage }) {
    if (allowOverage) return false;
    const p = Math.max(0, Number(packed) || 0);
    const plan = Math.max(0, Number(planned) || 0);
    return p >= plan;
  }

  test('asks when packed already equals planned', () => {
    expect(shouldAskOverageConfirm({ packed: 5, planned: 5, allowOverage: false })).toBe(true);
  });

  test('asks when packed already exceeds planned', () => {
    expect(shouldAskOverageConfirm({ packed: 6, planned: 5, allowOverage: false })).toBe(true);
  });

  test('does not ask while under plan', () => {
    expect(shouldAskOverageConfirm({ packed: 4, planned: 5, allowOverage: false })).toBe(false);
  });

  test('allowOverage skips confirm', () => {
    expect(shouldAskOverageConfirm({ packed: 5, planned: 5, allowOverage: true })).toBe(false);
  });
});
