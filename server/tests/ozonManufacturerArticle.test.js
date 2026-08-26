import {
  looksLikeOzonPartNumber,
  ozonAttrValuesForApi,
  ozonCardAttrToFormText,
  isOzonFreeTextMpAttr,
  isStandaloneOemAttrName,
  parseOzonStoredAttr,
} from '../src/utils/ozonManufacturerArticle.js';

describe('ozon OEM / part number push', () => {
  test('numeric OEM is sent as value, not dictionary_value_id', () => {
    const values = ozonAttrValuesForApi(9999, { dictionary_value_id: 45115561 }, { id: 9999, name: 'OEM' });
    expect(values).toEqual([{ value: '45115561' }]);
  });

  test('arrow-stored OEM keeps the number text', () => {
    const values = ozonAttrValuesForApi(111, '8K0129620->971082156', { id: 111, name: 'OEM-номер' });
    expect(values).toEqual([{ value: '8K0129620' }]);
  });

  test('артикул производителя 7236 always uses value', () => {
    const values = ozonAttrValuesForApi(7236, { dictionary_value_id: 12345, value: 'AFAC049' }, { id: 7236 });
    expect(values).toEqual([{ value: 'AFAC049' }]);
  });

  test('real dictionary still uses dictionary_value_id', () => {
    const values = ozonAttrValuesForApi(85, 'Miles->9700001', { id: 85, name: 'Бренд' });
    expect(values).toEqual([{ dictionary_value_id: 9700001 }]);
  });

  test('brand like 3M stays dictionary, not part number', () => {
    const values = ozonAttrValuesForApi(85, '3M->42', { id: 85, name: 'Бренд', dictionary_id: 1 });
    expect(values).toEqual([{ dictionary_value_id: 42 }]);
  });

  test('looksLikeOzonPartNumber', () => {
    expect(looksLikeOzonPartNumber('8K0129620')).toBe(true);
    expect(looksLikeOzonPartNumber('Китай')).toBe(false);
    expect(isOzonFreeTextMpAttr({ name: 'OEM' })).toBe(true);
    expect(parseOzonStoredAttr('A->12').dictId).toBe(12);
  });

  test('кириллическое ОЕМ-номер — свободный текст, не словарь', () => {
    expect(isStandaloneOemAttrName('ОЕМ-номер')).toBe(true);
    expect(isStandaloneOemAttrName('OEM-номер')).toBe(true);
    expect(isOzonFreeTextMpAttr({ name: 'ОЕМ-номер', type: 'String', dictionary_id: 0 })).toBe(true);
    const values = ozonAttrValuesForApi(
      2222,
      { dictionary_value_id: 99 },
      { id: 2222, name: 'ОЕМ-номер' }
    );
    expect(values).toEqual([{ value: '99' }]);
  });

  test('string attr without dictionary never sends dictionary_value_id', () => {
    const values = ozonAttrValuesForApi(
      2222,
      { dictionary_value_id: 777 },
      { id: 2222, name: 'ОЕМ-номер', type: 'String', dictionary_id: 0 }
    );
    expect(values).toEqual([{ value: '777' }]);
    expect(values[0].dictionary_value_id).toBeUndefined();
  });

  test('bare schema id does not force every attr to text', () => {
    const values = ozonAttrValuesForApi(85, 'Miles->9700001', { id: 85 });
    expect(values).toEqual([{ dictionary_value_id: 9700001 }]);
  });

  test('партномер 7236 is not treated as standalone OEM', () => {
    expect(isStandaloneOemAttrName('Партномер (артикул производителя)')).toBe(false);
  });

  test('collection OEM splits on semicolon into several values', () => {
    const values = ozonAttrValuesForApi(
      111,
      '8K0129620; 4G0129620',
      { id: 111, name: 'ОЕМ-номер', type: 'String', dictionary_id: 0, is_collection: true }
    );
    expect(values).toEqual([{ value: '8K0129620' }, { value: '4G0129620' }]);
  });

  test('non-collection OEM keeps semicolon in one value', () => {
    const values = ozonAttrValuesForApi(
      7324,
      '8K0129620; 4G0129620',
      { id: 7324, name: 'OEM-номер', type: 'String', dictionary_id: 0, is_collection: false }
    );
    expect(values).toEqual([{ value: '8K0129620; 4G0129620' }]);
  });

  test('annotation with newlines stays a single value', () => {
    const values = ozonAttrValuesForApi(
      4191,
      'Фильтр AFAC049\n70 мм\nAudi A3',
      { id: 4191, name: 'Аннотация', type: 'String', dictionary_id: 0 }
    );
    expect(values).toEqual([{ value: 'Фильтр AFAC049\n70 мм\nAudi A3' }]);
  });

  test('ozonCardAttrToFormText joins OEM collection', () => {
    const text = ozonCardAttrToFormText({
      id: 111,
      name: 'ОЕМ-номер',
      values: [{ value: '8K0129620' }, { value: '4G0129620' }],
    });
    expect(text).toBe('8K0129620; 4G0129620');
  });

  test('ozonCardAttrToFormText prefers dictionary id for brand select', () => {
    const text = ozonCardAttrToFormText({
      id: 85,
      name: 'Бренд',
      values: [{ value: 'Miles', dictionary_value_id: 9700001 }],
    });
    expect(text).toBe('9700001');
  });
});
