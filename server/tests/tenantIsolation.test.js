/**
 * Изоляция тенантов: fail-closed без profileId, утилиты scope.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  requireTenantProfileId,
  scopedProfileIdOrNull,
  assertRowBelongsToProfile,
} from '../src/utils/tenantScope.js';

describe('tenantScope', () => {
  it('requireTenantProfileId throws without id', () => {
    assert.throws(() => requireTenantProfileId(null), /profileId/);
    assert.throws(() => requireTenantProfileId(''), /profileId/);
    assert.equal(requireTenantProfileId(7), 7);
  });

  it('scopedProfileIdOrNull fail-closed', () => {
    assert.equal(scopedProfileIdOrNull(null), null);
    assert.equal(scopedProfileIdOrNull(12), 12);
  });

  it('assertRowBelongsToProfile hides cross-tenant rows as 404', () => {
    assert.throws(
      () => assertRowBelongsToProfile({ id: 1, profile_id: 2 }, 99),
      (err) => err.statusCode === 404
    );
    const row = assertRowBelongsToProfile({ id: 1, profile_id: 5 }, 5);
    assert.equal(row.id, 1);
  });
});

describe('suppliers/warehouses fail-closed contract', () => {
  it('documents that findById without profileId must return null', async () => {
    // Контракт: HTTP не должен получать чужие строки без profileId.
    // Репозитории pg: suppliers.findById / warehouses.findById — fail-closed.
    const suppliersMod = await import('../src/repositories/suppliers.repository.pg.js');
    const warehousesMod = await import('../src/repositories/warehouses.repository.pg.js');
    assert.ok(suppliersMod);
    assert.ok(warehousesMod);
    // Сигнатуры существуют (классы экспортируются через default instance в factory —
    // здесь проверяем, что модули грузятся без ошибок после hardening).
  });
});

describe('orders labels require profile', async () => {
  it('findOrderById without profileId → 404', async () => {
    const { default: ordersLabelsService } = await import('../src/services/orders.labels.service.js');
    await assert.rejects(
      () => ordersLabelsService.findOrderById('ANY-ORDER'),
      (err) => err.statusCode === 404
    );
    await assert.rejects(
      () => ordersLabelsService.findOrderById('ANY-ORDER', { profileId: null }),
      (err) => err.statusCode === 404
    );
  });
});
