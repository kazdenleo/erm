import { describe, expect, test } from '@jest/globals';
import {
  parseOzonStockAliases,
  resolveOzonStockPushTargets,
} from '../src/utils/ozonStockPushTargets.js';

describe('ozonStockPushTargets', () => {
  test('parse aliases from stock_aliases / ozon_stock_aliases', () => {
    expect(
      parseOzonStockAliases({
        stock_aliases: [
          { offer_id: 'H600425', product_id: 2954365733 },
          { offer_id: 'H600425', product_id: 2954365733 },
          { sku: 'X', marketplace_product_id: '12' },
        ],
      })
    ).toEqual([
      { offerId: 'H600425', productId: 2954365733 },
      { offerId: 'X', productId: 12 },
    ]);

    expect(
      parseOzonStockAliases({
        ozon_stock_aliases: [{ offerId: 'A' }],
      })
    ).toEqual([{ offerId: 'A', productId: null }]);
  });

  test('resolve primary + aliases', () => {
    const targets = resolveOzonStockPushTargets({
      product: { id: 861, sku: 'H600425-8;' },
      productSkus: [
        {
          marketplace: 'ozon',
          sku: 'H600425-8',
          marketplace_product_id: 3129383192,
          mp_extra: {
            stock_aliases: [{ offer_id: 'H600425', product_id: 2954365733 }],
          },
        },
      ],
    });
    expect(targets).toEqual([
      { offerId: 'H600425-8', productId: 3129383192, source: 'primary' },
      { offerId: 'H600425', productId: 2954365733, source: 'alias' },
    ]);
  });

  test('dedupe primary vs alias', () => {
    const targets = resolveOzonStockPushTargets({
      productSkus: [
        {
          marketplace: 'ozon',
          sku: 'H600425',
          marketplace_product_id: 1,
          mp_extra: { stock_aliases: [{ offer_id: 'H600425', product_id: 1 }] },
        },
      ],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].source).toBe('primary');
  });
});
