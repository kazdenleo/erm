/**
 * Парсеры публичных карточек конкурентов (WB / Ozon / YM).
 * Не официальный Seller API — витрина/публичные JSON.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  Accept: 'application/json,text/html,*/*',
  'User-Agent': UA,
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

export const COMPETITOR_MARKETPLACES = ['wb', 'ym'];
export const MAX_COMPETITORS_PER_MARKETPLACE = 5;

/**
 * @param {string} rawUrl
 * @returns {{ marketplace: 'wb'|'ym', externalId: string|null, url: string }}
 */
export function parseCompetitorUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    const err = new Error('Укажите ссылку на товар');
    err.statusCode = 400;
    throw err;
  }
  let urlObj;
  try {
    urlObj = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    const err = new Error('Некорректная ссылка');
    err.statusCode = 400;
    throw err;
  }

  const host = urlObj.hostname.replace(/^www\./, '').toLowerCase();
  const href = urlObj.toString();

  if (host.includes('wildberries.ru') || host === 'wb.ru') {
    const m =
      href.match(/\/catalog\/(\d+)/i) ||
      href.match(/[?&]nm=(\d+)/i) ||
      href.match(/\/(\d{6,})(?:\/|$|\?)/);
    return { marketplace: 'wb', externalId: m?.[1] || null, url: href };
  }

  if (host.includes('ozon.ru')) {
    const err = new Error(
      'Мониторинг Ozon временно отключён (антибот). Сейчас поддерживаются Wildberries и Яндекс.Маркет.'
    );
    err.statusCode = 400;
    throw err;
  }

  if (host.includes('market.yandex.') || host.includes('pokupki.market.yandex.')) {
    const m =
      href.match(/\/card\/[^/]+\/(\d+)/i) ||
      href.match(/\/product--[^/]+\/(\d+)/i) ||
      href.match(/[?&](?:sku|productId|modelid)=(\d+)/i);
    return { marketplace: 'ym', externalId: m?.[1] || null, url: href };
  }

  const err = new Error('Поддерживаются ссылки Wildberries и Яндекс.Маркет');
  err.statusCode = 400;
  throw err;
}

async function fetchText(url, { headers = {}, timeoutMs = 20000, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { ...DEFAULT_HEADERS, ...headers },
      redirect,
      signal: controller.signal,
    });
    const text = await r.text();
    return { status: r.status, text, headers: r.headers, ok: r.ok };
  } finally {
    clearTimeout(t);
  }
}

/**
 * curl обходит Angie WAF на u-card.wb.ru (Node undici часто получает 403).
 */
