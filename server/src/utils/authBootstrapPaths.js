/**
 * Маршруты первичной авторизации: не проверяем X-Organization-Id / X-Account-Id,
 * чтобы «чужой» id из localStorage не ломал /auth/me после смены аккаунта.
 */

export function isAuthBootstrapRequest(req) {
  const url = String(req.originalUrl || req.url || '').split('?')[0];
  if (req.method === 'POST' && /\/api\/auth\/login$/i.test(url)) return true;
  if (req.method === 'POST' && /\/api\/auth\/register-account$/i.test(url)) return true;
  if (req.method === 'GET' && /\/api\/auth\/me$/i.test(url)) return true;
  return false;
}
