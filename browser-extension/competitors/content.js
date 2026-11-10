function parseMoney(text) {
  const raw = String(text || '').replace(/\u00a0/g, ' ');
  const m = raw.match(/(\d[\d\s]{0,12})(?:[.,](\d{1,2}))?\s*₽/);
  if (!m) return null;
  const n = Number(m[1].replace(/\s/g, '') + (m[2] ? `.${m[2]}` : ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function marketplace() {
  const host = location.hostname.replace(/^www\./, '');
  const path = location.pathname;
  if (host.includes('ozon.ru') && /\/product\//.test(path)) return 'ozon';
  if ((host.includes('wildberries.ru') || host === 'wb.ru') && /\/catalog\/\d+/.test(path)) return 'wb';
  if (host.includes('market.yandex.') && (/\/card\//.test(path) || /\/product--/.test(path))) return 'ym';
  return null;
}

function readJsonLd() {
  const out = { title: null, price: null, rating: null, reviews_count: null };
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(node.textContent || '');
    } catch {
      continue;
    }
    const list = [];
    const push = (item) => {
      if (!item || typeof item !== 'object') return;
      if (item['@type'] === 'Product') list.push(item);
      if (Array.isArray(item['@graph'])) item['@graph'].forEach(push);
      if (Array.isArray(item)) item.forEach(push);
    };
    push(data);
    for (const product of list) {
      if (!out.title && product.name) out.title = String(product.name);
      const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      const price = offer?.price ?? offer?.lowPrice;
      if (out.price == null && price != null && Number(price) > 0) out.price = Number(price);
      const ar = product.aggregateRating;
      if (ar?.ratingValue != null && out.rating == null) out.rating = Number(ar.ratingValue);
      const rc = ar?.reviewCount ?? ar?.ratingCount;
      if (rc != null && out.reviews_count == null) out.reviews_count = Number(rc);
    }
  }
  return out;
}

function textOf(selector) {
  const el = document.querySelector(selector);
  return el ? el.innerText || el.textContent || '' : '';
}

function readDom(mp) {
  const title = (document.querySelector('h1')?.innerText || '').trim() || null;
  let priceText = '';
  if (mp === 'ozon') priceText = textOf('[data-widget="webPrice"]');
  if (mp === 'wb') {
    priceText =
      textOf('.price-block__final-price') ||
      textOf('.priceBlockFinalPrice') ||
      textOf('[class*="priceBlockPrice"]');
  }
  if (mp === 'ym') {
    priceText =
      textOf('[data-auto="snippet-price-current"]') ||
      textOf('[data-auto="price-value"]') ||
      textOf('[data-zone-name="price"]');
  }
  return { title, price: parseMoney(priceText) };
}

function extract() {
  const mp = marketplace();
  if (!mp) return null;
  const ld = readJsonLd();
  const dom = readDom(mp);
  const price = ld.price || dom.price;
  if (price == null) return null;
  return {
    url: location.href,
    title: ld.title || dom.title,
    price,
    rating: Number.isFinite(ld.rating) ? ld.rating : null,
    reviews_count: Number.isFinite(ld.reviews_count) ? ld.reviews_count : null,
  };
}

function listingMarketplace() {
  const host = location.hostname.replace(/^www\./, '');
  if (host.includes('ozon.ru')) return 'ozon';
  if (host.includes('wildberries.ru') || host === 'wb.ru') return 'wb';
  if (host.includes('market.yandex.')) return 'ym';
  return null;
}

function isListingProductHref(mp, href) {
  if (mp === 'ozon') return /\/product\/[^/?#]*\d{5,}/.test(href);
  if (mp === 'wb') return /\/catalog\/[1-9]\d{4,}/.test(href);
  if (mp === 'ym') return /\/card\/[^/]+\/\d+/.test(href) || /\/product--[^/]+\/\d+/.test(href);
  return false;
}

function cleanCardUrl(href) {
  const u = new URL(href, location.origin);
  u.hash = '';
  u.search = '';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

function isBadgeLine(line) {
  return (
    line.length < 42 &&
    (/распродаж|цена что надо|осталось\s+\d|до\s+\d+\s+дн|балл|оригинал|хит|реклама|ozon банк|без ozon|шт\.?$/i.test(
      line
    ) ||
      /^\d+\s*%/.test(line))
  );
}

function cardLines(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function cardTitle(text) {
  const lines = cardLines(text).filter((line) => !line.includes('₽') && !isBadgeLine(line) && line.length > 8);
  if (!lines.length) return null;
  lines.sort((a, b) => b.length - a.length);
  return lines[0].slice(0, 180);
}

function parseStock(text) {
  const raw = String(text || '');
  if (/нет в наличии/i.test(raw)) return 0;
  const left = raw.match(/Осталось\s+(\d+)\s*шт/i);
  if (left) return Number(left[1]);
  return null;
}

function extractListing() {
  if (marketplace()) return [];
  const mp = listingMarketplace();
  if (!mp) return [];
  const byUrl = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.closest('header, footer, nav')) continue;
    let href;
    try {
      href = new URL(a.getAttribute('href'), location.origin).href;
    } catch {
      continue;
    }
    if (!isListingProductHref(mp, href)) continue;
    const url = cleanCardUrl(href);
    if (byUrl.has(url)) continue;
    let node = a;
    let price = null;
    let title = cardTitle(a.getAttribute('aria-label') || a.innerText);
    let stock = parseStock(a.innerText);
    let cardText = a.innerText || '';
    for (let i = 0; i < 7 && node; i += 1) {
      const text = node.innerText || '';
      if (text.length > 0 && text.length < 700) {
        const found = parseMoney(text);
        if (found) {
          price = found;
          title = cardTitle(text) || title;
          stock = parseStock(text);
          cardText = text;
          break;
        }
      }
      node = node.parentElement;
    }
    if (price == null) continue;
    if (stock == null) stock = parseStock(cardText);
    byUrl.set(url, { url, title, price, stock_qty: stock });
  }
  return [...byUrl.values()];
}

const checkedUrls = new Set();
let resolvedProduct = null;

function pageSearchQuery() {
  const params = new URLSearchParams(location.search);
  return params.get('text') || params.get('search') || params.get('q') || '';
}

function productFromStorage(stored) {
  const id = Number(stored?.productId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { id, label: stored.productLabel || `товар ${id}` };
}

async function resolveOurProduct() {
  const stored = await chrome.storage.local.get(['productId', 'productLabel']);
  const picked = productFromStorage(stored);
  if (picked) {
    resolvedProduct = picked;
    return resolvedProduct;
  }
  const q = pageSearchQuery();
  try {
    if (q) {
      const res = await chrome.runtime.sendMessage({ type: 'resolve-product', q });
      if (res?.product?.id) {
        resolvedProduct = {
          id: Number(res.product.id),
          label: `${res.product.sku || ''} — ${res.product.name || ''}`.replace(/^ — /, ''),
        };
        await chrome.storage.local.set({
          productId: resolvedProduct.id,
          productLabel: resolvedProduct.label,
        });
        return resolvedProduct;
      }
    }
  } catch {
    /* ниже останется пустой выбор */
  }
  resolvedProduct = null;
  return null;
}

function showTarget(product) {
  const node = document.getElementById('erm-listing-target');
  if (!node) return;
  if (product?.label) {
    node.textContent = `Запишется в товар: ${product.label}`;
    node.style.color = '#166534';
  } else {
    node.textContent = 'Наш товар не найден. Выберите его в окне расширения.';
    node.style.color = '#b45309';
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.productId) return;
  const id = Number(changes.productId.newValue);
  if (!Number.isFinite(id) || id <= 0) {
    resolvedProduct = null;
    showTarget(null);
    return;
  }
  chrome.storage.local.get(['productLabel']).then((stored) => {
    resolvedProduct = { id, label: stored.productLabel || `товар ${id}` };
    showTarget(resolvedProduct);
  });
});

function renderListingPanel(items) {
  let panel = document.getElementById('erm-listing-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'erm-listing-panel';
    panel.style.cssText =
      'position:fixed;z-index:2147483646;top:12px;right:12px;width:380px;max-height:70vh;overflow:auto;background:#fff;color:#111;border:1px solid #ddd;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.2);font:13px/1.35 sans-serif;padding:10px';
    document.documentElement.appendChild(panel);
  }
  panel.replaceChildren();
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px';
  const title = document.createElement('strong');
  title.textContent = `ЕРМ: ${items.length} в выдаче`;
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Обновить';
  refresh.onclick = () => syncListing(true);
  head.append(title, refresh);
  panel.appendChild(head);
  const target = document.createElement('div');
  target.id = 'erm-listing-target';
  target.style.cssText = 'font-size:12px;color:#166534;margin-bottom:8px';
  target.textContent = 'Ищем наш товар по запросу страницы…';
  panel.appendChild(target);
  resolveOurProduct().then((product) => showTarget(product));

  for (const item of items) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:4px 0;border-top:1px solid #f0f0f0';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checkedUrls.has(item.url);
    box.onchange = () => {
      if (box.checked) checkedUrls.add(item.url);
      else checkedUrls.delete(item.url);
    };
    const text = document.createElement('span');
    const stockLabel = item.stock_qty == null ? 'остаток не указан' : `ост. ${item.stock_qty}`;
    text.textContent = `${item.price.toLocaleString('ru-RU')} ₽ · ${stockLabel} — ${item.title || 'без названия'}`;
    row.append(box, text);
    panel.appendChild(row);
  }

  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Записать выбранные';
  save.style.marginTop = '8px';
  save.onclick = () => saveChecked(items);
  panel.appendChild(save);
}

function hideListingPanel() {
  document.getElementById('erm-listing-panel')?.remove();
}

async function saveChecked(items) {
  const picked = (items || extractListing()).filter((item) => checkedUrls.has(item.url));
  if (!picked.length) {
    toast('Отметьте товары в списке выдачи', true);
    return { ok: false };
  }
  const product = await resolveOurProduct();
  if (!product?.id) {
    toast('Сначала выберите наш товар в окне расширения и кликните строку в списке', true);
    return { ok: false };
  }
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'ingest-many',
      items: picked,
      productId: product.id,
    });
  } catch (e) {
    toast(e?.message || 'Расширение не ответило', true);
    return { ok: false };
  }
  toast(res?.message || 'Не удалось записать', !res?.ok);
  return res;
}

function syncListing(force) {
  if (marketplace()) {
    hideListingPanel();
    return;
  }
  const items = extractListing();
  if (items.length < 2) {
    if (force) toast('На странице не видно цен товаров', true);
    hideListingPanel();
    return;
  }
  renderListingPanel(items);
}

function toast(text, isError) {
  let el = document.getElementById('erm-competitor-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'erm-competitor-toast';
    el.style.cssText =
      'position:fixed;z-index:2147483646;right:16px;bottom:16px;max-width:320px;padding:10px 12px;border-radius:8px;font:13px/1.4 sans-serif;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.25)';
    document.documentElement.appendChild(el);
  }
  el.style.background = isError ? '#b91c1c' : '#166534';
  el.textContent = text;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.remove(), 4000);
}

