import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, preparePhoneFields, requirePhoneFields, looksLikeEmail } from './userPhone.js';
import { parseBirthDate } from './userBirthDate.js';
import { parseOptionalEmail } from './userEmail.js';

test('normalizePhone: empty', () => {
  assert.deepEqual(normalizePhone(''), { value: null });
  assert.deepEqual(normalizePhone(null), { value: null });
  assert.deepEqual(normalizePhone('   '), { value: null });
});

test('normalizePhone: russian formats', () => {
  assert.equal(normalizePhone('+7 (999) 123-45-67').value, '79991234567');
  assert.equal(normalizePhone('8 999 123 45 67').value, '79991234567');
  assert.equal(normalizePhone('9991234567').value, '79991234567');
  assert.equal(normalizePhone('79991234567').value, '79991234567');
});

test('normalizePhone: invalid', () => {
  assert.equal(Boolean(normalizePhone('12345').error), true);
  assert.equal(Boolean(normalizePhone('abc').error), true);
});

test('preparePhoneFields stores +7…', () => {
  assert.deepEqual(preparePhoneFields('89991234567'), {
    phone: '+79991234567',
    phone_normalized: '79991234567',
  });
});

test('looksLikeEmail', () => {
  assert.equal(looksLikeEmail('a@b.c'), true);
  assert.equal(looksLikeEmail('+79991234567'), false);
});

test('parseBirthDate', () => {
  assert.deepEqual(parseBirthDate(''), { value: null });
  assert.equal(parseBirthDate('1990-05-15').value, '1990-05-15');
  assert.equal(Boolean(parseBirthDate('1990-13-01').error), true);
  assert.equal(Boolean(parseBirthDate('1899-01-01').error), true);
});

test('requirePhoneFields', () => {
  assert.equal(Boolean(requirePhoneFields('').error), true);
  assert.equal(requirePhoneFields('89991234567').phone_normalized, '79991234567');
});

test('parseOptionalEmail', () => {
  assert.deepEqual(parseOptionalEmail(''), { value: null });
  assert.equal(parseOptionalEmail('  a@b.c  ').value, 'a@b.c');
  assert.equal(Boolean(parseOptionalEmail('not-an-email').error), true);
});
