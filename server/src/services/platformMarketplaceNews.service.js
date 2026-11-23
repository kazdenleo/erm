/**
 * Автосбор новостей маркетплейсов для супер-админа.
 *
 * Источники API:
 * - Ozon: https://t.me/s/OzonSellerAPI
 * - Wildberries: https://t.me/s/wb_api_notifications
 * - Яндекс Маркет: Partner API changelog (markdown)
 *
 * Источники операционных новостей (тарифы, условия, логистика):
 * - Ozon: https://t.me/s/ozonmarketplace
 * - Wildberries: https://t.me/s/wbsellerofficial
 * - Яндекс Маркет: https://t.me/s/market_marketplace
 */

import fetch from 'node-fetch';
import { parse as parseHtml } from 'node-html-parser';
import logger from '../utils/logger.js';
import { getFetchProxyAgent } from '../utils/fetchAgent.js';
import platformMarketplaceNewsRepo from '../repositories/platform_marketplace_news.repository.pg.js';

const FETCH_TIMEOUT_MS = 25_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ERP-PlatformNews/1.0; +https://localhost) AppleWebKit/537.36';

/** Граница слова с учётом кириллицы (\b в JS — только ASCII). */
const WORD_START = '(?<![\\p{L}\\p{N}_])';
const WORD_TAIL = '[\\p{L}\\p{N}_]*';

const API_KEYWORDS = new RegExp(
  `${WORD_START}(api|seller\\s*api|partner\\s*api|endpoint|webhook|метод|метода|методов|токен|устарел|deprecate|отключ|changelog|openapi|swagger|push-уведомл|рейт-?лимит|rate\\s*limit)${WORD_TAIL}`,
  'iu'
);

/** Сильный сигнал: тарифы/условия/штрафы — перекрывает маркетинговый «шум» в том же посте. */
const OPS_STRONG = new RegExp(
  `${WORD_START}(` +
    [
      'комисс',
      'тариф',
      'штраф',
      'оферт',
      'договор',
      'льгот',
      'условия\\s+работ',
      'плат[аы]\\s+за\\s+(продаж|хранен|размещен|логистик|доставк)',
      'стоимост[ьи]\\s+(логистик|хранен|размещен|доставк|приёмк)',
      'индекс\\s+качеств',
      'средн[\\p{L}\\p{N}_]*\\s+мил',
      'невыкуп',
      'утилиз',
      'балл(?:ы|ов)?\\s+за\\s+скидк',
      'бесплатн[\\p{L}\\p{N}_]*\\s+размещен',
    ].join('|') +
    `)${WORD_TAIL}`,
  'iu'
);

/**
 * Операционно важные изменения (тарифы, условия, логистика, штрафы).
 * Без «голой» логистики/FBS — иначе в ленту попадает маркетинг seller-каналов.
 */
const OPS_KEYWORDS = new RegExp(
  `${WORD_START}(` +
    [
      'комисс',
      'тариф',
      'штраф',
      'оферт',
      'договор',
      'льгот',
      'условия\\s+работ',
      'плат[аы]\\s+за\\s+(продаж|хранен|размещен|логистик|доставк)',
      'стоимост[ьи]\\s+(логистик|хранен|размещен|доставк|приёмк)',
      'изменен[ияею]\\s+(?:в\\s+)?(?:тариф|комисс|логистик|услов|оферт)',
      'обновлен[ияею]\\s+(?:тариф|комисс|логистик|услов|оферт)',
      'тариф[\\p{L}\\p{N}_]*\\s+логистик',
      'логистическ[\\p{L}\\p{N}_]*\\s+тариф',
      'хранен[ияе]\\s+(?:товар|FBO|на\\s+склад)',
      'размещен[ияе]\\s+(?:товар|карт|на\\s+площадк)',
      'невыкуп',
      'утилиз',
      'кросс-?докинг',
      'средн[\\p{L}\\p{N}_]*\\s+мил',
      'индекс\\s+качеств',
      'наценк',
      'вознагражден',
      'балл(?:ы|ов)?\\s+за\\s+скидк',
      'бесплатн[\\p{L}\\p{N}_]*\\s+размещен',
      'время\\s+на\\s+отгрузк',
      'срок(?:и|ов)?\\s+(?:хранени|отгрузк|поставк|приёмк)',
      'график\\s+работ[ыа]?(?:\\s+маркет|\\s+СЦ|\\s+склад|\\s+пункт)?',
      'приёмк[аи]\\s+(?:товар|отгруз|в\\s+СЦ|на\\s+склад)',
      'ярлык(?:ами|ов|и)?\\s+для\\s+(?:FBS|FBO|DBS|заказ)',
      'этикетк[аиу]\\s+для\\s+(?:FBS|FBO|DBS|заказ|отгруз)',
    ].join('|') +
    `)${WORD_TAIL}`,
  'iu'
);

