import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWbSupplyWarehouseFields,
  normalizeWbSupplyClusterLabel,
  resolveWbPlacementCluster,
} from '../src/services/fboSuppliesImport.service.js';

test('resolveWbSupplyWarehouseFields uses supply details warehouseName', () => {
  const listRow = {
    supplyID: 39658634,
    preorderID: 51895542,
    statusID: 4,
  };
  const details = {
    warehouseID: 300862,
    warehouseName: 'СЦ Абакан 2',
    actualWarehouseID: 300862,
    actualWarehouseName: 'СЦ Абакан 2',
  };
  const fields = resolveWbSupplyWarehouseFields(listRow, details);
  assert.equal(fields.marketplaceWarehouseName, 'СЦ Абакан 2');
  assert.equal(fields.marketplaceWarehouseId, '300862');
  assert.equal(fields.shippingCluster, 'Абакан 2');
});

test('resolveWbSupplyWarehouseFields falls back when details missing', () => {
  const fields = resolveWbSupplyWarehouseFields(
    { warehouseName: 'Коледино', warehouseID: 507 },
    null
  );
  assert.equal(fields.marketplaceWarehouseName, 'Коледино');
  assert.equal(fields.shippingCluster, 'Коледино');
});

test('normalizeWbSupplyClusterLabel strips sorting center prefix', () => {
  assert.equal(normalizeWbSupplyClusterLabel('СЦ Абакан 2'), 'Абакан 2');
  assert.equal(normalizeWbSupplyClusterLabel('Новосемейкино'), 'Новосемейкино');
});

test('resolveWbPlacementCluster reads warehouse fields', () => {
  assert.equal(resolveWbPlacementCluster({ warehouseName: 'СЦ Абакан 2' }), 'СЦ Абакан 2');
});
