import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSalesScheme,
  detectSalesSchemeFromOrderPayload,
  getWorkingSchemeKeys,
  getMpCommissionKeysForWorkingSchemes,
  schemesExcludedFromFbsPipeline,
  describeWorkingSchemes,
} from '../src/constants/marketplaceSalesSchemes.js';

describe('marketplaceSalesSchemes', () => {
  it('normalizes common aliases', () => {
    assert.equal(normalizeSalesScheme('FBS'), 'fbs');
    assert.equal(normalizeSalesScheme('FBY'), 'fbo');
    assert.equal(normalizeSalesScheme('DBW'), 'dbs');
    assert.equal(normalizeSalesScheme('self_pickup'), 'cnc');
    assert.equal(normalizeSalesScheme('realFBS'), 'rfbs');
    assert.equal(normalizeSalesScheme('EXPRESS'), 'edbs');
  });

  it('detects WB deliveryType', () => {
    assert.equal(detectSalesSchemeFromOrderPayload('wb', { deliveryType: 'dbs' }), 'dbs');
    assert.equal(detectSalesSchemeFromOrderPayload('wb', { deliveryType: 'fbs' }), 'fbs');
  });

  it('defaults working keys to FBS only', () => {
    assert.deepEqual(getWorkingSchemeKeys({}), ['fbs']);
    assert.deepEqual(getWorkingSchemeKeys({ fbs: true, fbo: true, dbs: true }), [
      'fbs',
      'fbo',
      'dbs',
    ]);
  });

  it('maps WB commission keys for enabled schemes', () => {
    assert.deepEqual(
      getMpCommissionKeysForWorkingSchemes('wb', { fbs: true, dbs: true, cnc: true }),
      ['kgvpMarketplace', 'kgvpSupplier', 'kgvpPickup']
    );
  });

  it('excludes from FBS pipeline only when flags on', () => {
    assert.deepEqual(schemesExcludedFromFbsPipeline({}), []);
    assert.deepEqual(schemesExcludedFromFbsPipeline({ dbs: true, cnc: true }), ['dbs', 'cnc']);
  });

  it('describes working schemes', () => {
    const text = describeWorkingSchemes({ fbs: true, fbo: true, dbs: true });
    assert.match(text, /FBS/);
    assert.match(text, /FBO/);
    assert.match(text, /DBS/);
  });
});
