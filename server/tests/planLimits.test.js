import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSubscriptionPlan } from '../src/constants/subscriptionPlans.js';

describe('subscription plan limits shape', () => {
  it('start has finite caps', () => {
    const p = getSubscriptionPlan('start');
    assert.equal(p.maxUsers, 2);
    assert.equal(p.maxOrganizations, 1);
    assert.equal(p.maxMpCabinets, 3);
    assert.equal(p.maxProducts, 500);
  });

  it('pro products unlimited', () => {
    const p = getSubscriptionPlan('pro');
    assert.equal(p.maxProducts, null);
  });
});
