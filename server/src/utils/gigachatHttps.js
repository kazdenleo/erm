/**
 * HTTPS-агент для GigaChat: прокси + повтор при ошибке сертификата Минцифры
 * и кратковременных сбоях DNS/сети (часто с VPN).
 */

import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import { aiHttpError } from './aiSettings.js';
import logger from './logger.js';

const NET_RETRIES = 3;
const NET_RETRY_BASE_MS = 500;

export function isTlsError(err) {
  const code = err?.code || err?.cause?.code || '';
  const msg = `${err?.message || ''} ${err?.cause?.message || ''} ${code}`;
  return /certificate|UNABLE_TO_VERIFY|self[- ]signed|CERT_|unable to verify|unable to get local issuer/i.test(
    msg
  );
}

function networkCode(err) {
  return err?.code || err?.cause?.code || '';
}

function isTransientNetworkError(err) {
  const code = networkCode(err);
  const raw = `${err?.message || ''} ${err?.cause?.message || ''}`;
  return (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    /ENOTFOUND|EAI_AGAIN|socket disconnected|network/i.test(raw)
  );
}

function formatGigachatNetworkError(err) {
  const code = networkCode(err);
  const raw = `${err?.message || ''} ${err?.cause?.message || ''}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return aiHttpError(
      'Не удалось достучаться до GigaChat (DNS: хост не найден). Часто бывает из‑за VPN — отключите VPN или смените DNS и повторите.',
      503
    );
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return aiHttpError(
      'GigaChat временно недоступен (сеть оборвалась или таймаут). Подождите минуту и повторите запрос.',
      503
    );
  }
  if (/socket disconnected|network|fetch failed/i.test(raw)) {
    return aiHttpError(
      'Сбой сети при обращении к GigaChat. Повторите запрос через минуту.',
      503
    );
  }
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGigachatAgent({ insecure = false } = {}) {
  const proxy = String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
  const rejectUnauthorized = !insecure && process.env.GIGACHAT_TLS_INSECURE !== '1';
  if (proxy) {
    return new HttpsProxyAgent(proxy, { rejectUnauthorized });
  }
  return new https.Agent({ rejectUnauthorized });
}

export async function gigachatFetch(url, options = {}) {
  const insecureEnv = process.env.GIGACHAT_TLS_INSECURE === '1';
  let lastErr = null;

  for (let netAttempt = 0; netAttempt < NET_RETRIES; netAttempt += 1) {
    const tlsAttempts = insecureEnv ? [true] : [false, true];
    let retryNet = false;

    for (const insecure of tlsAttempts) {
      try {
        const res = await fetch(url, {
          ...options,
          agent: createGigachatAgent({ insecure }),
        });
        if (insecure && !insecureEnv) {
          logger.warn('[GigaChat] TLS-сертификат не прошёл проверку, запрос повторён без verify (как в SDK Сбера)');
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (!insecure && isTlsError(err)) continue;
        if (isTransientNetworkError(err) && netAttempt < NET_RETRIES - 1) {
          const waitMs = NET_RETRY_BASE_MS * (netAttempt + 1);
          logger.warn('[GigaChat] сбой сети, повтор', {
            attempt: netAttempt + 1,
            of: NET_RETRIES,
            waitMs,
            code: networkCode(err) || undefined,
            host: (() => {
              try {
                return new URL(url).host;
              } catch {
                return undefined;
              }
            })(),
          });
          await sleep(waitMs);
          retryNet = true;
          break;
        }
        throw formatGigachatNetworkError(err);
      }
    }

    if (!retryNet) break;
  }

  throw formatGigachatNetworkError(lastErr);
}
