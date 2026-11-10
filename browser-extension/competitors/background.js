const DEFAULT_API = 'http://localhost:3001/api';

function apiBase(stored) {
  return String(stored || DEFAULT_API).replace(/\/+$/, '');
}

async function api(path, { method = 'GET', body, token, base } = {}) {
  const headers = {};
  if (body != null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase(base)}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.message || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function ingest(payload) {
  const stored = await chrome.storage.local.get(['apiBase', 'token', 'productId', 'autoSave']);
  if (!stored.productId) {
    return { ok: false, message: 'В расширении выберите наш товар' };
  }
  if (stored.autoSave === false && !payload.manual) {
    return { ok: false, skipped: true };
  }
  const data = await api(`/products/${stored.productId}/competitors/ingest`, {
    method: 'POST',
    token: stored.token,
    base: stored.apiBase,
    body: {
      url: payload.url,
      title: payload.title,
      price: payload.price,
      rating: payload.rating,
      reviews_count: payload.reviews_count,
      stock_qty: payload.stock_qty,
    },
  });
  const item = data.data || {};
  const result = {
    ok: true,
    created: Boolean(data.created),
    message: data.created
      ? `Добавлен конкурент: ${item.price} ₽`
      : `Цена обновлена: ${item.price} ₽`,
    item,
  };
  await chrome.storage.local.set({ lastResult: { ...result, at: Date.now(), url: payload.url } });
  return result;
}

function matchProduct(products, q) {
  const query = String(q || '').trim().toLowerCase();
  const tokens = query.split(/[\s,;]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  const exact = (products || []).filter((p) => {
    const sku = String(p.sku || '').trim().toLowerCase();
    return sku && (sku === query || tokens.includes(sku));
  });
  return exact.length === 1 ? exact[0] : null;
}

async function resolveProduct(q) {
  const stored = await chrome.storage.local.get(['apiBase', 'token']);
  const data = await api(`/search?q=${encodeURIComponent(q || '')}&limit=8`, {
    token: stored.token,
    base: stored.apiBase,
  });
  return matchProduct(data?.data?.products || [], q);
}

async function ingestMany(items, productId) {
  const stored = await chrome.storage.local.get(['apiBase', 'token', 'productId']);
  const id = productId || stored.productId;
  if (!id) {
    return { ok: false, message: 'В расширении выберите наш товар' };
  }
  const data = await api(`/products/${id}/competitors/ingest-batch`, {
    method: 'POST',
    token: stored.token,
    base: stored.apiBase,
    body: { items },
  });
  const saved = Number(data.saved) || 0;
  const failed = Number(data.failed) || 0;
  const reason = (data.results || []).find((r) => !r.ok)?.message;
  const message = failed
    ? `Записано ${saved}. Не записано ${failed}${reason ? `: ${reason}` : ''}`
    : `Записано ${saved}`;
  const result = { ok: saved > 0, message, saved, failed };
  await chrome.storage.local.set({ lastResult: { ...result, at: Date.now() } });
  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'resolve-product') {
    resolveProduct(msg.q)
      .then((product) => sendResponse({ ok: true, product }))
      .catch((e) => sendResponse({ ok: false, message: e?.message || String(e) }));
    return true;
  }
  if (msg?.type === 'ingest-many') {
    ingestMany(msg.items || [], msg.productId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: e?.message || String(e) }));
    return true;
  }
  if (msg?.type === 'ingest') {
    ingest(msg.payload || {})
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: e?.message || String(e), status: e?.status }));
    return true;
  }
  if (msg?.type === 'login') {
    const { login, password, apiBase: base } = msg;
    api('/auth/login', { method: 'POST', base, body: { login, password } })
      .then(async (data) => {
        const token = data?.data?.token;
        const user = data?.data?.user;
        if (!token) throw new Error('Сервер не вернул токен');
        await chrome.storage.local.set({
          apiBase: apiBase(base),
          token,
          userName: user?.fullName || user?.email || login,
        });
        sendResponse({ ok: true, userName: user?.fullName || user?.email || login });
      })
      .catch((e) => sendResponse({ ok: false, message: e?.message || String(e) }));
    return true;
  }
  if (msg?.type === 'search') {
    chrome.storage.local.get(['apiBase', 'token']).then((stored) =>
      api(`/search?q=${encodeURIComponent(msg.q || '')}&limit=8`, {
        token: stored.token,
        base: stored.apiBase,
      })
        .then((data) => sendResponse({ ok: true, products: data?.data?.products || [] }))
        .catch((e) => sendResponse({ ok: false, message: e?.message || String(e) }))
    );
    return true;
  }
  return false;
});
