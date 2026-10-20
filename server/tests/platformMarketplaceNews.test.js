/**
 * Парсеры ленты новостей маркетплейсов (супер-админ).
 */

import {
  isRelevantNews,
  stripLeadingDate,
  parseTelegramChannelHtml,
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

  test('isRelevantNews passes API-only sources', () => {
    expect(isRelevantNews({ source: 'ozon', title: 'hello', summary: '' })).toBe(true);
    expect(isRelevantNews({ source: 'wildberries', title: 'x', summary: 'y' })).toBe(true);
    expect(isRelevantNews({ source: 'yandex', title: 'x', summary: 'y' })).toBe(true);
    expect(isRelevantNews({ source: 'other', title: 'скидки на обувь', summary: '' })).toBe(false);
    expect(isRelevantNews({ source: 'other', title: 'Изменения API', summary: '' })).toBe(true);
  });
});
