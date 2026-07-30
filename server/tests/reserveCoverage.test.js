import { describe, expect, test } from '@jest/globals';
import {
  classifyOrderReserveCoverage,
  coverageKindFromReserveMeta,
  resolveReserveSourceKind,
  scaleReserveMetaToDisplayQty,
  allocateUnreserveReserveFromMeta,
  onHandHeadroomBeforeReserve,
  computePromoteIncomingToOnHandQty,
  computePromoteOnHandBudget,
  orderStatusAllowsIncomingReserve,
  orderRowAllowsIncomingReserve,
  isKitComponentBatchReserve,
} from '../src/services/orders.service.js';

describe('isKitComponentBatchReserve', () => {
  test('пакетный резерв комплектующих', () => {
    expect(
      isKitComponentBatchReserve({
        kit_product_id: 352,
        kit_reserve_batch: true,
        kit_reserve_from_components: 1,
        kit_units: 1
      })
    ).toBe(true);
  });

  test('обычный резерв комплектующей без пакета', () => {
    expect(isKitComponentBatchReserve({ kit_product_id: 352 })).toBe(false);
  });
});

describe('orderStatusAllowsIncomingReserve', () => {
  test('новый заказ — наличие, затем путь', () => {
    expect(orderStatusAllowsIncomingReserve('new')).toBe(true);
    expect(orderStatusAllowsIncomingReserve('unknown')).toBe(false);
  });

  test('в закупке и на сборке — можно с пути', () => {
    expect(orderStatusAllowsIncomingReserve('in_procurement')).toBe(true);
    expect(orderStatusAllowsIncomingReserve('in_assembly')).toBe(true);
    expect(orderStatusAllowsIncomingReserve('wb_assembly')).toBe(true);
  });
});

describe('orderRowAllowsIncomingReserve', () => {
  test('ручной заказ в статусе new — можно с пути', () => {
    expect(orderRowAllowsIncomingReserve({ marketplace: 'manual', status: 'new' })).toBe(true);
  });

  test('ozon new — наличие, затем путь', () => {
    expect(orderRowAllowsIncomingReserve({ marketplace: 'ozon', status: 'new' })).toBe(true);
  });
});

describe('onHandHeadroomBeforeReserve', () => {
  test('headroom при частичном резерве', () => {
    expect(onHandHeadroomBeforeReserve({ onHand: 5, reservedRaw: 3 })).toBe(2);
  });
});

describe('computePromoteOnHandBudget', () => {
  test('весь on_hand свободен под promote, если нет активного meta со склада', () => {
    // available=0 (единица уже в резерве «с пути»), но физически on_hand=1
    expect(computePromoteOnHandBudget({ onHand: 1, claimedActiveOnHand: 0 })).toBe(1);
  });

  test('активный on_hand-резерв занимает бюджет', () => {
    expect(computePromoteOnHandBudget({ onHand: 2, claimedActiveOnHand: 1 })).toBe(1);
  });

  test('фантомный claimed больше on_hand не даёт отрицательный бюджет', () => {
    expect(computePromoteOnHandBudget({ onHand: 1, claimedActiveOnHand: 5 })).toBe(0);
  });

  test('без on_hand — 0', () => {
    expect(computePromoteOnHandBudget({ onHand: 0, claimedActiveOnHand: 0 })).toBe(0);
  });
});

describe('computePromoteIncomingToOnHandQty', () => {
  test('полный перевод при достаточном on_hand', () => {
    expect(
      computePromoteIncomingToOnHandQty({ metaIncoming: 2, reservedQty: 2, onHandBudget: 5 })
    ).toBe(2);
  });

  test('ограничение бюджетом после частичной приёмки', () => {
    expect(
      computePromoteIncomingToOnHandQty({ metaIncoming: 3, reservedQty: 3, onHandBudget: 1 })
    ).toBe(1);
  });

  test('без on_hand — 0 (до приёмки не зеленеет)', () => {
    expect(
      computePromoteIncomingToOnHandQty({ metaIncoming: 2, reservedQty: 2, onHandBudget: 0 })
    ).toBe(0);
  });

  test('после приёмки: on_hand покрывает резерв «с пути» даже при available=0', () => {
    const budget = computePromoteOnHandBudget({ onHand: 1, claimedActiveOnHand: 0 });
    expect(
      computePromoteIncomingToOnHandQty({ metaIncoming: 1, reservedQty: 1, onHandBudget: budget })
    ).toBe(1);
  });

  test('фантомный incoming при уже покрытом on_hand — не промоутим', () => {
    expect(
      computePromoteIncomingToOnHandQty({
        metaIncoming: 5,
        metaOnHand: 5,
        reservedQty: 5,
        onHandBudget: 5,
      })
    ).toBe(0);
  });
});

