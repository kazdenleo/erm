/**
 * Форматы ответов Seller API push-уведомлений Ozon.
 * Мониторинг доступности шлёт TYPE_PING; успех событий — HTTP 200 + {"result": true}.
 * Ответ должен уложиться в ~5 с, иначе подписка может быть приостановлена.
 */

export const OZON_PUSH_SERVICE_NAME = 'ERM';
export const OZON_PUSH_SERVICE_VERSION = '1.0';

export function normalizeOzonMessageType(raw) {
  if (raw == null || raw === '') return '';
  return String(raw).trim().toUpperCase();
}

export function isOzonPushMessageType(raw) {
  const t = normalizeOzonMessageType(raw);
  return t.startsWith('TYPE_');
}

export function isOzonPingMessageType(raw) {
  return normalizeOzonMessageType(raw) === 'TYPE_PING';
}

/** Ответ на TYPE_PING (первичное подтверждение URL и периодический мониторинг). */
export function buildOzonPingResponse(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return {
    version: OZON_PUSH_SERVICE_VERSION,
    name: OZON_PUSH_SERVICE_NAME,
    time: d.toISOString(),
    result: true,
  };
}

/** Подтверждение приёма любого события, кроме отдельного формата TYPE_PING. */
export function buildOzonAckResponse() {
  return { result: true };
}
