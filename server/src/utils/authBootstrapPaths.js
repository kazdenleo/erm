/**
 * Маршруты первичной авторизации: не проверяем X-Organization-Id / X-Account-Id,
 * чтобы «чужой» id из localStorage не ломал /auth/me после смены аккаунта.
 */

function normalizeAuthPath(req) {
  const raw = String(req.originalUrl || req.url || '').split('?')[0];
  return raw.replace(/\/+$/, '');
}

export function isAuthBootstrapRequest(req) {
  const url = normalizeAuthPath(req);
  if (req.method === 'POST' && /\/auth\/login$/i.test(url)) return true;
  if (req.method === 'POST' && /\/auth\/register-account$/i.test(url)) return true;
  if (req.method === 'GET' && /\/auth\/me$/i.test(url)) return true;
  return false;
}
