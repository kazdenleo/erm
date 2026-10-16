import { describe, expect, test } from '@jest/globals';
import {
  isOzonRateLimitError,
  isOzonStockRateLimitPayload,
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
});
