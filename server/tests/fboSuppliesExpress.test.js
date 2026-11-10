/**
 * Контракты экспресс-режима FBO (принять + собрать + упаковать).
 */

describe('fbo express scan gates', () => {
  function needsCargoFirst({ activeCargoUnitId, isExistingCargo, scanMode }) {
    if (isExistingCargo || scanMode === 'cargo') return false;
    const activeId = activeCargoUnitId != null ? Number(activeCargoUnitId) : null;
    return !(Number.isFinite(activeId) && activeId > 0);
  }

  function rejectKitComponent(match) {
    return match === 'kit_component';
  }

  function shouldReceiveIncoming({
    deductStock,
    collected,
    reservedFromStock,
    allowReceive = true,
  }) {
    if (!deductStock) return false;
    if (!allowReceive) return false;
    return collected + 1 > Math.max(0, Number(reservedFromStock) || 0);
  }

  function packingOverageGate({ packed, planned, allowOverage }) {
    if (allowOverage) return false;
    return Math.max(0, Number(packed) || 0) >= Math.max(0, Number(planned) || 0);
  }

  test('requires cargo before product when no active GM', () => {
    expect(
      needsCargoFirst({ activeCargoUnitId: null, isExistingCargo: false, scanMode: 'product' })
    ).toBe(true);
  });

  test('allows product when active cargo set', () => {
    expect(
      needsCargoFirst({ activeCargoUnitId: 12, isExistingCargo: false, scanMode: 'product' })
    ).toBe(false);
  });

  test('cargo barcode does not require prior active', () => {
    expect(
      needsCargoFirst({ activeCargoUnitId: null, isExistingCargo: true, scanMode: 'product' })
    ).toBe(false);
  });

  test('with active GM, product barcode wins over same cargo barcode', () => {
    function preferProductOverCargo({ hasActiveCargo, isExistingCargo, isSupplyProduct, wantCargo }) {
      if (wantCargo) return 'cargo';
      if (isExistingCargo && !hasActiveCargo) return 'cargo';
      if (isSupplyProduct && hasActiveCargo) return 'product';
      if (isExistingCargo) return 'cargo';
      return 'product';
    }
    expect(
      preferProductOverCargo({
        hasActiveCargo: true,
        isExistingCargo: true,
        isSupplyProduct: true,
        wantCargo: false,
      })
    ).toBe('product');
    expect(
      preferProductOverCargo({
        hasActiveCargo: true,
        isExistingCargo: true,
        isSupplyProduct: false,
        wantCargo: false,
      })
    ).toBe('cargo');
    expect(
      preferProductOverCargo({
        hasActiveCargo: false,
        isExistingCargo: true,
        isSupplyProduct: true,
        wantCargo: false,
      })
    ).toBe('cargo');
  });

  test('rejects kit component match', () => {
    expect(rejectKitComponent('kit_component')).toBe(true);
    expect(rejectKitComponent('direct')).toBe(false);
    expect(rejectKitComponent('product')).toBe(false);
  });

  test('receives when next collect exceeds on-hand reserve', () => {
    expect(
      shouldReceiveIncoming({
        deductStock: true,
        collected: 2,
        reservedFromStock: 2,
      })
    ).toBe(true);
  });

  test('skips receive when on-hand reserve covers next unit', () => {
    expect(
      shouldReceiveIncoming({
        deductStock: true,
        collected: 1,
        reservedFromStock: 5,
      })
    ).toBe(false);
  });

  test('skips receive when deduct_stock off', () => {
    expect(
      shouldReceiveIncoming({
        deductStock: false,
        collected: 0,
        reservedFromStock: 0,
      })
    ).toBe(false);
  });

  test('packing overage before mutate', () => {
    expect(packingOverageGate({ packed: 5, planned: 5, allowOverage: false })).toBe(true);
    expect(packingOverageGate({ packed: 4, planned: 5, allowOverage: false })).toBe(false);
    expect(packingOverageGate({ packed: 5, planned: 5, allowOverage: true })).toBe(false);
  });
});

describe('fbo express FIFO purchase pick', () => {
  function pickFifoPurchase(rows) {
    const open = (rows || [])
      .filter(
        (r) =>
          r.status === 'open' &&
          Number(r.expected) > Number(r.received || 0) &&
          Number(r.warehouseId) > 0
      )
      .sort((a, b) => Number(a.id) - Number(b.id));
    return open[0] || null;
  }

  test('picks oldest open purchase with pending qty on warehouse', () => {
    const pick = pickFifoPurchase([
      { id: 20, status: 'open', warehouseId: 6, expected: 10, received: 10 },
      { id: 10, status: 'open', warehouseId: 6, expected: 5, received: 2 },
      { id: 15, status: 'open', warehouseId: 6, expected: 3, received: 0 },
      { id: 5, status: 'archived', warehouseId: 6, expected: 9, received: 0 },
    ]);
    expect(pick?.id).toBe(10);
  });

  test('returns null when nothing pending', () => {
    expect(
      pickFifoPurchase([{ id: 1, status: 'open', warehouseId: 6, expected: 2, received: 2 }])
    ).toBeNull();
  });
});
