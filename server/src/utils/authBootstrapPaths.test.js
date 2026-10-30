import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthBootstrapRequest } from './authBootstrapPaths.js';

function mockReq(method, originalUrl) {
  return { method, originalUrl };
}

test('isAuthBootstrapRequest: login, me, register, password reset', () => {
  assert.equal(isAuthBootstrapRequest(mockReq('POST', '/api/auth/login')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('POST', '/auth/login')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('GET', '/api/auth/me')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('GET', '/auth/me')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('POST', '/api/auth/register-account')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('POST', '/api/auth/forgot-password')), true);
  assert.equal(isAuthBootstrapRequest(mockReq('POST', '/api/auth/reset-password')), true);
});

test('isAuthBootstrapRequest: other routes', () => {
  assert.equal(isAuthBootstrapRequest(mockReq('GET', '/api/organizations')), false);
  assert.equal(isAuthBootstrapRequest(mockReq('GET', '/api/auth/me/extra')), false);
});