async function fetchTextViaCurl(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const args = [
    '-sS',
    '-L',
    '--compressed',
    '--max-time',
    String(Math.max(3, Math.ceil(timeoutMs / 1000))),
    '-A',
    UA,
    '-w',
    '\n__HTTP_STATUS__:%{http_code}',
  ];
  const merged = { ...DEFAULT_HEADERS, ...headers };
  for (const [k, v] of Object.entries(merged)) {
    if (v == null || k.toLowerCase() === 'user-agent') continue;
    args.push('-H', `${k}: ${v}`);
  }
  args.push(url);
  try {
    const { stdout } = await execFileAsync('curl', args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs + 2000,
    });
    const marker = '\n__HTTP_STATUS__:';
    const idx = stdout.lastIndexOf(marker);
    if (idx < 0) return { status: 0, text: stdout, ok: false };
    const text = stdout.slice(0, idx);
    const status = parseInt(stdout.slice(idx + marker.length).trim(), 10) || 0;
    return { status, text, ok: status >= 200 && status < 300 };
  } catch {
    return { status: 0, text: '', ok: false };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Актуальная карта vol → basket-XX (расширяется по мере роста nmId). */
function wbBasketHostCandidates(vol) {
  // Исторические диапазоны + запас для высоких vol (напр. 5250 → 28)
  const ranges = [
    [0, 143, 1],
    [144, 287, 2],
    [288, 431, 3],
    [432, 719, 4],
    [720, 1007, 5],
    [1008, 1061, 6],
    [1062, 1115, 7],
    [1116, 1169, 8],
    [1170, 1313, 9],
    [1314, 1601, 10],
    [1602, 1655, 11],
    [1656, 1919, 12],
    [1920, 2045, 13],
    [2046, 2189, 14],
    [2190, 2405, 15],
    [2406, 2621, 16],
    [2622, 2837, 17],
    [2838, 3053, 18],
    [3054, 3269, 19],
    [3270, 3485, 20],
    [3486, 3701, 21],
    [3702, 3917, 22],
    [3918, 4133, 23],
    [4134, 4349, 24],
    [4350, 4565, 25],
    [4566, 4781, 26],
    [4782, 4997, 27],
    [4998, 5213, 28],
    [5214, 5429, 29],
    [5430, 5645, 30],
    [5646, 5861, 31],
    [5862, 6077, 32],
    [6078, 6293, 33],
    [6294, 6509, 34],
    [6510, 6725, 35],
    [6726, 6941, 36],
    [6942, 7157, 37],
    [7158, 7373, 38],
    [7374, 7589, 39],
    [7590, 7805, 40],
  ];
  let primary = 28;
  for (const [from, to, host] of ranges) {
    if (vol >= from && vol <= to) {
      primary = host;
      break;
    }
  }
  if (vol > 7805) {
    // грубая экстраполяция ~216 vol на хост
    primary = Math.min(40, Math.max(1, 28 + Math.floor((vol - 5213) / 216)));
  }
  const set = new Set([primary, primary - 1, primary + 1, primary - 2, primary + 2]);
  return [...set].filter((n) => n >= 1 && n <= 40).map((n) => String(n).padStart(2, '0'));
}

/** WB basket card.json — быстрый lookup по карте vol, без перебора 40 хостов. */
async function fetchWbBasketCard(nmId) {
  const nm = Number(nmId);
  if (!Number.isFinite(nm) || nm <= 0) return null;
  const vol = Math.floor(nm / 1e5);
  const part = Math.floor(nm / 1e3);
  for (const host of wbBasketHostCandidates(vol)) {
    const url = `https://basket-${host}.wbbasket.ru/vol${vol}/part${part}/${nm}/info/ru/card.json`;
    try {
      const r = await fetchText(url, { timeoutMs: 2500 });
      if (r.status === 200) {
        try {
          return JSON.parse(r.text);
        } catch {
          return null;
        }
      }
    } catch {
      /* next */
    }
  }
  return null;
}

async function fetchWbFeedbacks(nmId) {
  const urls = [
    `https://feedbacks1.wb.ru/feedbacks/v2/${nmId}`,
    `https://feedbacks2.wb.ru/feedbacks/v2/${nmId}`,
    `https://feedbacks1.wb.ru/feedbacks/v1/${nmId}`,
    `https://feedbacks2.wb.ru/feedbacks/v1/${nmId}`,
  ];
  for (const url of urls) {
    try {
      let r = await fetchText(url, {
        headers: {
          Accept: 'application/json',
          Origin: 'https://www.wildberries.ru',
          Referer: `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`,
        },
        timeoutMs: 10000,
      });
      if (r.status === 403 || r.status === 0 || (r.status === 200 && r.text.trim().startsWith('<'))) {
        r = await fetchTextViaCurl(url, {
          headers: {
            Accept: 'application/json',
            Origin: 'https://www.wildberries.ru',
            Referer: `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`,
          },
          timeoutMs: 10000,
        });
      }
      if (r.status !== 200) continue;
      try {
        const data = JSON.parse(r.text);
        if (data && (data.valuation != null || data.feedbackCount != null || Array.isArray(data.feedbacks))) {
          return data;
        }
      } catch {
        /* next */
      }
    } catch {
      /* next */
    }
  }
  return null;
}

function pickBestRating(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickBestReviewsCount(...vals) {
  let best = null;
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    if (best == null || n > best) best = n;
  }
  return best;
}

async function fetchWbSearchProduct(query, nmId) {
  const url =
    `https://search.wb.ru/exactmatch/ru/common/v7/search?appType=1&curr=rub&dest=-1257786` +
    `&query=${encodeURIComponent(query)}&resultset=catalog&sort=popular&spp=30&suppressSpellcheck=false`;
  const r = await fetchText(url, {
    headers: {
      Origin: 'https://www.wildberries.ru',
      Referer: 'https://www.wildberries.ru/',
    },
  });
  if (r.status === 429) {
    await sleep(1500);
    const r2 = await fetchText(url, {
      headers: {
        Origin: 'https://www.wildberries.ru',
        Referer: 'https://www.wildberries.ru/',
      },
    });
    if (r2.status !== 200) return null;
    return pickWbSearchHit(r2.text, nmId);
  }
  if (r.status !== 200) return null;
  return pickWbSearchHit(r.text, nmId);
}

function pickWbSearchHit(text, nmId) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const products = Array.isArray(data?.products) ? data.products : [];
  const hit = products.find((p) => String(p.id) === String(nmId)) || null;
  if (!hit) return null;
  const priceKopecks =
    hit.sizes?.[0]?.price?.product ?? hit.salePriceU ?? hit.priceU ?? null;
  return {
    title: hit.name || null,
    price: priceKopecks != null ? Math.round(Number(priceKopecks) / 100) : null,
    rating: hit.reviewRating != null ? Number(hit.reviewRating) : hit.rating != null ? Number(hit.rating) : null,
    reviews_count:
      hit.feedbacks != null
        ? Number(hit.feedbacks)
        : hit.nmFeedbacks != null
          ? Number(hit.nmFeedbacks)
          : null,
  };
}

