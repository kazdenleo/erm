/**
 * Канал клиента для лимита сессий: web (компьютер) | mobile.
 * Приоритет: заголовок X-Client-Kind → body.clientKind → User-Agent.
 */

const MOBILE_UA_RE = /Android|iPhone|iPad|iPod|Mobile|IEMobile|BlackBerry|Opera Mini/i;

/**
 * @param {unknown} raw
 * @returns {'web'|'mobile'|null}
 */
export function normalizeClientKind(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase();
  if (v === 'web' || v === 'desktop' || v === 'pc') return 'web';
  if (v === 'mobile' || v === 'app' || v === 'ios' || v === 'android') return 'mobile';
  return null;
}

/**
 * @param {import('express').Request} req
 * @returns {'web'|'mobile'}
 */
export function resolveClientKind(req) {
  const fromHeader = normalizeClientKind(req.headers?.['x-client-kind']);
  if (fromHeader) return fromHeader;

  const fromBody = normalizeClientKind(req.body?.clientKind ?? req.body?.client_kind);
  if (fromBody) return fromBody;

  const ua = String(req.headers?.['user-agent'] || '');
  if (MOBILE_UA_RE.test(ua)) return 'mobile';
  return 'web';
}

/**
 * Канал из JWT (старые токены без ch считаем web).
 * @param {object|null|undefined} decoded
 * @returns {'web'|'mobile'}
 */
export function clientKindFromToken(decoded) {
  return normalizeClientKind(decoded?.ch ?? decoded?.clientKind) || 'web';
}
