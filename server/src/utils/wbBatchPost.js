/**
 * Пакетные POST-запросы к WB marketplace API вида { orders: [id, ...] } (stickers, status).
 * Запросы по разным заказам за короткое окно склеиваются в один (до 100 id),
 * по одному ключу — строго последовательно с паузой; 429 ждёт X-Ratelimit-Retry и повторяет пачку.
 */

const BATCH_WINDOW_MS = 300;
const MIN_GAP_MS = 600;
const MAX_BATCH = 100;
const MAX_429_RETRIES = 3;
const MAX_429_WAIT_MS = 60_000;

const queues = new Map();

function retryAfterMs(resp) {
  const h = resp?.headers;
  const raw =
    h?.get?.('x-ratelimit-retry') ?? h?.get?.('X-Ratelimit-Retry') ?? h?.get?.('retry-after') ?? null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, MAX_429_WAIT_MS);
  return 5000;
}

function rateLimitError(waitMs) {
  const err = new Error(
    `WB: слишком много запросов (429). Попробуйте через ${Math.ceil(waitMs / 1000)} сек.`
  );
  err.statusCode = 429;
  return err;
}

function getQueue(key, opts) {
  let q = queues.get(key);
  if (!q) {
    q = { ...opts, pending: [], timer: null, running: false, nextAt: 0 };
    queues.set(key, q);
  }
  return q;
}

function schedule(q, key) {
  if (q.timer || q.running || !q.pending.length) return;
  const delay = Math.max(BATCH_WINDOW_MS, q.nextAt - Date.now());
  q.timer = setTimeout(() => {
    q.timer = null;
    flush(q, key).catch(() => {});
  }, delay);
}

async function flush(q, key) {
  if (q.running || !q.pending.length) return;
  q.running = true;
  const soloIdx = q.pending.findIndex((e) => e.solo);
  const batch =
    soloIdx >= 0 ? q.pending.splice(soloIdx, 1) : q.pending.splice(0, MAX_BATCH);
  const ids = [...new Set(batch.map((e) => e.orderId))];
  try {
    const resp = await q.fetchImpl(q.url, {
      method: 'POST',
      headers: {
        Authorization: q.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ orders: ids }),
    });
    const text = await resp.text();

    if (resp.status === 429) {
      const waitMs = retryAfterMs(resp);
      q.onLog?.(`[WB] 429 ${q.url} batch=${ids.length} wait=${waitMs}ms`);
      q.nextAt = Date.now() + waitMs;
      for (const e of batch) {
        e.rateLimited = (e.rateLimited || 0) + 1;
        if (e.rateLimited > MAX_429_RETRIES) e.reject(rateLimitError(waitMs));
        else q.pending.unshift(e);
      }
      return;
    }

    q.nextAt = Date.now() + MIN_GAP_MS;

    if (!resp.ok) {
      // Один «плохой» заказ может уронить всю пачку — разбираем поштучно.
      if (batch.length > 1) {
        for (const e of batch) q.pending.push({ ...e, solo: true });
        return;
      }
      const err = new Error(`WB ${resp.status}: ${text.substring(0, 200)}`);
      err.statusCode = resp.status;
      err.responseText = text;
      for (const e of batch) e.reject(err);
      return;
    }

    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      const err = new Error('WB API вернул не JSON');
      err.responseText = text;
      for (const e of batch) e.reject(err);
      return;
    }
    const list = Array.isArray(json?.[q.listKey]) ? json[q.listKey] : [];
    const byId = new Map();
    for (const item of list) {
      const id = Number(item?.orderId ?? item?.order_id ?? item?.id);
      if (Number.isFinite(id) && !byId.has(id)) byId.set(id, item);
    }
    const single = ids.length === 1 && list.length === 1 ? list[0] : null;
    for (const e of batch) e.resolve({ item: byId.get(e.orderId) ?? single, json });
  } catch (err) {
    for (const e of batch) e.reject(err);
  } finally {
    q.running = false;
    schedule(q, key);
  }
}

/**
 * @param {{ url: string, authHeader: string, orderId: number, listKey: string, fetchImpl?: Function, onLog?: Function }} p
 * @returns {Promise<{ item: object|null, json: object }>}
 */
export function wbBatchPost({ url, authHeader, orderId, listKey, fetchImpl = fetch, onLog = null }) {
  const key = `${url}|${authHeader}`;
  const q = getQueue(key, { url, authHeader, listKey, fetchImpl, onLog });
  return new Promise((resolve, reject) => {
    q.pending.push({ orderId: Number(orderId), resolve, reject });
    schedule(q, key);
  });
}

export function __resetWbBatchQueuesForTests() {
  for (const q of queues.values()) if (q.timer) clearTimeout(q.timer);
  queues.clear();
}
