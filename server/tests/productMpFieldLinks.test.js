import { applyLinkedOzonCardTextOnUpdate } from '../src/utils/productMpFieldLinks.js';

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
