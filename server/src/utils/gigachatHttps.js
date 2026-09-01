/**
 * HTTPS-агент для GigaChat: прокси + повтор при ошибке сертификата Минцифры.
 */

import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import logger from './logger.js';

export function isTlsError(err) {
  const code = err?.code || err?.cause?.code || '';
  const msg = `${err?.message || ''} ${err?.cause?.message || ''} ${code}`;
  return /certificate|UNABLE_TO_VERIFY|self[- ]signed|CERT_|unable to verify|unable to get local issuer/i.test(
    msg
  );
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
  const attempts = insecureEnv ? [true] : [false, true];
  let lastErr = null;
  for (const insecure of attempts) {
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
      throw err;
    }
  }
  throw lastErr;
}
