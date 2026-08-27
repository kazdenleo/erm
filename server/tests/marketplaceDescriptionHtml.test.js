import {
  plainTextToMarketplaceHtml,
  marketplaceHtmlToPlainText,
  applyOzonDescriptionHtml,
} from '../src/utils/marketplaceDescriptionHtml.js';

describe('marketplaceDescriptionHtml', () => {
  test('plain newlines become <br> and special chars are escaped', () => {
    const html = plainTextToMarketplaceHtml('Фильтр AFAC049\n70 мм\n\nAudi A3');
    expect(html).toBe('Фильтр AFAC049<br>70 мм<br><br>Audi A3');
    expect(plainTextToMarketplaceHtml('a < b')).toBe('a &lt; b');
    expect(plainTextToMarketplaceHtml('диаметр < 70 мм')).toBe('диаметр &lt; 70 мм');
  });

  test('existing HTML keeps tags and converts leftover newlines', () => {
    expect(plainTextToMarketplaceHtml('<b>Заголовок</b>\nстрока')).toBe('<b>Заголовок</b><br>строка');
  });

  test('HTML from Ozon/YM round-trips back to newlines', () => {
    const html = 'Фильтр AFAC049<br>70 мм<br><br>Audi A3';
    expect(marketplaceHtmlToPlainText(html)).toBe('Фильтр AFAC049\n70 мм\n\nAudi A3');
  });

  test('applyOzonDescriptionHtml writes 4191 as one value with line separators', () => {
    const item = { attributes: [{ complex_id: 0, id: 85, values: [{ value: 'Miles' }] }] };
    applyOzonDescriptionHtml(item, 'строка 1\nстрока 2');
    expect(item.description).toBeUndefined();
    const ann = item.attributes.find((a) => Number(a.id) === 4191);
    expect(ann.values).toEqual([{ value: 'строка 1\u2028строка 2' }]);
    expect(item.attributes.some((a) => Number(a.id) === 85)).toBe(true);
  });

  test('applyOzonDescriptionHtml collapses split annotation values into one', () => {
    const item = {
      attributes: [
        {
          complex_id: 0,
          id: 4191,
          values: [{ value: 'строка 1' }, { value: 'строка 2' }],
        },
      ],
    };
    applyOzonDescriptionHtml(item, 'строка 1\nстрока 2');
    const ann = item.attributes.find((a) => Number(a.id) === 4191);
    expect(ann.values).toEqual([{ value: 'строка 1\u2028строка 2' }]);
  });

  test('annotation html br becomes a line separator inside a single value', () => {
    const item = { attributes: [] };
    applyOzonDescriptionHtml(item, 'Фильтр<br>70 мм');
    const ann = item.attributes.find((a) => Number(a.id) === 4191);
    expect(ann.values).toEqual([{ value: 'Фильтр\u202870 мм' }]);
  });

  test('annotation glued after Ozon stripped newlines is unstuck', () => {
    const item = { attributes: [] };
    applyOzonDescriptionHtml(item, 'Фильтр AFAC167Вес брутто, кг0.334Высота упаковки');
    const ann = item.attributes.find((a) => Number(a.id) === 4191);
    expect(ann.values).toEqual([
      { value: 'Фильтр AFAC167\u2028Вес брутто, кг\u20280.334\u2028Высота упаковки' },
    ]);
  });

  test('previous middot separator is turned back into line breaks on push', () => {
    const item = { attributes: [] };
    applyOzonDescriptionHtml(item, 'Фильтр AFAC167 · Вес брутто [кг]: 0.334 · Высота упаковки');
    const ann = item.attributes.find((a) => Number(a.id) === 4191);
    expect(ann.values).toEqual([
      { value: 'Фильтр AFAC167\u2028Вес брутто [кг]: 0.334\u2028Высота упаковки' },
    ]);
  });
});