describe('coverageKindFromReserveMeta', () => {
  test('только со склада', () => {
    expect(coverageKindFromReserveMeta(2, 0)).toBe('on_hand');
  });

  test('только в пути', () => {
    expect(coverageKindFromReserveMeta(0, 2)).toBe('incoming');
  });

  test('смешанное — в пути', () => {
    expect(coverageKindFromReserveMeta(1, 1)).toBe('incoming');
  });

  test('нет meta — null', () => {
    expect(coverageKindFromReserveMeta(0, 0)).toBeNull();
  });
});

describe('resolveReserveSourceKind', () => {
  test('только с наличия', () => {
    expect(resolveReserveSourceKind(3, 0)).toBe('on_hand');
  });

  test('только в пути', () => {
    expect(resolveReserveSourceKind(0, 2)).toBe('incoming');
  });

  test('смешанный', () => {
    expect(resolveReserveSourceKind(1, 2)).toBe('mixed');
  });

  test('нет meta — null', () => {
    expect(resolveReserveSourceKind(0, 0)).toBeNull();
  });
});

describe('scaleReserveMetaToDisplayQty', () => {
  test('без урезания', () => {
    expect(scaleReserveMetaToDisplayQty({ fromOnHand: 2, fromIncoming: 1 }, 3)).toEqual({
      fromOnHand: 2,
      fromIncoming: 1,
      reserveSource: 'mixed',
    });
  });

  test('урезание сначала с в пути', () => {
    expect(scaleReserveMetaToDisplayQty({ fromOnHand: 2, fromIncoming: 3 }, 4)).toEqual({
      fromOnHand: 2,
      fromIncoming: 2,
      reserveSource: 'mixed',
    });
  });

  test('урезание до наличия', () => {
    expect(scaleReserveMetaToDisplayQty({ fromOnHand: 3, fromIncoming: 2 }, 2)).toEqual({
      fromOnHand: 2,
      fromIncoming: 0,
      reserveSource: 'on_hand',
    });
  });
});

describe('allocateUnreserveReserveFromMeta', () => {
  test('полное снятие с фантомным incoming', () => {
    expect(
      allocateUnreserveReserveFromMeta(5, { fromOnHand: 5, fromIncoming: 5 }, 5)
    ).toEqual({ reserve_from_on_hand: 5, reserve_from_incoming: 5 });
  });

  test('частичное: сначала в пути', () => {
    expect(
      allocateUnreserveReserveFromMeta(2, { fromOnHand: 2, fromIncoming: 3 }, 5)
    ).toEqual({ reserve_from_on_hand: 0, reserve_from_incoming: 2 });
  });

  test('частичное при фантоме: чистит excess + release', () => {
    expect(
      allocateUnreserveReserveFromMeta(2, { fromOnHand: 5, fromIncoming: 5 }, 5)
    ).toEqual({ reserve_from_on_hand: 2, reserve_from_incoming: 5 });
  });
});

