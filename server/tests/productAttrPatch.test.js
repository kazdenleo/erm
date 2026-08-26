import {
  isEmptyAttrPatch,
  isEmptyJsonAttrValue,
  mergeJsonAttrPatch,
  mergeJsonObjectPatch,
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

  test('draft patch keeps sibling keys', () => {
    const existing = { vendorCode: 'AFAC167', dimensions: { length: 1 } };
    expect(mergeJsonObjectPatch(existing, { vendorCode: 'X' })).toEqual({
      vendorCode: 'X',
      dimensions: { length: 1 },
    });
    expect(mergeJsonObjectPatch(existing, {})).toEqual(existing);
  });
});