/** Маркетинг / дайджесты seller-каналов — не для пользовательской ленты. */
const OPS_NOISE = new RegExp(
  `${WORD_START}(` +
    [
      'вебинар',
      'конкурс',
      'дайджест',
      'мероприят',
      'подкаст',
      'мастер-?класс',
      'регистрац(?:ия|ии|ию)',
      'приглашаем',
      'бестселлер',
      'распродаж',
      'чёрн(?:ая|ой)\\s+пятниц',
      'как\\s+(?:разобраться|продавцу|использовать|на\\s+самом\\s+деле)',
      'стабильный\\s+рост',
      'спрос\\s+в',
      'успейте\\s+записаться',
      'маркет\\s+ai',
      'спрашиваете\\s+вы',
      'всё,?\\s+что\\s+вы\\s+могли\\s+пропустить',
      'принимать\\s+более\\s+крупн',
      'пополняйте\\s+остатк',
      'выплаты\\s+сегодня',
    ].join('|') +
    `)${WORD_TAIL}`,
  'iu'
);

/** Тег api без ops — канал целиком про API, без доп. фильтра. */
function isApiFeed(tags) {
  const t = Array.isArray(tags) ? tags.map((x) => String(x).toLowerCase()) : [];
  return t.includes('api') && !t.includes('ops');
}

function isOpsFeed(tags) {
  const t = Array.isArray(tags) ? tags.map((x) => String(x).toLowerCase()) : [];
  return t.includes('ops');
}

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

