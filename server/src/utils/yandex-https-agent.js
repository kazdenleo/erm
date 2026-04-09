/**
 * HTTPS-агент для запросов к API Яндекс.Маркета (partner.market).
 * Использует HTTPS_PROXY / HTTP_PROXY — иначе проверка токена в «Интеграциях»
 * может падать, а синхронизация заказов (где агент уже был) — работать.
 */

import { HttpsProxyAgent } from 'https-proxy-agent';

export function getYandexHttpsAgent() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy || !proxy.trim()) return undefined;
  try {
    return new HttpsProxyAgent(proxy.trim());
  } catch {
    return undefined;
  }
}

/**
 * Сообщение для пользователя при сбое fetch (пустой reason, ECONNRESET, и т.д.)
 */
export function formatYandexNetworkError(err, url) {
  const code = err?.code || err?.cause?.code || err?.errno;
  const causeMsg = err?.cause?.message || '';
  const base = [err?.message, code && `[${code}]`, causeMsg].filter(Boolean).join(' ').trim();
  const text = base || 'ошибка сети (нет деталей от ОС)';
  const hasProxy = !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  const hints = [];
  if (!hasProxy) {
    hints.push(
      'если доступ в интернет только через прокси — задайте переменную окружения HTTPS_PROXY (как для синхронизации заказов Яндекса)'
    );
  }
  hints.push('проверьте firewall, VPN и доступность хоста api.partner.market.yandex.ru с этой машины');
  const low = String(text).toLowerCase();
  if (
    low.includes('certificate') ||
    low.includes('ssl') ||
    low.includes('tls') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    hints.push('при корпоративном SSL-инспектировании может понадобиться NODE_EXTRA_CA_CERTS');
  }
  return `${text} (${url}). ${hints.join('; ')}.`;
}
