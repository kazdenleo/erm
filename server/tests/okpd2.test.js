import {
  collectOkpd2MpKeys,
  isOkpd2AttributeName,
  normalizeOkpd2Code,
  okpd2FromMpStoredValue,
  storedOkpd2ValueForMarketplace,
} from '../src/utils/okpd2.js';
import okpd2ProductApplyService from '../src/services/okpd2ProductApply.service.js';
import {
  normalizeSearchText,
  parseGithubOkpd2,
  parseWbOkpd2,
} from '../src/services/okpd2Directory.service.js';

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

  describe('category code inheritance', () => {
    let originalCategoryCode;
    beforeAll(() => {
      originalCategoryCode = okpd2ProductApplyService._categoryOkpd2Code;
      okpd2ProductApplyService._categoryOkpd2Code = async () => '14.14.30.110';
    });
    afterAll(() => {
      okpd2ProductApplyService._categoryOkpd2Code = originalCategoryCode;
    });

    test('new product without code inherits category code', async () => {
      const payload = { categoryId: 5, okpd2_code: null };
      await okpd2ProductApplyService.syncPayload(payload, {});
      expect(payload.okpd2_code).toBe('14.14.30.110');
      expect(payload.wb_attributes).toEqual({ 15004292: '14.14.30.110' });
    });

    test('product moved to category inherits its code', async () => {
      const payload = { user_category_id: 5 };
      await okpd2ProductApplyService.syncPayload(payload, { existing: { user_category_id: 3 } });
      expect(payload.okpd2_code).toBe('14.14.30.110');
    });

    test('own product code wins over category code', async () => {
      const payload = { categoryId: 5, okpd2_code: '26.20' };
      await okpd2ProductApplyService.syncPayload(payload, {});
      expect(payload.okpd2_code).toBe('26.20');
    });

    test('regular update of product without code does not inherit', async () => {
      const payload = { price: 100 };
      await okpd2ProductApplyService.syncPayload(payload, { existing: { user_category_id: 5 } });
      expect(payload).toEqual({ price: 100 });
    });
  });
});

describe('okpd2 directory parsing', () => {
  test('parses GitHub classifier rows', () => {
    const rows = parseGithubOkpd2([
      { c: '26.20.11.110', n: ' Ноутбуки ', p: '26.20.11' },
      { c: '26', n: 'Компьютеры', p: 'C' },
      { c: 'мусор', n: 'x' },
    ]);
    expect(rows.map((r) => [r.code, r.name, r.parentCode])).toEqual([
      ['26.20.11.110', 'Ноутбуки', '26.20.11'],
      ['26', 'Компьютеры', null],
    ]);
  });

  test('parses WB directory rows', () => {
    const rows = parseWbOkpd2([
      { okpd2: '26.20.11', description: 'Компьютеры портативные' },
      { okpd2: '01.11.1.110', description: 'нестандартная группировка' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: '26.20.11', name: 'Компьютеры портативные', parentCode: '26.20' });
  });

  test('normalizes search text', () => {
    expect(normalizeSearchText('  Ёлочные   ИГРУШКИ ')).toBe('елочные игрушки');
  });
});