async function fetchWbCardDetail(nmId) {
  const nm = encodeURIComponent(String(nmId));
  const urls = [
    `https://u-card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${nm}`,
    `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${nm}`,
  ];
  const headers = {
    Origin: 'https://www.wildberries.ru',
    Referer: `https://www.wildberries.ru/catalog/${nm}/detail.aspx`,
    Accept: 'application/json',
  };

  const parseHit = (text) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    const products = Array.isArray(data?.products)
      ? data.products
      : Array.isArray(data?.data?.products)
        ? data.data.products
        : [];
    const hit = products.find((p) => String(p.id) === String(nmId)) || products[0] || null;
    if (!hit) return null;
    const priceKopecks =
      hit.sizes?.[0]?.price?.product ??
      hit.sizes?.[0]?.price?.basic ??
      hit.salePriceU ??
      hit.priceU ??
      null;
    return {
      title: hit.name || null,
      price: priceKopecks != null ? Math.round(Number(priceKopecks) / 100) : null,
      rating:
        hit.reviewRating != null
          ? Number(hit.reviewRating)
          : hit.nmReviewRating != null
            ? Number(hit.nmReviewRating)
            : hit.rating != null
              ? Number(hit.rating)
              : null,
      reviews_count:
        hit.feedbacks != null
          ? Number(hit.feedbacks)
          : hit.nmFeedbacks != null
            ? Number(hit.nmFeedbacks)
            : null,
    };
  };

  for (const url of urls) {
    try {
      let r = await fetchText(url, { headers, timeoutMs: 12000 });
      // Node undici часто ловит 403 от Angie на u-card — curl проходит
      if (r.status === 403 || r.status === 0 || (r.status === 200 && r.text.trim().startsWith('<'))) {
        r = await fetchTextViaCurl(url, { headers, timeoutMs: 12000 });
      }
      if (r.status !== 200) continue;
      const parsed = parseHit(r.text);
      if (parsed) return parsed;
    } catch {
      /* next endpoint */
    }
  }
  return null;
}

async function fetchWbPriceHistory(nmId) {
  const nm = Number(nmId);
  if (!Number.isFinite(nm) || nm <= 0) return null;
  const vol = Math.floor(nm / 1e5);
  const part = Math.floor(nm / 1e3);
  for (const host of wbBasketHostCandidates(vol)) {
    const url = `https://basket-${host}.wbbasket.ru/vol${vol}/part${part}/${nm}/info/price-history.json`;
    try {
      const r = await fetchText(url, { timeoutMs: 2500 });
      if (r.status !== 200) continue;
      let data;
      try {
        data = JSON.parse(r.text);
      } catch {
        continue;
      }
      if (!Array.isArray(data) || !data.length) continue;
      const last = data[data.length - 1];
      const rubKopecks = last?.price?.RUB;
      if (rubKopecks == null) continue;
      return Math.round(Number(rubKopecks) / 100);
    } catch {
      /* next */
    }
  }
  return null;
}

