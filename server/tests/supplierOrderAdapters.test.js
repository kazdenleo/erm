/**
 * Unit-тесты адаптеров отправки заказа поставщику.
 */

import {
  normalizeWarehouseName,
  pickWarehouseLine,
  warehouseNameMatches,
  xmlTag,
} from '../src/services/supplierOrderAdapters/shared.js';
import { parseMoskvorechieOrderResponse, portalCredentialsFromConfig, shouldUseMoskvorechieV1OrderApi } from '../src/services/supplierOrderAdapters/moskvorechie.adapter.js';
import {
  parseMoskvorechieV1CartAddResponse,
  parseMoskvorechieV1OrderResponse,
  extractMoskvorechieV1Context,
} from '../src/services/supplierOrderAdapters/moskvorechie.v1.js';

describe('supplierOrderAdapters/shared', () => {
  test('xmlTag extracts tag text', () => {
    const xml = '<root><ID>42</ID><Message>OK</Message></root>';
    expect(xmlTag(xml, 'ID')).toBe('42');
    expect(xmlTag(xml, 'Message')).toBe('OK');
  });

  test('warehouseNameMatches partial names', () => {
    expect(warehouseNameMatches('Склад Москва', 'Москва')).toBe(true);
    expect(warehouseNameMatches('SPB', 'Москва')).toBe(false);
  });

  test('pickWarehouseLine prefers named warehouse with stock', () => {
    const lines = [
      { warehouseName: 'Москва', stock: 5, gid: '1' },
      { warehouseName: 'СПб', stock: 20, gid: '2' },
    ];
    const picked = pickWarehouseLine(lines, { warehouseName: 'Москва', quantity: 3 });
    expect(picked.gid).toBe('1');
  });

  test('pickWarehouseLine falls back to highest stock', () => {
    const lines = [
      { warehouseName: 'A', stock: 1, gid: '1' },
      { warehouseName: 'B', stock: 10, gid: '2' },
    ];
    const picked = pickWarehouseLine(lines, { quantity: 2 });
    expect(picked.gid).toBe('2');
  });

  test('pickWarehouseLine ignores lines without gid', () => {
    const lines = [
      { warehouseName: 'A', stock: 100 },
      { warehouseName: 'B', stock: 1, gid: '2' },
    ];
    const picked = pickWarehouseLine(lines, { quantity: 1 });
    expect(picked.gid).toBe('2');
  });

  test('pickWarehouseLine works with Mikado zakazCode', () => {
    const lines = [
      { warehouseName: 'Москва', stock: 5, zakazCode: 'Z1' },
      { warehouseName: 'СПб', stock: 20, zakazCode: 'Z2' },
    ];
    const picked = pickWarehouseLine(lines, { warehouseName: 'Москва', quantity: 1 });
    expect(picked.zakazCode).toBe('Z1');
  });

  test('pickWarehouseLine allows external warehouse with zero stock', () => {
    const lines = [
      { warehouseName: 'Ext', stock: 0, gid: 'ext' },
      { warehouseName: 'Main', stock: 0, gid: 'main' },
    ];
    const picked = pickWarehouseLine(lines, { quantity: 3 });
    expect(picked?.gid).toBeTruthy();
  });

  test('normalizeWarehouseName collapses spaces', () => {
    expect(normalizeWarehouseName('  Склад   MSK  ')).toBe('склад msk');
  });
});

describe('moskvorechie.adapter shouldUseMoskvorechieV1OrderApi', () => {
  test('uses v1 when only API Key is configured (Agreement/Filial resolved at submit)', () => {
    expect(shouldUseMoskvorechieV1OrderApi({ apiKey: 'test-key' }, {})).toBe(true);
  });

  test('does not use v1 without credentials', () => {
    expect(shouldUseMoskvorechieV1OrderApi({}, {})).toBe(false);
  });

  test('uses v1 when agreement and filial are already in config', () => {
    expect(
      shouldUseMoskvorechieV1OrderApi(
        { apiKey: 'k', agreementId: 'a', filialId: 'f' },
        {}
      )
    ).toBe(true);
  });
});

describe('moskvorechie.adapter portalCredentialsFromConfig', () => {
  test('prefers portalApiKey over v1 apiKey', () => {
    const c = portalCredentialsFromConfig({ apiKey: 'v1', portalApiKey: 'portal', user_id: 'u' });
    expect(c.apiKey).toBe('portal');
    expect(c.userId).toBe('u');
    expect(c.hasPortalKey).toBe(true);
  });

  test('uses legacy password when different from v1 key', () => {
    const c = portalCredentialsFromConfig({ apiKey: 'v1', password: 'portal-old', user_id: 'u' });
    expect(c.apiKey).toBe('portal-old');
    expect(c.hasPortalKey).toBe(true);
  });

  test('does not treat v1 password copy as portal key', () => {
    const c = portalCredentialsFromConfig({ apiKey: 'same', password: 'same', user_id: 'u' });
    expect(c.apiKey).toBe('');
    expect(c.hasPortalKey).toBe(false);
  });
});

