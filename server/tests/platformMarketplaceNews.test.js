/**
 * Парсеры ленты новостей маркетплейсов (супер-админ).
 */

import {
  isRelevantNews,
  stripLeadingDate,
  parseTelegramChannelHtml,
  parseTelegramRssXml,
  parseYandexChangelogMarkdown,
} from '../src/services/platformMarketplaceNews.service.js';

describe('platformMarketplaceNews parsers', () => {
  test('parseTelegramChannelHtml extracts posts without duplicated date in title', () => {
    const html = `
      <div class="tgme_widget_message" data-post="OzonSellerAPI/700">
        <div class="tgme_widget_message_text"><b>11 сентября 2026</b><br/>Добавили /v1/test</div>
        <time datetime="2026-10-15T12:00:00+00:00"></time>
      </div>
      <div class="tgme_widget_message" data-post="OzonSellerAPI/701">
        <div class="tgme_widget_message_text">Второй пост про Seller API</div>
        <time datetime="2026-10-16T09:30:00+00:00"></time>
      </div>
    `;
    const items = parseTelegramChannelHtml(html, {
      source: 'ozon',
      channelUrl: 'https://t.me/s/OzonSellerAPI',
    });
    expect(items).toHaveLength(2);
    expect(items[0].externalId).toBe('700');
    expect(items[0].source).toBe('ozon');
    expect(items[0].url).toBe('https://t.me/OzonSellerAPI/700');
    expect(items[0].title).toMatch(/Добавили \/v1\/test/);
    expect(items[0].title).not.toMatch(/сентября/);
    expect(items[0].body).toMatch(/Добавили \/v1\/test/);
    expect(items[0].body).not.toMatch(/^11 сентября/);
    expect(items[0].publishedAt).toBe('2026-10-15T12:00:00.000Z');
  });

  test('parseTelegramChannelHtml uses reply message text, not quoted original', () => {
    const html = `
      <div class="tgme_widget_message" data-post="OzonSellerAPI/709">
        <div class="tgme_widget_message_reply">
          <div class="tgme_widget_message_text">Обновление методов работы с акциями в Seller API (v2) старый текст цитаты</div>
        </div>
        <div class="tgme_widget_message_text">Важное обновление: дата перенесена на 19 октября 2026 года.</div>
        <time datetime="2026-10-14T09:30:00+00:00"></time>
      </div>
    `;
    const items = parseTelegramChannelHtml(html, {
      source: 'ozon',
      channelUrl: 'https://t.me/s/OzonSellerAPI',
    });
    expect(items).toHaveLength(1);
    expect(items[0].body).toMatch(/дата перенесена на 19 октября/);
    expect(items[0].body).not.toMatch(/старый текст цитаты/);
    expect(items[0].title).toMatch(/Важное обновление/);
  });

  test('parseTelegramChannelHtml keeps link urls next to labels', () => {
    const html = `
      <div class="tgme_widget_message" data-post="OzonSellerAPI/707">
        <div class="tgme_widget_message_text">
          <a href="https://docs.ozon.ru/api/seller/#operation/X">/v1/supply-order/shipment-plan-compliance/get</a>: Добавили бета-метод
        </div>
        <time datetime="2026-10-12T08:00:00+00:00"></time>
      </div>
    `;
    const items = parseTelegramChannelHtml(html, {
      source: 'ozon',
      channelUrl: 'https://t.me/s/OzonSellerAPI',
    });
    expect(items[0].body).toContain(
      '/v1/supply-order/shipment-plan-compliance/get (https://docs.ozon.ru/api/seller/#operation/X)'
    );
  });

  test('parseYandexChangelogMarkdown extracts sections by anchor without date-only title', () => {
    const md = `
### 6 октября {#06-10-26}

Добавили поле warehouseModel.

### 1 октября {#01-10-26}

Фильтры inns в отчёте.
`;
    const items = parseYandexChangelogMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0].externalId).toBe('changelog-06-10-26');
    expect(items[0].source).toBe('yandex');
    expect(items[0].title).toBe('Яндекс Маркет API');
    expect(items[0].body).toContain('warehouseModel');
    expect(items[0].publishedAt).toBe('2026-10-06T12:00:00.000Z');
    expect(items[0].url).toContain('#06-10-26');
  });

  test('stripLeadingDate removes date-only and leading date prefixes', () => {
    expect(stripLeadingDate('11 сентября 2026')).toBe('');
    expect(stripLeadingDate('11 сентября 2026\nНовый метод API')).toBe('Новый метод API');
    expect(stripLeadingDate('11 сентября 2026 /v1/product/list: обновление')).toBe(
      '/v1/product/list: обновление'
    );
  });

  test('isRelevantNews passes API feeds and filters ops feeds', () => {
    expect(isRelevantNews({ source: 'ozon', tags: ['api'], title: 'hello', summary: '' })).toBe(true);
    expect(isRelevantNews({ source: 'wildberries', tags: ['api'], title: 'x', summary: 'y' })).toBe(true);
    expect(
      isRelevantNews({
        source: 'ozon',
        tags: ['ops'],
        title: 'Вебинар для новичков',
        summary: 'регистрация открыта',
      })
    ).toBe(false);
    expect(
      isRelevantNews({
        source: 'ozon',
        tags: ['ops'],
        title: 'Новые тарифы логистики FBO',
        summary: 'с 6 апреля снизим плату за доставку',
      })
    ).toBe(true);
    expect(
      isRelevantNews({
        source: 'ozon',
        tags: ['ops'],
        title: 'Запускаем конкурс «Время Fashion» для тех, кто продаёт одежду и аксессуары',
        summary: 'Вчера рассказали про продление льгот для fashion',
        body: 'Вчера рассказали про продление льгот для fashion',
      })
    ).toBe(false);
    expect(
      isRelevantNews({
        source: 'wildberries',
        tags: ['ops'],
        title: '#дайджест',
        body: 'Акция для партнёров: логистика FBO дешевле в выходные',
      })
    ).toBe(false);
    expect(
      isRelevantNews({
        source: 'wildberries',
        tags: ['ops'],
        title: 'Хозтовары на WB: стабильный рост и как его использовать',
        summary: 'разбираем спрос в категории',
      })
    ).toBe(false);
    expect(
      isRelevantNews({
        source: 'ozon',
        tags: ['ops'],
        title: 'FBS: время на отгрузку начнёт учитывать все дни недели',
        summary: '',
      })
    ).toBe(true);
    expect(
      isRelevantNews({
        source: 'ozon',
        tags: ['ops'],
        title: 'Продлили льготы для fashion-товаров до 2028 года',
        summary: '',
      })
    ).toBe(true);
    expect(isRelevantNews({ source: 'other', title: 'Изменения API', summary: '' })).toBe(true);
  });

  test('parseTelegramChannelHtml supports ops tags and seller externalId prefix', () => {
    const html = `
      <div class="tgme_widget_message" data-post="ozonmarketplace/3350">
        <div class="tgme_widget_message_text">Новые тарифы на размещение FBO</div>
        <time datetime="2026-11-01T10:00:00+00:00"></time>
      </div>
    `;
    const items = parseTelegramChannelHtml(html, {
      source: 'ozon',
      channelUrl: 'https://t.me/s/ozonmarketplace',
      tags: ['ops'],
      externalIdPrefix: 'seller-',
    });
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe('seller-3350');
    expect(items[0].tags).toEqual(['ops']);
    expect(items[0].url).toBe('https://t.me/ozonmarketplace/3350');
  });

  test('parseTelegramRssXml extracts posts from RSSHub feed', () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title><![CDATA[Новые тарифы FBO]]></title>
          <link>https://t.me/ozonmarketplace/3350</link>
          <guid>https://t.me/ozonmarketplace/3350</guid>
          <pubDate>Thu, 19 Nov 2026 11:37:38 GMT</pubDate>
          <description><![CDATA[&lt;p&gt;&lt;b&gt;Новые тарифы FBO&lt;/b&gt; с 1 декабря&lt;/p&gt;]]></description>
        </item>
      </channel></rss>`;
    const items = parseTelegramRssXml(xml, {
      source: 'ozon',
      channelUrl: 'https://t.me/s/ozonmarketplace',
      tags: ['ops'],
      externalIdPrefix: 'seller-',
    });
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe('seller-3350');
    expect(items[0].body).toMatch(/Новые тарифы FBO/);
    expect(items[0].url).toBe('https://t.me/ozonmarketplace/3350');
    expect(items[0].publishedAt).toBe('2026-11-19T11:37:38.000Z');
  });
});
