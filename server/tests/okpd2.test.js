import {
  collectOkpd2MpKeys,
  isOkpd2AttributeName,
  normalizeOkpd2Code,
  okpd2FromMpStoredValue,
  storedOkpd2ValueForMarketplace,
} from '../src/utils/okpd2.js';
import okpd2ProductApplyService from '../src/services/okpd2ProductApply.service.js';

describe('okpd2 utils', () => {
  test('normalizes code to dotted form', () => {
    expect(normalizeOkpd2Code('26.20.11.110')).toBe('26.20.11.110');
    expect(normalizeOkpd2Code('262011110')).toBe('26.20.11.110');
    expect(normalizeOkpd2Code(' 26 20 11 ')).toBe('26.20.11');
    expect(normalizeOkpd2Code('26.2')).toBe('26.2');
    expect(normalizeOkpd2Code('')).toBe('');
    expect(normalizeOkpd2Code(null)).toBe('');
  });

  test('rejects malformed codes', () => {
    expect(normalizeOkpd2Code('2')).toBeNull();
    expect(normalizeOkpd2Code('26.20.11.1101')).toBeNull();
    expect(normalizeOkpd2Code('26.20.А1')).toBeNull();
  });

  test('matches OKPD attribute names', () => {
    expect(isOkpd2AttributeName('ОКПД 2')).toBe(true);
    expect(isOkpd2AttributeName('Код ОКПД2')).toBe(true);
    expect(isOkpd2AttributeName('OKPD2 code')).toBe(true);
    expect(isOkpd2AttributeName('ТН ВЭД')).toBe(false);
  });

  test('collects keys and reads stored values', () => {
    const wb = collectOkpd2MpKeys(
      [
        { charcID: 15004292, name: 'ОКПД 2' },
        { charcID: 1, name: 'Цвет' },
      ],
      'wb'
    );
    expect(wb).toEqual(['15004292']);
    expect(storedOkpd2ValueForMarketplace('ozon', '26.20')).toEqual({ value: '26.20' });
    expect(storedOkpd2ValueForMarketplace('wb', '26.20')).toBe('26.20');
    expect(okpd2FromMpStoredValue(['262011110'])).toBe('26.20.11.110');
    expect(okpd2FromMpStoredValue({ value: '26.20' })).toBe('26.20');
    expect(okpd2FromMpStoredValue('мусор')).toBe('');
  });
});

describe('okpd2ProductApplyService.syncPayload', () => {
  const keys = { wb: ['15004292'], ym: ['777'], ozon: [] };
  let original;
  beforeAll(() => {
    original = okpd2ProductApplyService._categoryMpKeys;
    okpd2ProductApplyService._categoryMpKeys = async () => keys;
  });
  afterAll(() => {
    okpd2ProductApplyService._categoryMpKeys = original;
  });

  test('writes card code into marketplace attributes', async () => {
    const payload = { okpd2_code: '262011110', wb_attributes: { 1: 'красный', 15004292: '01.11' } };
    await okpd2ProductApplyService.syncPayload(payload, { existing: { user_category_id: 5 } });
    expect(payload.okpd2_code).toBe('26.20.11.110');
    expect(payload.wb_attributes).toEqual({ 1: 'красный', 15004292: '26.20.11.110' });
    expect(payload.ym_attributes).toEqual({ 777: '26.20.11.110' });
  });

  test('clearing the card code clears marketplace attributes', async () => {
    const payload = { okpd2_code: null, wb_attributes: { 15004292: '26.20' } };
    await okpd2ProductApplyService.syncPayload(payload, {
      existing: { user_category_id: 5, okpd2_code: '26.20' },
    });
    expect(payload.wb_attributes).toEqual({ 15004292: '' });
    expect(payload.ym_attributes).toEqual({ 777: '' });
  });

  test('empty card code is taken from marketplace attributes', async () => {
    const payload = { wb_attributes: { 15004292: '26.20.11.110' } };
    await okpd2ProductApplyService.syncPayload(payload, { existing: { user_category_id: 5 } });
    expect(payload.okpd2_code).toBe('26.20.11.110');
  });

  test('invalid code is ignored and does not clear saved value', async () => {
    const payload = { okpd2_code: 'abc', wb_attributes: { 15004292: '26.20' } };
    await okpd2ProductApplyService.syncPayload(payload, {
      existing: { user_category_id: 5, okpd2_code: '26.20' },
    });
    expect('okpd2_code' in payload).toBe(false);
    expect(payload.wb_attributes).toEqual({ 15004292: '26.20' });
  });

  test('unrelated update does not touch marketplace attributes', async () => {
    const payload = { price: 100 };
    await okpd2ProductApplyService.syncPayload(payload, {
      existing: { user_category_id: 5, okpd2_code: '26.20' },
    });
    expect(payload).toEqual({ price: 100 });
  });
});
