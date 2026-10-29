import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLearnedOzonFbsLogistics,
  enrichOzonCalculatorWithLearnedLogistics,
  volumeBucketKey,
} from '../src/utils/ozonLogisticsLearning.js';

test('volumeBucketKey rounds to half-liters', () => {
  assert.equal(volumeBucketKey(4.694), '4.5');
  assert.equal(volumeBucketKey(2.07), '2.0');
  assert.equal(volumeBucketKey(0.2), '0.5');
  assert.equal(volumeBucketKey(null), null);
});

test('applyLearnedOzonFbsLogistics raises direct flow so total matches median', () => {
  const calc = {
    logistics_cost: 89,
    commissions: {
      FBS: {
        percent: 47,
        delivery_amount: 25,
        direct_flow_trans_amount: 89,
        direct_flow_trans_amount_max: 442,
      },
    },
  };
  const out = applyLearnedOzonFbsLogistics(calc, 147.52, { n: 26, source: 'fbs_reports_product' });
  assert.equal(out.logistics_cost_api, 89);
  assert.equal(out.logistics_cost, 122.52);
  assert.equal(out.commissions.FBS.direct_flow_trans_amount, 122.52);
  assert.equal(out.commissions.FBS.delivery_amount, 25);
  assert.equal(out.commissions.FBS.direct_flow_trans_amount_max, 442);
  assert.deepEqual(out.logistics_learned, {
    total: 147.52,
    n: 26,
    source: 'fbs_reports_product',
  });
  // original not mutated
  assert.equal(calc.logistics_cost, 89);
});

test('applyLearnedOzonFbsLogistics does not lower below API min', () => {
  const calc = {
    logistics_cost: 89,
    commissions: { FBS: { delivery_amount: 25, direct_flow_trans_amount: 89 } },
  };
  const out = applyLearnedOzonFbsLogistics(calc, 100, { n: 3 });
  assert.equal(out.logistics_cost, 89);
  assert.equal(out.logistics_learned.total, 100);
});

test('enrichOzonCalculatorWithLearnedLogistics prefers product over volume bucket', () => {
  const calc = {
    logistics_cost: 89,
    volume_weight: 4.7,
    commissions: { FBS: { delivery_amount: 25, direct_flow_trans_amount: 89 } },
  };
  const learned = {
    byProductId: new Map([['51', { median: 147.52, n: 26 }]]),
    byVolumeBucket: new Map([['4.5', { median: 155, n: 40 }]]),
  };
  const out = enrichOzonCalculatorWithLearnedLogistics(calc, learned, { productId: 51 });
  assert.equal(out.logistics_cost, 122.52);
  assert.equal(out.logistics_learned.source, 'fbs_reports_product');
});

test('enrichOzonCalculatorWithLearnedLogistics falls back to volume bucket', () => {
  const calc = {
    logistics_cost: 75,
    volume_weight: 2.07,
    commissions: { FBS: { delivery_amount: 25, direct_flow_trans_amount: 75 } },
  };
  const learned = {
    byProductId: new Map(),
    byVolumeBucket: new Map([['2.0', { median: 113.64, n: 20 }]]),
  };
  const out = enrichOzonCalculatorWithLearnedLogistics(calc, learned, { productId: 999 });
  assert.equal(out.logistics_cost, 88.64);
  assert.equal(out.logistics_learned.source, 'fbs_reports_volume');
  assert.equal(out.logistics_learned.volumeBucket, '2.0');
});