async function fetchWbCompetitor(externalId) {
  if (!externalId) {
    return { ok: false, error: 'Не удалось извлечь nmId из ссылки WB' };
  }

  // 1) Основной источник цены/рейтинга — u-card (search часто даёт 429)
  let fromCard = await fetchWbCardDetail(externalId);

  // 2) Название/vendor из basket card.json
  const basket = await fetchWbBasketCard(externalId);
  const vendor = basket?.vendor_code || null;
  const titleFromBasket = basket?.imt_name || null;

  // 3) Fallback: поиск (может быть rate-limit)
  let fromSearch = null;
  if (!fromCard?.price) {
    if (vendor) {
      fromSearch = await fetchWbSearchProduct(vendor, externalId);
    }
    if (!fromSearch) {
      fromSearch = await fetchWbSearchProduct(String(externalId), externalId);
    }
  }

  // 4) Отзывы/рейтинг: feedbacks API надёжнее search (часто отдаёт 0)
  const feedbacks = await fetchWbFeedbacks(externalId);
  const ratingFromFb =
    feedbacks?.valuation != null && feedbacks.valuation !== ''
      ? Number(feedbacks.valuation)
      : null;
  const reviewsFromFb =
    feedbacks?.feedbackCount != null
      ? Number(feedbacks.feedbackCount)
      : Array.isArray(feedbacks?.feedbacks)
        ? feedbacks.feedbacks.length
        : null;

  let title = fromCard?.title || fromSearch?.title || titleFromBasket;
  let price = fromCard?.price ?? fromSearch?.price ?? null;
  // Рейтинг/отзывы: берём лучшее из feedbacks + карточки (не доверяем нулю из search)
  let rating = pickBestRating(ratingFromFb, fromCard?.rating, fromSearch?.rating);
  let reviews_count = pickBestReviewsCount(
    reviewsFromFb,
    fromCard?.reviews_count,
    fromSearch?.reviews_count
  );

  // 5) Последний fallback цены — история (может быть чуть устаревшей)
  let warning = null;
  if (price == null) {
    const hist = await fetchWbPriceHistory(externalId);
    if (hist != null) {
      price = hist;
      warning = 'Цена взята из истории WB (актуальная витрина временно недоступна)';
    } else if (!fromCard) {
      warning = 'Цена WB временно недоступна (поиск ограничил запросы)';
    }
  }

  if (price == null && rating == null && reviews_count == null && !title) {
    return { ok: false, error: 'WB: не удалось получить данные карточки (лимит/антибот)' };
  }

  return {
    ok: true,
    title,
    price,
    rating: Number.isFinite(rating) ? rating : null,
    reviews_count: Number.isFinite(reviews_count) ? reviews_count : null,
    warning,
  };
}

/**
 * Ozon: публичный composer часто закрыт антиботом (challenge).
 * Пробуем JSON; при challenge — явная ошибка.
 */
async function fetchOzonCompetitor(externalId, pageUrl) {
  if (!externalId && !pageUrl) {
    return { ok: false, error: 'Не удалось извлечь ID товара Ozon из ссылки' };
  }
  const path = externalId ? `/product/${externalId}/` : null;
  const tryUrls = [];
  if (path) {
    tryUrls.push(
      `https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(path)}`
    );
  }
  if (pageUrl) {
    try {
      const u = new URL(pageUrl);
      tryUrls.push(
        `https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(u.pathname)}`
      );
    } catch {
      /* ignore */
    }
  }

  for (const apiUrl of tryUrls) {
    try {
      const r = await fetchText(apiUrl, {
        headers: { Referer: pageUrl || 'https://www.ozon.ru/', Accept: 'application/json' },
        redirect: 'manual',
        timeoutMs: 15000,
      });
      if (r.status === 307 || r.status === 302) {
        const loc = r.headers.get('location');
        if (loc) {
          const abs = loc.startsWith('http') ? loc : `https://www.ozon.ru${loc}`;
          const r2 = await fetchText(abs, {
            headers: { Referer: pageUrl || 'https://www.ozon.ru/', Accept: 'application/json' },
            redirect: 'manual',
            timeoutMs: 15000,
          });
          if (r2.status === 403 || r2.text.includes('challengeURL') || r2.text.includes('incidentId')) {
            return {
              ok: false,
              error: 'Ozon заблокировал запрос (антибот). Попробуйте позже или обновите вручную с другого IP.',
            };
          }
          if (r2.status === 200) {
            const parsed = parseOzonComposerJson(r2.text);
            if (parsed) return { ok: true, ...parsed };
          }
        }
      }
      if (r.status === 403 || r.text.includes('challengeURL')) {
        return {
          ok: false,
          error: 'Ozon заблокировал запрос (антибот). Попробуйте позже.',
        };
      }
      if (r.status === 200) {
        const parsed = parseOzonComposerJson(r.text);
        if (parsed) return { ok: true, ...parsed };
      }
    } catch (e) {
      return {
        ok: false,
        error: `Ozon: сеть/антибот (${e?.message || e})`,
      };
    }
  }
  return {
    ok: false,
    error:
      'Ozon заблокировал чтение карточки (антибот). Ссылку сохранить можно — обновление цены пока нестабильно с сервера.',
  };
}

function parseOzonComposerJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const widgetStates = data?.widgetStates || {};
  let title = null;
  let price = null;
  let rating = null;
  let reviews_count = null;

  for (const raw of Object.values(widgetStates)) {
    let w;
    try {
      w = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }
    if (!w || typeof w !== 'object') continue;
    if (!title && (w.title || w.name || w.cellTrackingInfo?.title)) {
      title = w.title || w.name || w.cellTrackingInfo?.title || null;
    }
    const p =
      w.price?.[0]?.price ??
      w.cardPrice?.price ??
      w.price?.price ??
      w.cellTrackingInfo?.price ??
      null;
    if (price == null && p != null) {
      const n = Number(String(p).replace(/[^\d.]/g, ''));
      if (Number.isFinite(n)) price = n;
    }
    const rt = w.rating ?? w.totalScore ?? w.cellTrackingInfo?.rating ?? null;
    if (rating == null && rt != null) {
      const n = Number(rt);
      if (Number.isFinite(n)) rating = n;
    }
    const rc =
      w.reviewsCount ??
      w.commentsCount ??
      w.reviewCount ??
      w.cellTrackingInfo?.reviewsCount ??
      null;
    if (reviews_count == null && rc != null) {
      const n = Number(rc);
      if (Number.isFinite(n)) reviews_count = n;
    }
  }

  // Deep scan fallback
  const blob = JSON.stringify(data);
  if (price == null) {
    const m = blob.match(/"cardPrice"\s*:\s*\{[^}]*"price"\s*:\s*"?(\d+)/);
    if (m) price = Number(m[1]);
  }
  if (rating == null) {
    const m = blob.match(/"totalScore"\s*:\s*"?([\d.]+)/);
    if (m) rating = Number(m[1]);
  }
  if (reviews_count == null) {
    const m = blob.match(/"reviewsCount"\s*:\s*"?(\d+)/);
    if (m) reviews_count = Number(m[1]);
  }

  if (price == null && rating == null && reviews_count == null && !title) return null;
  return { title, price, rating, reviews_count };
}

function extractYmProductsFromHtml(html) {
  const out = [];
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)].map(
    (m) => m[1]
  );
  for (const block of ld) {
    let j;
    try {
      j = JSON.parse(block);
    } catch {
      continue;
    }
    const nodes = Array.isArray(j) ? j : [j];
    for (const node of nodes) {
      if (node?.['@type'] === 'Product') out.push(node);
      if (node?.['@type'] === 'ItemList' && Array.isArray(node.itemListElement)) {
        for (const el of node.itemListElement) {
          if (el?.item?.['@type'] === 'Product') out.push(el.item);
        }
      }
    }
  }
  return out;
}

function ymProductToSnapshot(product) {
  if (!product) return null;
  const offers = product.offers;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  const price = offer?.price != null ? Number(offer.price) : null;
  const ar = product.aggregateRating;
  const rating = ar?.ratingValue != null ? Number(ar.ratingValue) : null;
  const reviews_count =
    ar?.reviewCount != null
      ? Number(ar.reviewCount)
      : ar?.ratingCount != null
        ? Number(ar.ratingCount)
        : null;
  return {
    title: product.name || null,
    price: Number.isFinite(price) ? price : null,
    rating: Number.isFinite(rating) ? rating : null,
    reviews_count: Number.isFinite(reviews_count) ? reviews_count : null,
    url: product.url || product['@id'] || null,
    sku: product.sku != null ? String(product.sku) : null,
  };
}

function isYmCaptchaHtml(html) {
  return /Вы не робот\?/i.test(html || '') || /captcha_smart/i.test(html || '');
}

