import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Возвращает агент для fetch через прокси (если задан HTTPS_PROXY/HTTP_PROXY).
 * Используем для внешних API (WB/Ozon/YM) в окружениях с корпоративным прокси.
 */
export function getFetchProxyAgent() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy || !String(proxy).trim()) return undefined;
  try {
    return new HttpsProxyAgent(String(proxy).trim());
  } catch (_) {
    return undefined;
  }
}

