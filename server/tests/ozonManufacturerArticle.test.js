import {
  looksLikeOzonPartNumber,
  ozonAttrValuesForApi,
  ozonCardAttrToFormText,
  isOzonFreeTextMpAttr,
  isStandaloneOemAttrName,
  parseOzonStoredAttr,
  collapseOzonNonCollectionAttrValues,
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

  test('collection OEM stays one string even if schema says is_collection', () => {
    const values = ozonAttrValuesForApi(
      111,
      '8K0129620; 4G0129620',
      { id: 111, name: 'ОЕМ-номер', type: 'String', dictionary_id: 0, is_collection: true }
    );
    expect(values).toEqual([{ value: '8K0129620; 4G0129620' }]);
  });

  test('collapse joins extra text values for annotation and OEM', () => {
    const collapsed = collapseOzonNonCollectionAttrValues([
      { id: 4191, values: [{ value: 'строка 1' }, { value: 'строка 2' }] },
      { id: 7324, values: [{ value: 'A' }, { value: 'B' }] },
      { id: 85, values: [{ dictionary_value_id: 1 }, { dictionary_value_id: 2 }] },
    ]);
    expect(collapsed.find((a) => a.id === 4191).values).toEqual([{ value: 'строка 1 строка 2' }]);
    expect(collapsed.find((a) => a.id === 7324).values).toEqual([{ value: 'A; B' }]);
    expect(collapsed.find((a) => a.id === 85).values).toEqual([
      { dictionary_value_id: 1 },
      { dictionary_value_id: 2 },
    ]);
  });

  test('OEM list stays one value with semicolon and space', () => {
    const collapsed = collapseOzonNonCollectionAttrValues([
      { id: 7324, values: [{ value: '2740940004; A2740940004' }] },
    ]);
    expect(collapsed[0].values).toEqual([{ value: '2740940004; A2740940004' }]);
  });

  test('non-collection OEM sends all numbers in one string', () => {
    const values = ozonAttrValuesForApi(
      7324,
      '8K0129620; 4G0129620',
      { id: 7324, name: 'OEM-номер', type: 'String', dictionary_id: 0, is_collection: false }
    );
    expect(values).toEqual([{ value: '8K0129620; 4G0129620' }]);
  });

  test('комплектация joins list parts without comma or semicolon', () => {
    const values = ozonAttrValuesForApi(
      4384,
      'Фильтр воздушный 1шт; Упаковачная коробка 1 шт',
      { id: 4384, name: 'Комплектация', type: 'String', dictionary_id: 0, is_collection: false }
    );
    expect(values).toEqual([{ value: 'Фильтр воздушный 1шт. Упаковачная коробка 1 шт' }]);
  });

  test('boolean marking attr is sent as true/false', () => {
    const no = ozonAttrValuesForApi(23536, '', { id: 23536, name: 'Нужен код маркировки', type: 'Boolean' });
    expect(no).toEqual([{ value: 'false' }]);
    const yes = ozonAttrValuesForApi(23536, 'Да', { id: 23536, name: 'Нужен код маркировки', type: 'Boolean' });
    expect(yes).toEqual([{ value: 'true' }]);
    const nyet = ozonAttrValuesForApi(23536, 'Нет', { id: 23536, type: 'Boolean' });
    expect(nyet).toEqual([{ value: 'false' }]);
  });

  test('annotation with newlines stays a single flattened value', () => {
    const values = ozonAttrValuesForApi(
      4191,
      'Фильтр AFAC049\n70 мм\nAudi A3',
      { id: 4191, name: 'Аннотация', type: 'String', dictionary_id: 0 }
    );
    expect(values).toEqual([{ value: 'Фильтр AFAC049 70 мм Audi A3' }]);
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
