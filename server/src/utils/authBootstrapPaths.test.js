import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthBootstrapRequest } from './authBootstrapPaths.js';

function mockReq(method, originalUrl) {
  return { method, originalUrl };
}

test('isAuthBootstrapRequest: login, me, register', () => {
  assert.equal(isAuthBootstrapRequest(mockReq('POST', '/api/auth/login')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('POST', '/auth/login')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('GET', '/api/auth/me')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('GET', '/auth/me')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('POST', '/api/auth/register-account')), true);
});

test('isAuthBootstrapRequest: other routes', () => {
  assert.equal(isAuthBootstrapRequest(mockReq('GET', '/api/organizations')), false);
  assert.equal(isAuthBootstrapRequest(mockReq('GET', '/api/auth/me/extra')), false);
});