let lastKey = '';
let hrefWatch = location.href;

async function sendSnapshot(manual) {
  const snap = extract();
  if (!snap) return false;
  const key = `${snap.url}|${snap.price}`;
  if (!manual && key === lastKey) return true;
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'ingest', payload: { ...snap, manual } });
  } catch (e) {
    if (manual) toast(e?.message || 'Расширение не ответило', true);
    return false;
  }
  if (res?.skipped) return true;
  if (!res?.ok) {
    toast(res?.message || 'Не удалось записать цену', true);
    return false;
  }
  lastKey = key;
  toast(res.message || 'Цена записана в конкуренты', false);
  return true;
}

async function watch() {
  const hrefChanged = location.href !== hrefWatch;
  if (hrefChanged) {
    hrefWatch = location.href;
    lastKey = '';
    checkedUrls.clear();
  }
  if (marketplace()) {
    hideListingPanel();
    for (let i = 0; i < 8; i += 1) {
      if (extract()) {
        await sendSnapshot(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    return;
  }
  for (let i = 0; i < 8; i += 1) {
    const items = extractListing();
    if (items.length >= 2) {
      renderListingPanel(items);
      return;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

watch();
setInterval(() => {
  if (location.href !== hrefWatch) watch();
}, 1000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'capture-now') return false;
  const run = marketplace() ? sendSnapshot(true) : saveChecked(extractListing());
  run.then((res) => sendResponse({ ok: res === true || Boolean(res?.ok) })).catch(() => sendResponse({ ok: false }));
  return true;
});
