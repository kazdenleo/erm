import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptSecret,
  decryptSecret,
  encryptConfigSecrets,
  decryptConfigSecrets,
  maskConfigSecrets,
  mergeConfigSecrets,
  prepareConfigForStorage,
  isEncryptedSecret,
  isMaskedSecret,
  resetSecretsCryptoCache,
} from '../src/utils/secretsCrypto.js';

describe('secretsCrypto', () => {
  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64);
    resetSecretsCryptoCache();
  });

  it('encrypt/decrypt roundtrip', () => {
    const enc = encryptSecret('super-secret-key-12345');
    assert.equal(isEncryptedSecret(enc), true);
    assert.equal(decryptSecret(enc), 'super-secret-key-12345');
  });

  it('encrypt is idempotent', () => {
    const enc = encryptSecret('abc');
    assert.equal(encryptSecret(enc), enc);
  });

  it('encryptConfigSecrets / decryptConfigSecrets', () => {
    const cfg = { api_key: 'ozon-key-zzzz', client_id: '123', spp_percent: 5 };
    const enc = encryptConfigSecrets(cfg);
    assert.equal(isEncryptedSecret(enc.api_key), true);
    assert.equal(enc.client_id, '123');
    const plain = decryptConfigSecrets(enc);
    assert.equal(plain.api_key, 'ozon-key-zzzz');
    assert.equal(plain.spp_percent, 5);
  });

  it('mask shows last 4', () => {
    const masked = maskConfigSecrets({ api_key: 'abcdefghij' });
    assert.equal(masked.api_key, '••••••••ghij');
    assert.equal(isMaskedSecret(masked.api_key), true);
  });

  it('merge keeps previous when masked', () => {
    const prev = encryptConfigSecrets({ api_key: 'real-key-9999', client_id: '1' });
    const incoming = { api_key: '••••••••9999', client_id: '1', spp_percent: 10 };
    const merged = mergeConfigSecrets(incoming, prev);
    assert.equal(merged.api_key, prev.api_key);
    assert.equal(merged.spp_percent, 10);
  });

  it('prepareConfigForStorage yields usable plain + encrypted', () => {
    const prev = { api_key: 'keep-me-xxxx' };
    const { plain, encrypted } = prepareConfigForStorage(
      { api_key: '••••••••xxxx', client_id: '42' },
      prev
    );
    assert.equal(plain.api_key, 'keep-me-xxxx');
    assert.equal(plain.client_id, '42');
    assert.equal(isEncryptedSecret(encrypted.api_key), true);
    assert.equal(decryptSecret(encrypted.api_key), 'keep-me-xxxx');
  });
});
