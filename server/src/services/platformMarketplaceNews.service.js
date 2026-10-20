/**
 * Автосбор новостей маркетплейсов (изменения API и крупные изменения) для супер-админа.
 *
 * Источники:
 * - Ozon: публичный Telegram https://t.me/s/OzonSellerAPI
 * - Wildberries: публичный Telegram https://t.me/s/wb_api_notifications
 *   (dev.wildberries.ru отдаёт 498 бот-защитой)
 * - Яндекс Маркет: markdown changelog Partner API
 */

import fetch from 'node-fetch';
import { parse as parseHtml } from 'node-html-parser';
import logger from '../utils/logger.js';
import platformMarketplaceNewsRepo from '../repositories/platform_marketplace_news.repository.pg.js';

const FETCH_TIMEOUT_MS = 25_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ERP-PlatformNews/1.0; +https://localhost) AppleWebKit/537.36';

const API_KEYWORDS =
  /\b(api|seller\s*api|partner\s*api|endpoint|webhook|метод|метода|методов|токен|устарел|deprecate|отключ|changelog|openapi|swagger|push-уведомл|рейт-?лимит|rate\s*limit)\b/i;

const MAJOR_KEYWORDS =
  /\b(комисс|тариф|логистик|штраф|рейтинг|fbo|fbs|fby|склад|отгрузк|поставк|этикетк|scanit|акци)\w*/i;

/** Источники, целиком посвящённые API — пропускаем без доп. фильтра. */
const API_ONLY_SOURCES = new Set(['ozon', 'wildberries', 'yandex']);

const MONTHS_RU = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    // Ссылки: «текст (url)», если текст ≠ url
    .replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const label = String(inner)
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
      const url = String(href || '').trim();
      if (!url) return label;
      if (!label || label === url) return url;
      return `${label} (${url})`;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Текст самого поста, не цитаты reply.
 * В t.me/s HTML у ответов первый .tgme_widget_message_text — в блоке reply.
 */
export function getMainTelegramMessageTextEl(msg) {
  if (!msg) return null;
  const texts = msg.querySelectorAll('.tgme_widget_message_text');
  if (!texts.length) return null;
  for (const el of texts) {
    try {
      if (typeof el.closest === 'function' && el.closest('.tgme_widget_message_reply')) continue;
    } catch {
      // ignore
    }
    // Fallback без closest: обойти родителей
    let p = el.parentNode;
    let inReply = false;
    while (p && p !== msg) {
      const cls = typeof p.getAttribute === 'function' ? String(p.getAttribute('class') || '') : '';
      if (cls.includes('tgme_widget_message_reply')) {
        inReply = true;
        break;
      }
      p = p.parentNode;
    }
    if (!inReply) return el;
  }
  // Если все тексты внутри reply — берём последний (обычно сам ответ)
  return texts[texts.length - 1] || null;
}

function truncate(text, max = 600) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trim()}…`;
}

/** Строка целиком — дата («11 сентября 2026», «01/29/2026»). */
const DATE_ONLY_LINE_RE =
  /^(\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(\s+\d{4})?|\d{1,2}[./]\d{1,2}[./]\d{2,4}|january|february|march|april|may|june|july|august|september|october|november|december)\s*$/i;

/** Дата в начале строки перед текстом («11 сентября 2026 /v1/...»). */
const LEADING_DATE_RE =
  /^(\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(\s+\d{4})?|\d{1,2}[./]\d{1,2}[./]\d{2,4})\s*([—\-–:]\s*|\s+)/i;

/**
 * Убираем дату из текста — она уже показывается отдельно в UI.
 */
export function stripLeadingDate(text) {
  const original = String(text || '').trim();
  const lines = original
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  while (lines.length && DATE_ONLY_LINE_RE.test(lines[0])) {
    lines.shift();
  }
  // Весь текст был только датой — убираем её (дата уже в UI).
  if (!lines.length) return '';
  lines[0] = lines[0].replace(LEADING_DATE_RE, '');
  return lines.filter(Boolean).join('\n').trim();
}

function titleFromBody(body) {
  const cleaned = stripLeadingDate(body);
  const lines = String(cleaned || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return 'Обновление';
  // В заголовке не дублируем длинные URL — они остаются в полном тексте
  let first = lines[0].replace(/\s*\(https?:\/\/[^)\s]+\)/gi, '').trim();
  if (!first) first = lines[0];
  if (first.length <= 140) return first;
  return `${first.slice(0, 137).trim()}…`;
}

export function isRelevantNews({ source, title, summary }) {
  if (API_ONLY_SOURCES.has(String(source || '').toLowerCase())) return true;
  const text = `${title || ''} ${summary || ''}`;
  return API_KEYWORDS.test(text) || MAJOR_KEYWORDS.test(text);
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,text/markdown,text/plain,*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.statusCode = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Парсинг публичной HTML-ленты Telegram (t.me/s/...).
 */
export function parseTelegramChannelHtml(html, { source, channelUrl }) {
  const root = parseHtml(html || '');
  const messages = root.querySelectorAll('.tgme_widget_message[data-post]');
  const items = [];

  for (const msg of messages) {
    const dataPost = msg.getAttribute('data-post') || '';
    if (!dataPost) continue;
    const externalId = dataPost.includes('/') ? dataPost.split('/').pop() : dataPost;

    const textEl = getMainTelegramMessageTextEl(msg);
    const body = stripHtml(textEl ? textEl.innerHTML : '');
    if (!body) continue;

    const dateEl = msg.querySelector('time[datetime]') || msg.querySelector('[datetime]');
    const datetime = dateEl?.getAttribute?.('datetime') || null;
    let publishedAt = null;
    if (datetime) {
      const d = new Date(datetime);
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    const url = `https://t.me/${dataPost}`;
    const displayBody = stripLeadingDate(body) || body;
    const title = titleFromBody(body);
    items.push({
      source,
      externalId: String(externalId),
      title,
      body: displayBody,
      summary: truncate(displayBody, 400),
      url,
      publishedAt,
      tags: ['api'],
      raw: { channel: channelUrl, dataPost },
    });
  }

  return items;
}

