import {
  collectTnVedMpKeys,
  fillEmptyErpTnVedAttributeValues,
  fillEmptyTnVedKeys,
  isEmptyMpStoredValue,
  isTnVedAttributeName,
  leadingTnVedDigits,
  matchOzonTnVedDictEntry,
  normalizeCategoryTnVedCode,
  ozonStoredTnVedSearchCode,
  ozonTnVedApiValuesFromDictEntry,
  replaceTnVedKeys,
  storedTnVedDigits,
  storedTnVedValueForMarketplace,
  ymCommodityCodesWithTnVed,
} from '../src/utils/tnVedAttribute.js';

describe('tnVedAttribute', () => {
  test('ymCommodityCodesWithTnVed replaces customs code and keeps other types', () => {
    expect(ymCommodityCodesWithTnVed([], '8421310000')).toEqual([
      { code: '8421310000', type: 'CUSTOMS_COMMODITY_CODE' },
    ]);
    expect(
      ymCommodityCodesWithTnVed(
        [
          { code: '4011201000', type: 'CUSTOMS_COMMODITY_CODE' },
          { code: '29.32.30', type: 'OKPD2_CODE' },
        ],
        '8421310000'
      )
    ).toEqual([
      { code: '29.32.30', type: 'OKPD2_CODE' },
      { code: '8421310000', type: 'CUSTOMS_COMMODITY_CODE' },
    ]);
    expect(ymCommodityCodesWithTnVed(undefined, '')).toBeNull();
    expect(ymCommodityCodesWithTnVed(undefined, '8421')).toBeNull();
  });

  test('storedTnVedDigits reads code from stored MP values', () => {
    expect(storedTnVedDigits('8421310000')).toBe('8421310000');
    expect(storedTnVedDigits(8421310000)).toBe('8421310000');
    expect(storedTnVedDigits({ value: '8421310000' })).toBe('8421310000');
    expect(
      storedTnVedDigits('8421310000 - Воздушные фильтры для двигателей внутреннего сгорания->971399513')
    ).toBe('8421310000');
    expect(storedTnVedDigits([{ dictionary_value_id: 971399513, value: '8421310000 – Фильтры' }])).toBe(
      '8421310000'
    );
    expect(storedTnVedDigits({ dictionary_value_id: 971399513 })).toBe('');
    expect(storedTnVedDigits('Фильтр')).toBe('');
    expect(storedTnVedDigits(null)).toBe('');
  });

  test('replaceTnVedKeys replaces previous category code and fills empty, keeps manual codes', () => {
    const attrs = { a: '8421310000', b: '', c: '4011201000', d: 'x' };
    const next = replaceTnVedKeys(attrs, ['a', 'b', 'c'], '8421310000', '8421390000');
    expect(next).toEqual({ a: '8421390000', b: '8421390000', c: '4011201000', d: 'x' });
    const ozon = { 22232: '8421310000 - Воздушные фильтры->971399513' };
    expect(replaceTnVedKeys(ozon, ['22232'], '8421310000', { value: '8421390000' })).toEqual({
      22232: { value: '8421390000' },
    });
    const same = { a: '4011201000' };
    expect(replaceTnVedKeys(same, ['a'], '8421310000', '8421390000')).toBe(same);
    expect(replaceTnVedKeys(null, ['a'], null, '8421390000')).toEqual({ a: '8421390000' });
  });

  test('matches TN VED / HS code attribute names', () => {
    expect(isTnVedAttributeName('ТН ВЭД')).toBe(true);
    expect(isTnVedAttributeName('Код ТН ВЭД')).toBe(true);
    expect(isTnVedAttributeName('HS Code')).toBe(true);
    expect(isTnVedAttributeName('TNVED')).toBe(true);
    expect(isTnVedAttributeName('ТНВЭД')).toBe(true);
    expect(isTnVedAttributeName('ТН ВЭД коды ЕАЭС')).toBe(true);
    expect(isTnVedAttributeName('Бренд')).toBe(false);
    expect(isTnVedAttributeName('')).toBe(false);
  });

  test('collects marketplace keys by attribute name', () => {
    const ozon = collectTnVedMpKeys(
      [
        { id: 11, name: 'Бренд' },
        { id: 22, name: 'Код ТН ВЭД' },
        { id: 33, name: 'HS code' },
      ],
      'ozon'
    );
    expect(ozon).toEqual(['22', '33']);

    const wb = collectTnVedMpKeys(
      [{ charcID: 15000, charcName: 'ТНВЭД' }, { charcID: 1, name: 'Цвет' }],
      'wb'
    );
    expect(wb).toEqual(['15000']);
  });

  test('fills only empty marketplace values', () => {
    const code = storedTnVedValueForMarketplace('ozon', '8708299009');
    const next = fillEmptyTnVedKeys(
      { 22: { value: '' }, 99: { value: 'already' } },
      ['22', '99', '44'],
      code
    );
    expect(next[22]).toEqual({ value: '8708299009' });
    expect(next[99]).toEqual({ value: 'already' });
    expect(next[44]).toEqual({ value: '8708299009' });
  });

  test('treats empty ozon dictionary objects as empty', () => {
    expect(isEmptyMpStoredValue({ value: '' })).toBe(true);
    expect(isEmptyMpStoredValue({ dictionary_value_id: 12 })).toBe(false);
    expect(isEmptyMpStoredValue('8708')).toBe(false);
  });
});

