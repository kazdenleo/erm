import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDrrPercent,
  normalizeAdsPercent,
  applyAdsPromotion,
  adsScopeKey,
  normalizeMarketplace,
} from '../src/utils/adsDrr.js';

test('normalizeAdsPercent accepts fraction and percent', () => {
  assert.equal(normalizeAdsPercent(0.08), 8);
  assert.equal(normalizeAdsPercent(8), 8);
  assert.equal(normalizeAdsPercent('2,5'), 2.5);
});

test('computeDrrPercent', () => {
  assert.equal(computeDrrPercent(100, 1000), 10);
  assert.equal(computeDrrPercent(0, 1000), 0);
  assert.equal(computeDrrPercent(100, 100), null); // below minRevenue
});

test('applyAdsPromotion', () => {
  const out = applyAdsPromotion({}, 7.5, 'ads');
  assert.equal(out.ads_promotion_percent, 7.5);
  assert.equal(out.ads_promotion_source, 'ads');
});

test('adsScopeKey and marketplace', () => {
  assert.equal(adsScopeKey(1, 2), '1:2');
  assert.equal(normalizeMarketplace('wb'), 'wildberries');
  assert.equal(normalizeMarketplace('ym'), 'yandex');
  assert.equal(normalizeMarketplace('ozon'), 'ozon');
});