async function fetchYmCompetitor(externalId, pageUrl) {
  const url = pageUrl || (externalId ? `https://market.yandex.ru/card/item/${externalId}` : null);
  if (!url) {
    return { ok: false, error: 'Не удалось извлечь ID товара YM из ссылки' };
  }

  const tryParseDirect = async (targetUrl) => {
    const r = await fetchText(targetUrl, {
      headers: { Accept: 'text/html', Referer: 'https://market.yandex.ru/' },
      timeoutMs: 25000,
    });
    if (r.status !== 200) return { error: `YM: HTTP ${r.status}` };
    if (isYmCaptchaHtml(r.text)) return { captcha: true };
    const products = extractYmProductsFromHtml(r.text);
    const hit =
      products.find((p) => {
        const idInUrl = String(p.url || p['@id'] || '');
        return externalId && idInUrl.includes(String(externalId));
      }) || products.find((p) => p['@type'] === 'Product') || null;
    const snap = ymProductToSnapshot(hit);
    if (snap && (snap.price != null || snap.rating != null || snap.title)) {
      return { snap };
    }
    // regex fallback on full HTML
    const priceM = r.text.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/);
    const ratingM =
      r.text.match(/"ratingValue"\s*:\s*"?([\d.]+)"?/) ||
      r.text.match(/"preciseRating"\s*:\s*"?([\d.]+)"?/);
    const reviewsM =
      r.text.match(/"reviewCount"\s*:\s*"?(\d+)"?/) ||
      r.text.match(/"ratingCount"\s*:\s*"?(\d+)"?/);
    const titleM = r.text.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (priceM || ratingM || reviewsM || titleM) {
      return {
        snap: {
          title: titleM?.[1] || null,
          price: priceM ? Number(priceM[1]) : null,
          rating: ratingM ? Number(ratingM[1]) : null,
          reviews_count: reviewsM ? Number(reviewsM[1]) : null,
        },
      };
    }
    return { empty: true };
  };

  try {
    const direct = await tryParseDirect(url);
    if (direct.snap) {
      return { ok: true, ...direct.snap };
    }

    // Карточки YM часто за капчей — берём данные из поисковой выдачи (LD+JSON ItemList)
    const slug =
      String(url).match(/\/card\/([^/]+)\//i)?.[1]?.replace(/-/g, ' ') ||
      String(url).match(/\/product--([^/]+)\//i)?.[1]?.replace(/-/g, ' ') ||
      '';
    const queries = [externalId, slug].filter(Boolean);
    for (const q of queries) {
      const searchUrl = `https://market.yandex.ru/search?text=${encodeURIComponent(q)}`;
      const r = await fetchText(searchUrl, {
        headers: { Accept: 'text/html', Referer: 'https://market.yandex.ru/' },
        timeoutMs: 25000,
      });
      if (r.status !== 200 || isYmCaptchaHtml(r.text)) continue;
      const products = extractYmProductsFromHtml(r.text);
      const hit =
        products.find((p) => {
          const idInUrl = String(p.url || p['@id'] || '');
          const sku = p.sku != null ? String(p.sku) : '';
          return (
            (externalId && (idInUrl.includes(String(externalId)) || sku === String(externalId))) ||
            (pageUrl && idInUrl && pageUrl.includes(idInUrl.replace('https://market.yandex.ru', '')))
          );
        }) || null;
      const snap = ymProductToSnapshot(hit);
      if (snap && snap.price != null) {
        return {
          ok: true,
          ...snap,
          warning:
            snap.rating == null
              ? 'YM: рейтинг/отзывы в поиске часто отсутствуют'
              : null,
        };
      }
    }

    if (direct.captcha) {
      return { ok: false, error: 'YM: карточка закрыта капчей, поиск тоже не дал совпадения' };
    }
    return { ok: false, error: 'YM: не удалось разобрать карточку' };
  } catch (e) {
    return { ok: false, error: `YM: ${e?.message || e}` };
  }
}

/**
 * @param {'ozon'|'wb'|'ym'} marketplace
 * @param {{ externalId?: string|null, url: string }} opts
 */
export async function fetchCompetitorSnapshot(marketplace, { externalId, url }) {
  if (marketplace === 'wb') return fetchWbCompetitor(externalId);
  if (marketplace === 'ym') return fetchYmCompetitor(externalId, url);
  if (marketplace === 'ozon') {
    return {
      ok: false,
      error: 'Мониторинг Ozon временно отключён',
    };
  }
  return { ok: false, error: `Неизвестный маркетплейс: ${marketplace}` };
}