export function isRelevantNews({ source: _source, title, summary, body, tags }) {
  // Чистые API-ленты пропускаем целиком; seller-каналы — только тарифы/условия.
  if (isApiFeed(tags)) return true;
  const text = `${title || ''} ${summary || ''} ${body || ''}`;
  if (isOpsFeed(tags)) {
    const titleText = String(title || '');
    // Маркетинг в заголовке — отбрасываем, даже если в summary/body есть «льготы».
    if (OPS_NOISE.test(titleText) && !OPS_STRONG.test(titleText)) return false;
    if (OPS_NOISE.test(text) && !OPS_STRONG.test(text)) return false;
    return OPS_KEYWORDS.test(text);
  }
  return API_KEYWORDS.test(text) || OPS_KEYWORDS.test(text);
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const agent = getFetchProxyAgent();
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
      ...(agent ? { agent } : {}),
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

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function rssField(block, tag) {
  const cdata = String(block || '').match(
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i')
  );
  if (cdata) return cdata[1] || '';
  const plain = String(block || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return plain ? plain[1] || '' : '';
}

/**
 * RSS-лента Telegram (fallback, когда t.me с VPS недоступен).
 * @param {{ source: string, channelUrl: string, tags?: string[], externalIdPrefix?: string|null }} opts
 */
function atomLinkHref(block) {
  const m = String(block || '').match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  return m ? m[1] : '';
}

export function parseTelegramRssXml(xml, { source, channelUrl, tags = ['api'], externalIdPrefix = null }) {
  const items = [];
  const tagList = Array.isArray(tags) && tags.length ? tags : ['api'];
  const raw = String(xml || '');
  const blocks = [
    ...[...raw.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]),
    ...[...raw.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]),
  ];

  for (const block of blocks) {
    const link = String(
      rssField(block, 'link') || atomLinkHref(block) || rssField(block, 'guid') || rssField(block, 'id') || ''
    ).trim();
    const msgIdMatch = link.match(/t\.me\/[^/\s]+\/(\d+)/i);
    const msgId = msgIdMatch?.[1] || (link.includes('/') ? link.split('/').pop() : '');
    if (!msgId) continue;

    const bodyHtml = decodeXmlEntities(
      rssField(block, 'description') || rssField(block, 'content') || rssField(block, 'summary')
    );
    const body = stripHtml(bodyHtml);
    if (!body) continue;

    let publishedAt = null;
    const pubDate = String(
      rssField(block, 'pubDate') || rssField(block, 'published') || rssField(block, 'updated') || ''
    ).trim();
    if (pubDate) {
      const d = new Date(pubDate);
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    const displayBody = stripLeadingDate(body) || body;
    const title = titleFromBody(body) || stripHtml(decodeXmlEntities(rssField(block, 'title'))) || 'Обновление';
    const externalId = externalIdPrefix ? `${externalIdPrefix}${msgId}` : String(msgId);
    items.push({
      source,
      externalId,
      title,
      body: displayBody,
      summary: truncate(displayBody, 400),
      url: link.startsWith('http') ? link : `https://t.me/${link}`,
      publishedAt,
      tags: tagList,
      raw: { channel: channelUrl, via: 'rss', link },
    });
  }

  return items;
}

/**
 * t.me HTML, при недоступности — RSS (TELEGRAM_RSS_BASE, по умолчанию rsshub.rssforever.com).
 */
async function fetchTelegramChannel({ username, source, tags = ['api'], externalIdPrefix = null }) {
  const channelUrl = `https://t.me/s/${username}`;
  try {
    const html = await fetchText(channelUrl);
    const items = parseTelegramChannelHtml(html, { source, channelUrl, tags, externalIdPrefix });
    if (items.length > 0) return items;
    logger.warn('[PlatformMarketplaceNews] t.me HTML empty, trying RSS', { username });
  } catch (e) {
    logger.warn('[PlatformMarketplaceNews] t.me fetch failed, trying RSS', {
      username,
      error: e?.message || String(e),
    });
  }

  const bases = String(
    process.env.TELEGRAM_RSS_BASE ||
      'https://rsshub.rssforever.com/telegram/channel,https://rss-bridge.org/bridge01/?action=display&bridge=Telegram&username={u}&format=Atom'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let lastErr = null;
  for (const baseRaw of bases) {
    const rssUrl = baseRaw.includes('{u}')
      ? baseRaw.replaceAll('{u}', encodeURIComponent(username))
      : `${baseRaw.replace(/\/$/, '')}/${encodeURIComponent(username)}`;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 1500));
        const xml = await fetchText(rssUrl);
        const items = parseTelegramRssXml(xml, { source, channelUrl, tags, externalIdPrefix });
        if (items.length > 0) return items;
        lastErr = new Error(`RSS empty for ${rssUrl}`);
      } catch (e) {
        lastErr = e;
        logger.warn('[PlatformMarketplaceNews] RSS attempt failed', {
          username,
          rssUrl,
          attempt,
          error: e?.message || String(e),
        });
      }
    }
  }
  throw lastErr || new Error(`Telegram RSS unavailable for ${username}`);
}

/**
 * Парсинг публичной HTML-ленты Telegram (t.me/s/...).
 * @param {{ source: string, channelUrl: string, tags?: string[], externalIdPrefix?: string|null }} opts
 */
