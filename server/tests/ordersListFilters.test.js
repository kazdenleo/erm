import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applySalesSchemeSql } from '../src/utils/orderListSchemeSql.js';

describe('order list sales-scheme SQL', () => {
  it('FBS scheme keeps unmarked rows and explicit fbs', () => {
    const { whereSql, params } = applySalesSchemeSql(' WHERE 1=1', [], 1, { salesScheme: 'fbs' });
    assert.match(whereSql, /sales_scheme IS NULL OR LOWER\(TRIM\(o\.sales_scheme\)\) = 'fbs'/);
    assert.deepEqual(params, []);
  });

  it('excludeSalesSchemes hides DBS/C&C from the FBS pipeline', () => {
    const { whereSql, params } = applySalesSchemeSql(' WHERE 1=1', [], 1, {
      excludeSalesSchemes: ['dbs', 'cnc'],
    });
    assert.match(whereSql, /sales_scheme IS NULL OR LOWER\(TRIM\(o\.sales_scheme\)\) <> ALL/);
    assert.deepEqual(params[0], ['dbs', 'cnc']);
  });

  it('specific scheme filters the exact value', () => {
    const { whereSql, params } = applySalesSchemeSql(' WHERE 1=1', [], 1, { salesScheme: 'dbs' });
    assert.match(whereSql, /LOWER\(TRIM\(COALESCE\(o\.sales_scheme, ''\)\)\) =/);
    assert.deepEqual(params, ['dbs']);
  });

  it('salesScheme=all does not add a scheme predicate', () => {
    const { whereSql } = applySalesSchemeSql(' WHERE 1=1', [], 1, { salesScheme: 'all' });
    assert.equal(/sales_scheme/.test(whereSql), false);
  });
});
