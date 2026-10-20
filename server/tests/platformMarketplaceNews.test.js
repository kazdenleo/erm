/**
 * Парсеры ленты новостей маркетплейсов (супер-админ).
 */

import {
  isRelevantNews,
  parseTelegramChannelHtml,
  parseYandexChangelogMarkdown,
} from '../src/services/platformMarketplaceNews.service.js';

describe('platformMarketplaceNews parsers', () => {
  test('parseTelegramChannelHtml extracts posts', () => {
    const html = `
      <div class="tgme_widget_message" data-post="OzonSellerAPI/700">
        <div class="tgme_widget_message_text"><b>Новый метод</b><br/>Добавили /v1/test</div>
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
    expect(items[0].title).toMatch(/Новый метод/);
    expect(items[0].publishedAt).toBe('2026-10-15T12:00:00.000Z');
  });

  test('parseYandexChangelogMarkdown extracts sections by anchor', () => {
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
    expect(items[0].title).toContain('6 октября');
    expect(items[0].publishedAt).toBe('2026-10-06T12:00:00.000Z');
    expect(items[0].url).toContain('#06-10-26');
  });

  test('isRelevantNews passes API-only sources', () => {
    expect(isRelevantNews({ source: 'ozon', title: 'hello', summary: '' })).toBe(true);
    expect(isRelevantNews({ source: 'wildberries', title: 'x', summary: 'y' })).toBe(true);
    expect(isRelevantNews({ source: 'yandex', title: 'x', summary: 'y' })).toBe(true);
    expect(isRelevantNews({ source: 'other', title: 'скидки на обувь', summary: '' })).toBe(false);
    expect(isRelevantNews({ source: 'other', title: 'Изменения API', summary: '' })).toBe(true);
  });
});
