import { jest } from '@jest/globals';
import { wbBatchPost, __resetWbBatchQueuesForTests } from '../src/utils/wbBatchPost.js';

const URL = 'https://marketplace-api.wildberries.ru/api/v3/orders/stickers';

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function stickersFor(ids) {
  return { stickers: ids.map((id) => ({ orderId: id, partA: 1, partB: id % 10000, file: `f${id}` })) };
}

const call = (orderId, fetchImpl, authHeader = 'Bearer a') =>
  wbBatchPost({ url: URL, authHeader, orderId, listKey: 'stickers', fetchImpl });

describe('wbBatchPost', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __resetWbBatchQueuesForTests();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('одновременные запросы по заказам уходят одной пачкой', async () => {
    const fetchImpl = jest.fn(async (_url, init) => response(200, stickersFor(JSON.parse(init.body).orders)));
    const p = [101, 102, 103].map((id) => call(id, fetchImpl));
    await jest.advanceTimersByTimeAsync(400);
    const res = await Promise.all(p);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).orders).toEqual([101, 102, 103]);
    expect(res.map((r) => r.item.file)).toEqual(['f101', 'f102', 'f103']);
  });

  test('заказ без стикера в ответе получает item=null', async () => {
    const fetchImpl = jest.fn(async () => response(200, stickersFor([1])));
    const p = [1, 2].map((id) => call(id, fetchImpl));
    await jest.advanceTimersByTimeAsync(400);
    const [a, b] = await Promise.all(p);
    expect(a.item.file).toBe('f1');
    expect(b.item).toBeNull();
  });

  test('429 ждёт X-Ratelimit-Retry и повторяет пачку', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(429, 'Too Many Requests', { 'x-ratelimit-retry': '2' }))
      .mockImplementation(async (_url, init) => response(200, stickersFor(JSON.parse(init.body).orders)));
    const p = call(7, fetchImpl);
    await jest.advanceTimersByTimeAsync(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(600);
    expect((await p).item.file).toBe('f7');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('постоянный 429 в итоге отдаёт ошибку со статусом 429', async () => {
    const fetchImpl = jest.fn(async () => response(429, 'x', { 'x-ratelimit-retry': '1' }));
    const p = call(7, fetchImpl);
    const caught = p.catch((e) => e);
    await jest.advanceTimersByTimeAsync(10_000);
    const err = await caught;
    expect(err.statusCode).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('ошибка пачки — заказы переспрашиваются поштучно', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const ids = JSON.parse(init.body).orders;
      if (ids.length > 1 || ids[0] === 2) return response(400, { message: 'bad order' });
      return response(200, stickersFor(ids));
    });
    const p1 = call(1, fetchImpl);
    const p2 = call(2, fetchImpl).catch((e) => e);
    await jest.advanceTimersByTimeAsync(5000);
    expect((await p1).item.file).toBe('f1');
    expect((await p2).statusCode).toBe(400);
  });

  test('разные ключи кабинетов не смешиваются', async () => {
    const fetchImpl = jest.fn(async (_url, init) => response(200, stickersFor(JSON.parse(init.body).orders)));
    const p = [call(1, fetchImpl, 'Bearer a'), call(2, fetchImpl, 'Bearer b')];
    await jest.advanceTimersByTimeAsync(400);
    await Promise.all(p);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((c) => c[1].headers.Authorization).sort()).toEqual(['Bearer a', 'Bearer b']);
  });
});
