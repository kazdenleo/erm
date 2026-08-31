import {
  applyLinkedOzonCardTextOnUpdate,
  isMpFieldLinked,
  normalizeMpFieldLinks,
  setMpFieldLink,
} from '../src/utils/productMpFieldLinks.js';

describe('isMpFieldLinked dim axes', () => {
  test('inherits product_dimensions when axis key is absent', () => {
    const links = normalizeMpFieldLinks({ product_dimensions: ['ozon'] });
    expect(isMpFieldLinked(links, 'product_width', 'ozon')).toBe(true);
    expect(isMpFieldLinked(links, 'product_length', 'ozon')).toBe(true);
    expect(isMpFieldLinked(links, 'product_height', 'wb')).toBe(false);
  });

  test('explicit product_width does not turn on other axes', () => {
    const links = normalizeMpFieldLinks({ product_width: ['ozon', 'wb'] });
    expect(isMpFieldLinked(links, 'product_width', 'ozon')).toBe(true);
    expect(isMpFieldLinked(links, 'product_width', 'wb')).toBe(true);
    expect(isMpFieldLinked(links, 'product_length', 'ozon')).toBe(false);
    expect(isMpFieldLinked(links, 'product_height', 'ozon')).toBe(false);
    expect(isMpFieldLinked(links, 'product_weight', 'ozon')).toBe(false);
  });

  test('empty product_width overrides group on', () => {
    const links = normalizeMpFieldLinks({
      product_dimensions: ['ozon'],
      product_width: [],
    });
    expect(isMpFieldLinked(links, 'product_width', 'ozon')).toBe(false);
    expect(isMpFieldLinked(links, 'product_length', 'ozon')).toBe(true);
  });
});

describe('setMpFieldLink dim axes', () => {
  test('enabling product_width does not enable length/height/weight', () => {
    let links = {};
    for (const mp of ['ozon', 'wb', 'ym']) {
      links = setMpFieldLink(links, 'product_width', mp, true);
    }
    expect(isMpFieldLinked(links, 'product_width', 'ozon')).toBe(true);
    expect(isMpFieldLinked(links, 'product_width', 'wb')).toBe(true);
    expect(isMpFieldLinked(links, 'product_width', 'ym')).toBe(true);
    expect(isMpFieldLinked(links, 'product_length', 'ozon')).toBe(false);
    expect(isMpFieldLinked(links, 'product_height', 'ozon')).toBe(false);
    expect(isMpFieldLinked(links, 'product_weight', 'ozon')).toBe(false);
    expect(isMpFieldLinked(links, 'product_length', 'wb')).toBe(false);
    expect(isMpFieldLinked(links, 'product_length', 'ym')).toBe(false);
  });

  test('enabling one pack axis does not enable other pack axes', () => {
    const links = setMpFieldLink({}, 'width', 'ozon', true);
    expect(isMpFieldLinked(links, 'width', 'ozon')).toBe(true);
    expect(isMpFieldLinked(links, 'length', 'ozon')).toBe(false);
    expect(isMpFieldLinked(links, 'height', 'ozon')).toBe(false);
    expect(isMpFieldLinked(links, 'weight', 'ozon')).toBe(false);
  });

  test('first axis toggle keeps other axes at previous group state', () => {
    const links = setMpFieldLink({ product_dimensions: ['ozon'] }, 'product_width', 'wb', true);
    expect(isMpFieldLinked(links, 'product_width', 'ozon')).toBe(true);
    expect(isMpFieldLinked(links, 'product_width', 'wb')).toBe(true);
    expect(isMpFieldLinked(links, 'product_length', 'ozon')).toBe(true);
    expect(isMpFieldLinked(links, 'product_length', 'wb')).toBe(false);
    expect(isMpFieldLinked(links, 'product_height', 'ozon')).toBe(true);
  });
});

describe('applyLinkedOzonCardTextOnUpdate', () => {
  test('fills empty ozon name/annotation from Main when linked', () => {
    const updates = {
      mp_field_links: { name: ['ozon'], description: ['ozon'] },
      mp_ozon_name: null,
      mp_ozon_description: '',
      ozon_attributes: { 85: { dictionary_value_id: 1 }, 4191: null },
    };
    const existing = {
      name: 'Фильтр воздушный',
      description: 'Текст аннотации',
    };
    const next = applyLinkedOzonCardTextOnUpdate(updates, existing);
    expect(next.mp_ozon_name).toBe('Фильтр воздушный');
    expect(next.mp_ozon_description).toBe('Текст аннотации');
    expect(next.ozon_attributes['4180']).toEqual({ value: 'Фильтр воздушный' });
    expect(next.ozon_attributes['4191']).toEqual({ value: 'Текст аннотации' });
  });

  test('does not overwrite explicit ozon text', () => {
    const updates = {
      mp_field_links: { name: ['ozon'] },
      mp_ozon_name: 'Своё название Ozon',
    };
    const next = applyLinkedOzonCardTextOnUpdate(updates, { name: 'Основное' });
    expect(next.mp_ozon_name).toBe('Своё название Ozon');
  });
});
