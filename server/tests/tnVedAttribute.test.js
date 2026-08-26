import {
  collectTnVedMpKeys,
  fillEmptyErpTnVedAttributeValues,
  fillEmptyTnVedKeys,
  isEmptyMpStoredValue,
  isTnVedAttributeName,
  normalizeCategoryTnVedCode,
  storedTnVedValueForMarketplace,
} from '../src/utils/tnVedAttribute.js';

describe('tnVedAttribute', () => {
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

  test('rejects unknown codes', () => {
    expect(() => normalizeCategoryTnVedCode('0000000001')).toThrow(/справочника/);
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
