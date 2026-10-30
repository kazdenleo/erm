import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampFeatureFlagsToPlan } from '../src/utils/planLimits.js';
import { getSubscriptionPlan } from '../src/constants/subscriptionPlans.js';

describe('clampFeatureFlagsToPlan', () => {
  it('rejects fbo on start plan', () => {
    const plan = getSubscriptionPlan('start');
    const { rejected } = clampFeatureFlagsToPlan({ fbo_enabled: true, name: 'x' }, plan);
    assert.deepEqual(rejected, ['fbo_enabled']);
  });

  it('allows fbo on business', () => {
    const plan = getSubscriptionPlan('business');
    const { rejected, payload } = clampFeatureFlagsToPlan({ fbo_enabled: true }, plan);
    assert.equal(rejected.length, 0);
    assert.equal(payload.fbo_enabled, true);
  });

  it('allows turning fbo off on start', () => {
    const plan = getSubscriptionPlan('start');
    const { rejected, payload } = clampFeatureFlagsToPlan({ fbo_enabled: false }, plan);
    assert.equal(rejected.length, 0);
    assert.equal(payload.fbo_enabled, false);
  });
});
