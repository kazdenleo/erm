import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pivotForecastByCluster,
  calcClusterToSupply,
  scaleOrdersForPlan,
  applyZeroStockBoost,
  calcAvgOrdersPerDay,
  resolveOrdersPeriod,
} from '../src/services/fboSupplyForecast.service.js';

test('calcClusterToSupply: need minus on-hand plus reserve', () => {
  assert.equal(
    calcClusterToSupply({ availability: 10, orders: 20, reserve: 3, returnQty: 2 }),
    11
  );
  assert.equal(
    calcClusterToSupply({ availability: 50, orders: 10, reserve: 0, returnQty: 0 }),
    0
  );
});

test('scaleOrdersForPlan extrapolates to planning period', () => {
  assert.equal(scaleOrdersForPlan(30, 60, 30), 60);
  assert.equal(scaleOrdersForPlan(10, 30, 30), 10);
});

test('applyZeroStockBoost adds percent when availability is zero', () => {
  assert.equal(applyZeroStockBoost(10, 0, 20), 12);
  assert.equal(applyZeroStockBoost(10, 5, 20), 10);
});

test('calcClusterToSupply applies zero-stock boost', () => {
  assert.equal(
    calcClusterToSupply({
      availability: 0,
      orders: 10,
      reserve: 0,
      returnQty: 0,
      zeroStockBoostPercent: 50,
    }),
    15
  );
});

test('calcAvgOrdersPerDay divides orders by period days', () => {
  assert.equal(calcAvgOrdersPerDay(30, 30), 1);
  assert.equal(calcAvgOrdersPerDay(10, 7), 1.43);
});

test('resolveOrdersPeriod accepts custom date range', () => {
  const p = resolveOrdersPeriod({ ordersStart: '2026-06-01', ordersEnd: '2026-06-07' });
  assert.equal(p.start, '2026-06-01');
  assert.equal(p.end, '2026-06-07');
  assert.equal(p.days, 7);
});

test('pivotForecastByCluster aggregates warehouses into regions', () => {
  const flat = [
    {
      id: 1,
      nmId: 100,
      chrtId: 1,
      externalSku: '100:1',
      warehouseId: 10,
      regionName: 'Центральный',
      quantity: 5,
      inWayToClient: 2,
      inWayFromClient: 1,
      wbVendorCode: 'sku-a',
      productId: 1,
      productName: 'A',
      productArticle: 'ART-A',
    },
    {
      id: 2,
      nmId: 100,
      chrtId: 1,
      externalSku: '100:1',
      warehouseId: 11,
      regionName: 'Центральный',
      quantity: 3,
      inWayToClient: 1,
      inWayFromClient: 0,
      wbVendorCode: 'sku-a',
      productId: 1,
      productName: 'A',
      productArticle: 'ART-A',
    },
    {
      id: 3,
      nmId: 100,
      chrtId: 1,
      externalSku: '100:1',
      warehouseId: 20,
      regionName: 'Южный',
      quantity: 4,
      inWayToClient: 0,
      inWayFromClient: 2,
      wbVendorCode: 'sku-a',
      productId: 1,
      productName: 'A',
      productArticle: 'ART-A',
    },
  ];

  const wbByNm = new Map([['100', 30]]);
  const erm = { byNm: new Map(), byNmWh: new Map(), byProduct: new Map(), byOffer: new Map() };

  const { rows, clusters } = pivotForecastByCluster(flat, { wbByNm, erm });
  assert.equal(rows.length, 1);
  assert.deepEqual(clusters.map((c) => c.name), ['Центральный', 'Южный']);

  const m = rows[0].clusterMetrics;
  assert.equal(m['Центральный'].availability, 8);
  assert.equal(m['Центральный'].reserve, 3);
  assert.equal(m['Центральный'].return, 1);
  assert.equal(m['Южный'].availability, 4);
  assert.equal(m['Южный'].return, 2);
  assert.ok(m['Центральный'].orders > 0);
  assert.ok(m['Южный'].orders > 0);
  assert.equal(m['Центральный'].avgOrdersPerDay, calcAvgOrdersPerDay(m['Центральный'].orders, 30));
});

test('pivotForecastByCluster filters by cluster', () => {
  const flat = [
    {
      id: 1,
      nmId: 1,
      chrtId: 1,
      externalSku: '1:1',
      warehouseId: 1,
      regionName: 'Центральный',
      quantity: 1,
      inWayToClient: 0,
      inWayFromClient: 0,
      wbVendorCode: 'x',
      productId: null,
      productName: null,
      productArticle: null,
    },
    {
      id: 2,
      nmId: 2,
      chrtId: 1,
      externalSku: '2:1',
      warehouseId: 2,
      regionName: 'Южный',
      quantity: 2,
      inWayToClient: 0,
      inWayFromClient: 0,
      wbVendorCode: 'y',
      productId: null,
      productName: null,
      productArticle: null,
    },
  ];
  const wbByNm = new Map();
  const erm = { byNm: new Map(), byNmWh: new Map(), byProduct: new Map(), byOffer: new Map() };
  const { rows, clusters } = pivotForecastByCluster(flat, {
    wbByNm,
    erm,
    clusterFilter: 'Центральный',
  });
  assert.equal(rows.length, 1);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].name, 'Центральный');
});