async function fetchOzonTelegram() {
  const channelUrl = 'https://t.me/s/OzonSellerAPI';
  const html = await fetchText(channelUrl);
  return parseTelegramChannelHtml(html, { source: 'ozon', channelUrl });
}

async function fetchWbTelegram() {
  const channelUrl = 'https://t.me/s/wb_api_notifications';
  const html = await fetchText(channelUrl);
  return parseTelegramChannelHtml(html, { source: 'wildberries', channelUrl });
}

/**
 * Парсинг markdown changelog Яндекс Маркета.
 * Секции вида: ### 6 октября {#06-10-26}
 */
export function parseYandexChangelogMarkdown(md) {
  const text = String(md || '');
  const items = [];
  const sectionRe = /^###\s+(.+?)\s*\{#(\d{2}-\d{2}-\d{2})\}\s*$/gm;
  const matches = [...text.matchAll(sectionRe)];

  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const heading = (m[1] || '').trim();
    const anchor = m[2];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const bodyRaw = text.slice(start, end).trim();
    const body = bodyRaw
      .replace(/\{\%[\s\S]*?\%\}/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/#\|\s*\|[\s\S]*?\|\|/g, ' ')
      .replace(/\|/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    const [dd, mm, yy] = anchor.split('-').map((x) => Number(x));
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    let publishedAt = null;
    if (dd && mm && year) {
      const d = new Date(Date.UTC(year, mm - 1, dd, 12, 0, 0));
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    // Fallback: «6 октября» + год из published year
    if (!publishedAt) {
      const hm = heading.match(/^(\d{1,2})\s+(\S+)/);
      if (hm && MONTHS_RU[hm[2]]) {
        const d = new Date(Date.UTC(year || new Date().getUTCFullYear(), MONTHS_RU[hm[2]] - 1, Number(hm[1]), 12));
        if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
      }
    }

    const headingClean = stripLeadingDate(heading);
    const bodyFull = body || headingClean || heading;
    items.push({
      source: 'yandex',
      externalId: `changelog-${anchor}`,
      title: headingClean ? `Яндекс Маркет API — ${headingClean}` : 'Яндекс Маркет API',
      body: bodyFull,
      summary: truncate(bodyFull, 400),
      url: `https://yandex.ru/dev/market/partner-api/doc/ru/changelog/all#${anchor}`,
      publishedAt,
      tags: ['api', 'changelog'],
      raw: { anchor, heading },
    });
  }

  return items;
}

async function fetchYandexChangelog() {
  const url = 'https://yandex.ru/dev/market/partner-api/doc/ru/changelog/all.md';
  const md = await fetchText(url);
  // Берём не всю историю — последние ~40 секций достаточно для ленты
  const all = parseYandexChangelogMarkdown(md);
  return all.slice(0, 40);
}

const ADAPTERS = [
  { name: 'ozon', fetch: fetchOzonTelegram },
  { name: 'wildberries', fetch: fetchWbTelegram },
  { name: 'yandex', fetch: fetchYandexChangelog },
];

/**
 * Синхронизация всех источников. Ошибка одного не роняет остальные.
 */
export async function syncMarketplaceNews() {
  const bySource = {};
  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const adapter of ADAPTERS) {
    const stats = { fetched: 0, relevant: 0, inserted: 0, updated: 0, error: null };
    try {
      const items = await adapter.fetch();
      stats.fetched = items.length;
      for (const item of items) {
        if (!isRelevantNews(item)) continue;
        stats.relevant += 1;
        const { inserted: wasInsert } = await platformMarketplaceNewsRepo.upsertItem(item);
        if (wasInsert) {
          stats.inserted += 1;
          inserted += 1;
        } else {
          stats.updated += 1;
          updated += 1;
        }
      }
      logger.info('[PlatformMarketplaceNews] source synced', {
        source: adapter.name,
        ...stats,
      });
    } catch (err) {
      stats.error = err?.message || String(err);
      errors.push({ source: adapter.name, message: stats.error });
      logger.warn('[PlatformMarketplaceNews] source failed', {
        source: adapter.name,
        error: stats.error,
      });
    }
    bySource[adapter.name] = stats;
  }

  return { ok: errors.length < ADAPTERS.length, inserted, updated, bySource, errors };
}

export async function listMarketplaceNews(params) {
  return platformMarketplaceNewsRepo.list(params);
}

export async function getMarketplaceNewsById(id, userId) {
  return platformMarketplaceNewsRepo.getById(id, userId);
}

export async function markMarketplaceNewsRead(newsId, userId) {
  return platformMarketplaceNewsRepo.markRead(newsId, userId);
}

export async function markAllMarketplaceNewsRead(userId, opts) {
  return platformMarketplaceNewsRepo.markAllRead(userId, opts);
}

export default {
  syncMarketplaceNews,
  listMarketplaceNews,
  getMarketplaceNewsById,
  markMarketplaceNewsRead,
  markAllMarketplaceNewsRead,
  isRelevantNews,
  stripLeadingDate,
  getMainTelegramMessageTextEl,
  parseTelegramChannelHtml,
  parseYandexChangelogMarkdown,
};
