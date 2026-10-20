/**
 * Форматы ответов Ozon Seller API push (мониторинг TYPE_PING).
 */

import {
  buildOzonAckResponse,
  buildOzonPingResponse,
  isOzonPingMessageType,
  isOzonPushMessageType,
  normalizeOzonMessageType,
  OZON_PUSH_SERVICE_NAME,
  OZON_PUSH_SERVICE_VERSION,
} from '../src/utils/ozonPushWebhook.js';

describe('ozonPushWebhook', () => {
  test('normalize and detect message types', () => {
    expect(normalizeOzonMessageType('type_ping')).toBe('TYPE_PING');
    expect(isOzonPingMessageType('TYPE_PING')).toBe(true);
    expect(isOzonPingMessageType('TYPE_NEW_POSTING')).toBe(false);
    expect(isOzonPushMessageType('TYPE_STATE_CHANGED')).toBe(true);
    expect(isOzonPushMessageType('order.created')).toBe(false);
  });

  test('TYPE_PING response has version, name, time, result', () => {
    const fixed = new Date('2019-08-24T14:15:22.000Z');
    const body = buildOzonPingResponse(fixed);
    expect(body).toEqual({
      version: OZON_PUSH_SERVICE_VERSION,
      name: OZON_PUSH_SERVICE_NAME,
      time: '2019-08-24T14:15:22.000Z',
      result: true,
    });
  });

  test('ack response is {"result": true}', () => {
    expect(buildOzonAckResponse()).toEqual({ result: true });
  });
});