describe('normalizeCategoryTnVedCode', () => {
  test('accepts known catalog code and clears empty', () => {
    expect(normalizeCategoryTnVedCode('')).toBeNull();
    expect(normalizeCategoryTnVedCode(null)).toBeNull();
    expect(normalizeCategoryTnVedCode(undefined)).toBeUndefined();
    expect(normalizeCategoryTnVedCode('8708299009')).toBe('8708299009');
  });

  test('rejects codes that are not 10 digits', () => {
    expect(() => normalizeCategoryTnVedCode('960350')).toThrow(/10 цифр/);
    expect(() => normalizeCategoryTnVedCode('96035000009')).toThrow(/10 цифр/);
  });
});

describe('fillEmptyErpTnVedAttributeValues', () => {
  test('fills only empty ERP attribute ids', () => {
    const next = fillEmptyErpTnVedAttributeValues({ 10: 'already' }, [10, 22, '33'], '8421310000');
    expect(next[10]).toBe('already');
    expect(next[22]).toBe('8421310000');
    expect(next[33]).toBe('8421310000');
  });

  test('returns same object when nothing to fill', () => {
    const prev = { 22: '8421310000' };
    expect(fillEmptyErpTnVedAttributeValues(prev, [22], '8421310000')).toBe(prev);
    expect(fillEmptyErpTnVedAttributeValues(prev, [], '8421310000')).toBe(prev);
  });
});

describe('Ozon TN VED dictionary matching', () => {
  const dict = [
    { id: 11, value: '4011100000 – Шины пневматические новые' },
    { id: 22, value: '8421310000 – Воздушные фильтры для двигателей внутреннего сгорания' },
    { id: 33, value: '8421392008 – Аппараты для фильтрования или очистки газов прочие' },
  ];

  test('picks dictionary row by code prefix, not a hardcoded label', () => {
    const hit = matchOzonTnVedDictEntry(dict, '8421310000');
    expect(hit?.id).toBe(22);
    expect(hit.value).toMatch(/^8421310000/);
    expect(matchOzonTnVedDictEntry(dict, '4011100000')?.id).toBe(11);
  });

  test('reads 10-digit code from stored digits or Ozon label', () => {
    expect(ozonStoredTnVedSearchCode({ value: '8421310000' }, '')).toBe('8421310000');
    expect(ozonStoredTnVedSearchCode('8421310000 – Воздушные фильтры', '4011100000')).toBe('8421310000');
    expect(ozonStoredTnVedSearchCode({ dictionary_value_id: 97100233 }, '8421310000')).toBe('');
    expect(ozonStoredTnVedSearchCode('', '8421310000')).toBe('8421310000');
    expect(leadingTnVedDigits('8421310000 – Воздушные фильтры')).toBe('8421310000');
  });

  test('push payload uses dictionary_value_id and directory text', () => {
    const hit = matchOzonTnVedDictEntry(dict, '8421310000');
    expect(ozonTnVedApiValuesFromDictEntry(hit)).toEqual([
      {
        dictionary_value_id: 22,
        value: '8421310000 – Воздушные фильтры для двигателей внутреннего сгорания',
      },
    ]);
  });
});
