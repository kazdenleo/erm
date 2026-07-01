import { describe, expect, test } from '@jest/globals';
import {
  classifyOrderReserveCoverage,
  coverageKindFromReserveMeta,
  resolveReserveSourceKind,
  scaleReserveMetaToDisplayQty,
  onHandHeadroomBeforeReserve,
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
  test('новый заказ — только со склада', () => {
    expect(orderStatusAllowsIncomingReserve('new')).toBe(false);
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

  test('ozon new — только со склада', () => {
    expect(orderRowAllowsIncomingReserve({ marketplace: 'ozon', status: 'new' })).toBe(false);
  });
});

describe('onHandHeadroomBeforeReserve', () => {
  test('headroom при частичном резерве', () => {
    expect(onHandHeadroomBeforeReserve({ onHand: 5, reservedRaw: 3 })).toBe(2);
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
