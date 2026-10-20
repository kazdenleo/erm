import { describe, expect, test } from '@jest/globals';
import {
  beginOzonOrdersSyncWindow,
  endOzonOrdersSyncWindow,
  isOzonOrdersSyncWindowActive,
  isOzonRateLimitError,
  isOzonStockRateLimitPayload,
  noteOzonClientRateLimited,
} from '../src/utils/ozonSellerApi.js';

describe('Ozon stock rate-limit detection', () => {
  test('HTTP 429 / rate limit message', () => {
    expect(isOzonRateLimitError({ message: 'HTTP 429' })).toBe(true);
    expect(isOzonRateLimitError({ message: 'rate limit exceeded' })).toBe(true);
  });

  test('stocks body TOO_MANY_REQUESTS / too frequently', () => {
    expect(isOzonRateLimitError({ message: 'Ozon stocks: [{"code":"TOO_MANY_REQUESTS"}]' })).toBe(
      true
    );
    expect(
      isOzonRateLimitError({ message: 'Stock is updated too frequently', code: 'OZON_RATE_LIMIT' })
    ).toBe(true);
  });

  test('payload helper', () => {
    expect(
      isOzonStockRateLimitPayload([
        { code: 'TOO_MANY_REQUESTS', message: 'Stock is updated too frequently' },
      ])
    ).toBe(true);
    expect(isOzonStockRateLimitPayload([{ code: 'INVALID_ARGUMENT', message: 'bad' }])).toBe(false);
    expect(isOzonStockRateLimitPayload([])).toBe(false);
  });

  test('orders sync window nesting', () => {
    expect(isOzonOrdersSyncWindowActive()).toBe(false);
    beginOzonOrdersSyncWindow();
    beginOzonOrdersSyncWindow();
    expect(isOzonOrdersSyncWindowActive()).toBe(true);
    endOzonOrdersSyncWindow();
    expect(isOzonOrdersSyncWindowActive()).toBe(true);
    endOzonOrdersSyncWindow();
    expect(isOzonOrdersSyncWindowActive()).toBe(false);
  });

  test('noteOzonClientRateLimited accepts opts', () => {
    expect(() => noteOzonClientRateLimited({ profileId: 1 }, 1000)).not.toThrow();
    expect(() => noteOzonClientRateLimited('client-1', 1000)).not.toThrow();
  });
});
