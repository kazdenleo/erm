/**
 * Человекочитаемое сообщение об ошибке API (в т.ч. HTML 504 от nginx).
 */

const NGINX_504_HINT =
  'Сервер не успел ответить (504 Gateway Time-out). Обычно nginx обрывает запрос через ~60 с, пока API ещё работает. ' +
  'Подождите 1–2 минуты и повторите. Администратору: в nginx для location /api/ задайте proxy_read_timeout 300s и перезапустите pm2 restart erm-api.';

const TIMEOUT_HINT =
  'Запрос занял слишком много времени. Проверьте раздел «Склад → Закупки» — закупка могла уже создаться. Обновите список заказов.';

export function getApiErrorMessage(error, fallback = 'Ошибка запроса') {
  const status = error?.response?.status;
  const data = error?.response?.data;
  const code = error?.code;

  if (code === 'ECONNABORTED' || String(error?.message || '').includes('timeout of')) {
    return TIMEOUT_HINT;
  }

  if (status === 504) return NGINX_504_HINT;

  if (typeof data === 'string' && /Gateway Time-out|<title>504/i.test(data)) {
    return NGINX_504_HINT;
  }

  if (data && typeof data === 'object') {
    return data.message || data.error || fallback;
  }

  return error?.message || fallback;
}
