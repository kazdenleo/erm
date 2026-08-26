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

  test('applyOzonDescriptionHtml writes 4191 and top-level description', () => {
    const item = { attributes: [{ complex_id: 0, id: 85, values: [{ value: 'Miles' }] }] };
    applyOzonDescriptionHtml(item, 'строка 1\nстрока 2');
    expect(item.description).toBe('строка 1<br>строка 2');
    const ann = item.attributes.find((a) => Number(a.id) === 4191);
    expect(ann.values[0].value).toBe('строка 1<br>строка 2');
    expect(item.attributes.some((a) => Number(a.id) === 85)).toBe(true);
  });
});