export function parseTelegramChannelHtml(html, { source, channelUrl, tags = ['api'], externalIdPrefix = null }) {
  const root = parseHtml(html || '');
  const messages = root.querySelectorAll('.tgme_widget_message[data-post]');
  const items = [];
  const tagList = Array.isArray(tags) && tags.length ? tags : ['api'];

  for (const msg of messages) {
    const dataPost = msg.getAttribute('data-post') || '';
    if (!dataPost) continue;
    const msgId = dataPost.includes('/') ? dataPost.split('/').pop() : dataPost;
    // Префикс нужен, чтобы seller-канал не конфликтовал с API по UNIQUE(source, external_id).
    const externalId = externalIdPrefix ? `${externalIdPrefix}${msgId}` : String(msgId);

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
      externalId,
      title,
      body: displayBody,
      summary: truncate(displayBody, 400),
      url,
      publishedAt,
      tags: tagList,
      raw: { channel: channelUrl, dataPost },
    });
  }

  return items;
}

async function fetchOzonApiTelegram() {
  return fetchTelegramChannel({ username: 'OzonSellerAPI', source: 'ozon', tags: ['api'] });
}

async function fetchWbApiTelegram() {
  return fetchTelegramChannel({
    username: 'wb_api_notifications',
    source: 'wildberries',
    tags: ['api'],
  });
}

async function fetchOzonSellerTelegram() {
  return fetchTelegramChannel({
    username: 'ozonmarketplace',
    source: 'ozon',
    tags: ['ops'],
    externalIdPrefix: 'seller-',
  });
}

async function fetchWbSellerTelegram() {
  return fetchTelegramChannel({
    username: 'wbsellerofficial',
    source: 'wildberries',
    tags: ['ops'],
    externalIdPrefix: 'seller-',
  });
}

async function fetchYandexSellerTelegram() {
  return fetchTelegramChannel({
    username: 'market_marketplace',
    source: 'yandex',
    tags: ['ops'],
    externalIdPrefix: 'seller-',
  });
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
  { name: 'ozon-api', fetch: fetchOzonApiTelegram },
  { name: 'ozon-ops', fetch: fetchOzonSellerTelegram },
  { name: 'wildberries-api', fetch: fetchWbApiTelegram },
  { name: 'wildberries-ops', fetch: fetchWbSellerTelegram },
  { name: 'yandex-api', fetch: fetchYandexChangelog },
  { name: 'yandex-ops', fetch: fetchYandexSellerTelegram },
];

/**
 * Удаляет ранее сохранённые ops-посты, которые больше не проходят строгий фильтр
 * (маркетинг, дайджесты, «советы продавцу»).
 */
export async function pruneIrrelevantOpsNews() {
  const rows = await platformMarketplaceNewsRepo.listOpsForPrune({ limit: 1000 });
  const toDelete = [];
  for (const row of rows) {
    if (
      !isRelevantNews({
        source: row.source,
        title: row.title,
        summary: row.summary,
        body: row.body,
        tags: row.tags,
      })
    ) {
      toDelete.push(row.id);
    }
  }
  if (!toDelete.length) return { checked: rows.length, deleted: 0 };
  const { deleted } = await platformMarketplaceNewsRepo.deleteByIds(toDelete);
  logger.info('[PlatformMarketplaceNews] pruned irrelevant ops', {
    checked: rows.length,
    deleted,
  });
  return { checked: rows.length, deleted };
}

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

  let pruned = { checked: 0, deleted: 0 };
  try {
    pruned = await pruneIrrelevantOpsNews();
  } catch (err) {
    errors.push({ source: 'ops-prune', message: err?.message || String(err) });
    logger.warn('[PlatformMarketplaceNews] ops prune failed', {
      error: err?.message || String(err),
    });
  }

  return {
    ok: errors.length < ADAPTERS.length,
    inserted,
    updated,
    pruned,
    bySource,
    errors,
  };
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
  pruneIrrelevantOpsNews,
  listMarketplaceNews,
  getMarketplaceNewsById,
  markMarketplaceNewsRead,
  markAllMarketplaceNewsRead,
  isRelevantNews,
  stripLeadingDate,
  getMainTelegramMessageTextEl,
  parseTelegramChannelHtml,
  parseTelegramRssXml,
  parseYandexChangelogMarkdown,
};
