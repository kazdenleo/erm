import { parseCompetitorUrl } from '../src/services/productCompetitors.fetch.js';

describe('parseCompetitorUrl', () => {
  test('ozon product id is the last long number in the path', () => {
    const parsed = parseCompetitorUrl(
      'https://www.ozon.ru/product/filtr-5w30-1649328471/?from=share'
    );
    expect(parsed.marketplace).toBe('ozon');
    expect(parsed.externalId).toBe('1649328471');
    expect(parsed.url).toBe('https://www.ozon.ru/product/filtr-5w30-1649328471');
  });

  test('wildberries catalog id', () => {
    const parsed = parseCompetitorUrl('https://www.wildberries.ru/catalog/12345678/detail.aspx?targetUrl=SP');
    expect(parsed.marketplace).toBe('wb');
    expect(parsed.externalId).toBe('12345678');
    expect(parsed.url).toBe('https://www.wildberries.ru/catalog/12345678/detail.aspx');
  });

  test('yandex market card id', () => {
    const parsed = parseCompetitorUrl('https://market.yandex.ru/card/filtr/99887766?text=filtr');
    expect(parsed.marketplace).toBe('ym');
    expect(parsed.externalId).toBe('99887766');
    expect(parsed.url).toBe('https://market.yandex.ru/card/filtr/99887766');
  });
});
