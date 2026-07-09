import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getReserveDbLimiterStats,
  runReserveDbLimited,
} from '../src/utils/reserveDbLimiter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('reserveDbLimiter: serializes when max concurrency is 1', async () => {
  const prev = process.env.RESERVE_DB_CONCURRENCY_MAX;
  process.env.RESERVE_DB_CONCURRENCY_MAX = '1';
  const order = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const a = runReserveDbLimited(async () => {
      order.push('a-start');
      await sleep(30);
      order.push('a-end');
    });
    const b = runReserveDbLimited(async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  } finally {
    if (prev == null) delete process.env.RESERVE_DB_CONCURRENCY_MAX;
    else process.env.RESERVE_DB_CONCURRENCY_MAX = prev;
  }
});

test('reserveDbLimiter: exposes queue stats', () => {
  const stats = getReserveDbLimiterStats();
  assert.ok(stats.max >= 1);
  assert.ok(stats.active >= 0);
  assert.ok(stats.queued >= 0);
});

test('migration 141 defines partial reserve indexes on stock_movements', () => {
  const sql = readFileSync(
    join(__dirname, '../scripts/migrations/sql/141_stock_movements_reserve_indexes.sql'),
    'utf8'
  );
  assert.match(sql, /idx_stock_movements_product_reserve/);
  assert.match(sql, /idx_stock_movements_product_wh_reserve/);
  assert.match(sql, /idx_stock_movements_fbo_item_reserve/);
  assert.match(sql, /WHERE type IN \('reserve', 'unreserve'\)/);
});
