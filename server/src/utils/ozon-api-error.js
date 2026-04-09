/**
 * Разбор сообщений об ошибках запросов к seller API Ozon (единый формат для middleware и контроллеров).
 */

const OZON_HTTP_RE = /Ozon API error[:\s]+(\d{3})\b/i;

/** HTTP-код из строки вида "Ozon API error 502: ..." или "Ozon API error: 502 ..." */
export function parseOzonSellerApiHttpStatus(message) {
  const m = String(message || '').match(OZON_HTTP_RE);
  return m ? m[1] : null;
}

/** Это ответ/сбой при обращении к Ozon Seller API, а не просто слово «ozon» в тексте */
export function isOzonSellerApiErrorMessage(message) {
  const s = String(message || '');
  return OZON_HTTP_RE.test(s) || /api-seller\.ozon\.ru/i.test(s);
}