describe('moskvorechie.adapter parseMoskvorechieOrderResponse', () => {
  test('accepts order_id in result object', () => {
    const r = parseMoskvorechieOrderResponse(JSON.stringify({ result: { order_id: 'Z123' } }));
    expect(r.ok).toBe(true);
    expect(r.orderId).toBe('Z123');
  });

  test('rejects empty response', () => {
    const r = parseMoskvorechieOrderResponse('');
    expect(r.ok).toBe(false);
  });

  test('accepts success without order_id when API confirms', () => {
    const r = parseMoskvorechieOrderResponse(JSON.stringify({ result: { success: true } }));
    expect(r.ok).toBe(true);
    expect(r.orderId).toBeNull();
  });

  test('accepts top-level success without order_id', () => {
    const r = parseMoskvorechieOrderResponse(JSON.stringify({ success: true, message: 'Заказ принят' }));
    expect(r.ok).toBe(true);
  });

  test('rejects explicit API error', () => {
    const r = parseMoskvorechieOrderResponse(JSON.stringify({ error: 'Нет доступа' }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Нет доступа');
  });

  test('rejects wrong act (status 1 + msg)', () => {
    const r = parseMoskvorechieOrderResponse(
      JSON.stringify({ result: { status: '1', msg: 'Вызвана не верная function "act"' } })
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('не верная');
  });

  test('rejects empty basket response', () => {
    const r = parseMoskvorechieOrderResponse(
      JSON.stringify({ result: { status: '1', msg: 'Ваша корзина пуста' } })
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('корзина пуста');
  });

  test('accepts status 0 without order_id as success', () => {
    const r = parseMoskvorechieOrderResponse(
      JSON.stringify({ result: { status: '0', msg: 'Заказ принят' } })
    );
    expect(r.ok).toBe(true);
  });
});

describe('moskvorechie.v1 parseMoskvorechieV1CartAddResponse', () => {
  test('accepts status 1 with cart_position_id', () => {
    const r = parseMoskvorechieV1CartAddResponse({
      status: 1,
      cart: [{ cart_position_id: 76, gid: '102370805', status: 1 }],
    });
    expect(r.ok).toBe(true);
    expect(r.cartPositionIds).toEqual(['76']);
  });

  test('rejects partial cart errors', () => {
    const r = parseMoskvorechieV1CartAddResponse({
      status: 0,
      message: 'В корзину добавлены строки с ошибками',
      cart: [
        { cart_position_id: 76, gid: '102370805', status: 1 },
        { gid: '10237069', status: 0, error_message: 'Данный товар не найден' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ошибк');
  });
});

describe('moskvorechie.v1 parseMoskvorechieV1OrderResponse', () => {
  test('accepts status 1 with order_number', () => {
    const r = parseMoskvorechieV1OrderResponse({
      status: 1,
      order: { order_number: '250504017731', status: 'Принят' },
    });
    expect(r.ok).toBe(true);
    expect(r.orderId).toBe('250504017731');
  });

  test('rejects status 0 with message', () => {
    const r = parseMoskvorechieV1OrderResponse({
      status: 0,
      message: 'Корзина пуста',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Корзина пуста');
  });

  test('rejects API error object', () => {
    const r = parseMoskvorechieV1OrderResponse({
      error: { code: 'bad_token', message: 'Ключ имеет неверный формат' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('bad_token');
  });
});

describe('moskvorechie.v1 extractMoskvorechieV1Context', () => {
  test('extracts ids from nested profile', () => {
    const ctx = extractMoskvorechieV1Context({
      agreements: [{ id: 'agr-1', filials: [{ id: 'fil-1' }] }],
      delivery_terms: [{ id: 'term-1' }],
    });
    expect(ctx.agreementId).toBe('agr-1');
    expect(ctx.filialId).toBe('fil-1');
    expect(ctx.deliveryTerm).toBe('term-1');
  });

  test('extracts flat agreement_id and filial_id', () => {
    const ctx = extractMoskvorechieV1Context({
      agreement_id: 'a',
      filial_id: 'f',
      delivery_term: 'd',
    });
    expect(ctx).toEqual({ agreementId: 'a', filialId: 'f', deliveryTerm: 'd' });
  });

  test('extracts ids from Moskvorechie profile.data order_settings', () => {
    const ctx = extractMoskvorechieV1Context({
      data: {
        order_settings: {
          kontragents: [
            {
              agreements: [
                {
                  agreement_terms: [
                    {
                      is_default: true,
                      term: { id: 'agr-term-1' },
                    },
                  ],
                },
              ],
              delivery_addresses: [{ id: 'fil-1', is_default: true }],
            },
          ],
        },
        delivery_terms: [{ id: 'del-1', is_default: true }],
      },
    });
    expect(ctx.agreementId).toBe('agr-term-1');
    expect(ctx.filialId).toBe('fil-1');
    expect(ctx.deliveryTerm).toBe('del-1');
  });
});
