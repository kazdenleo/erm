import {
  isEmptyAttrPatch,
  isEmptyJsonAttrValue,
  mergeJsonAttrPatch,
  mergeJsonObjectPatch,
  omitEmptyMpCardTextFromProductPatch,
} from '../src/utils/productAttrPatch.js';

describe('productAttrPatch', () => {
  test('empty patch does not wipe existing attributes', () => {
    const existing = { 85: 'Miles', 4191: { value: 'текст' } };
    expect(mergeJsonAttrPatch(existing, {})).toEqual(existing);
    expect(mergeJsonAttrPatch(existing, null)).toEqual(existing);
    expect(isEmptyAttrPatch({})).toBe(true);
  });

  test('merges changed keys and keeps the rest', () => {
    const existing = { 85: 'Miles', 4191: { value: 'старое' }, 7324: 'OEM' };
    expect(
      mergeJsonAttrPatch(existing, { 4191: { value: 'новое' } })
    ).toEqual({ 85: 'Miles', 4191: { value: 'новое' }, 7324: 'OEM' });
  });

  test('null or empty string deletes only that key', () => {
    const existing = { 85: 'Miles', 9048: 'модель' };
    expect(mergeJsonAttrPatch(existing, { 9048: '' })).toEqual({ 85: 'Miles' });
    expect(mergeJsonAttrPatch(existing, { 9048: null })).toEqual({ 85: 'Miles' });
    expect(isEmptyJsonAttrValue({ value: '', dictionary_value_id: '' })).toBe(true);
  });

  test('empty ozon name/annotation in patch does not wipe existing columns', () => {
    expect(
      omitEmptyMpCardTextFromProductPatch({
        brand: 'Miles',
        mp_ozon_name: null,
        mp_ozon_description: '',
        mp_wb_name: '',
      })
    ).toEqual({ brand: 'Miles', mp_wb_name: '' });
    expect(
      omitEmptyMpCardTextFromProductPatch({
        mp_ozon_name: 'Фильтр',
        mp_ozon_description: 'текст',
      })
    ).toEqual({
      mp_ozon_name: 'Фильтр',
      mp_ozon_description: 'текст',
    });
  });

  test('draft patch keeps sibling keys', () => {
    const existing = { vendorCode: 'AFAC167', dimensions: { length: 1 } };
    expect(mergeJsonObjectPatch(existing, { vendorCode: 'X' })).toEqual({
      vendorCode: 'X',
      dimensions: { length: 1 },
    });
    expect(mergeJsonObjectPatch(existing, {})).toEqual(existing);
  });
});