describe('classifyOrderReserveCoverage', () => {
  test('полностью со склада', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 5, incoming: 0, reservedRaw: 1, orderReserved: 1 })
    ).toBe('on_hand');
  });

  test('со склада при нескольких резервах', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 2, incoming: 0, reservedRaw: 2, orderReserved: 1 })
    ).toBe('on_hand');
  });

  test('с пути, когда склада не хватает', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 0, incoming: 3, reservedRaw: 1, orderReserved: 1 })
    ).toBe('incoming');
  });

  test('смешанное покрытие — в пути', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 1, incoming: 2, reservedRaw: 2, orderReserved: 2 })
    ).toBe('incoming');
  });

  test('при нулевом incoming в снимке — всё равно в пути, если резерв есть', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 0, incoming: 0, reservedRaw: 1, orderReserved: 1 })
    ).toBe('incoming');
  });

  test('FIFO: incoming занят другими — резерв отображаем как в пути', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 0, incoming: 1, reservedRaw: 3, orderReserved: 2 })
    ).toBe('incoming');
  });

  test('нет свободного on_hand — резерв других занял наличие', () => {
    expect(
      classifyOrderReserveCoverage({ onHand: 1, incoming: 2, reservedRaw: 3, orderReserved: 1 })
    ).toBe('incoming');
  });
});

describe('resolveReserveCoverageKind', () => {
  test('собранный заказ с резервом — всегда on_hand, даже если meta «в пути»', async () => {
    const { resolveReserveCoverageKind } = await import('../src/services/orders.service.js');
    const metaMap = new Map([['100:5', 'incoming']]);
    const fifoMap = new Map([['100:5', 'incoming']]);
    expect(
      resolveReserveCoverageKind('100:5', {
        metaMap,
        fifoMap,
        orderStatus: 'assembled',
        pid: 5,
        reserved: 1,
      })
    ).toBe('on_hand');
  });

  test('meta «в пути» важнее FIFO on_hand (изолированные склады)', async () => {
    const { resolveReserveCoverageKind } = await import('../src/services/orders.service.js');
    const metaMap = new Map([['300:5', 'incoming']]);
    const fifoMap = new Map([['300:5', 'on_hand']]);
    expect(
      resolveReserveCoverageKind('300:5', {
        metaMap,
        fifoMap,
        orderStatus: 'new',
        pid: 5,
        reserved: 1,
      })
    ).toBe('incoming');
  });

  test('в закупке без meta: FIFO incoming — серая плашка', async () => {
    const { resolveReserveCoverageKind } = await import('../src/services/orders.service.js');
    const fifoMap = new Map([['200:5', 'incoming']]);
    expect(
      resolveReserveCoverageKind('200:5', {
        fifoMap,
        orderStatus: 'in_procurement',
        pid: 5,
        reserved: 1,
      })
    ).toBe('incoming');
  });
});

describe('isAssembledOrderReserveStatus', () => {
  test('assembled и wb_assembly', async () => {
    const { isAssembledOrderReserveStatus } = await import('../src/services/orders.service.js');
    expect(isAssembledOrderReserveStatus('assembled')).toBe(true);
    expect(isAssembledOrderReserveStatus('wb_assembly')).toBe(true);
    expect(isAssembledOrderReserveStatus('in_procurement')).toBe(false);
  });
});

describe('allocateCoverageKindFromPools (FIFO)', () => {
  test('сборка: общий резерв > остатка — ранние заказы всё равно on_hand', async () => {
    const { allocateCoverageKindFromPools } = await import('../src/services/orders.service.js');
    const pools = { onHand: 3, incoming: 0 };
    expect(allocateCoverageKindFromPools(1, pools)).toBe('on_hand');
    expect(allocateCoverageKindFromPools(1, pools)).toBe('on_hand');
    expect(allocateCoverageKindFromPools(1, pools)).toBe('on_hand');
    expect(allocateCoverageKindFromPools(1, pools)).toBe('incoming');
  });

  test('первые заказы забирают on_hand — зелёные, затем серый', async () => {
    const { allocateCoverageKindFromPools } = await import('../src/services/orders.service.js');
    const pools = { onHand: 3, incoming: 5 };
    expect(allocateCoverageKindFromPools(1, pools)).toBe('on_hand');
    expect(allocateCoverageKindFromPools(1, pools)).toBe('on_hand');
    expect(allocateCoverageKindFromPools(1, pools)).toBe('on_hand');
    expect(allocateCoverageKindFromPools(1, pools)).toBe('incoming');
    expect(pools.onHand).toBe(0);
    expect(pools.incoming).toBe(4);
  });
});
