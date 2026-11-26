/**
 * Свой домен витрины (тариф Про). Пока сохраняем заявку и инструкции DNS;
 * выпуск nginx/SSL и резолв по Host — следующий этап.
 */

export const STORE_CUSTOM_DOMAIN_FEATURE = 'storeCustomDomain';

export const STORE_DOMAIN_STATUSES = Object.freeze(['none', 'pending', 'active', 'failed']);

/** Хост, на который клиент должен направить CNAME (можно переопределить env). */
export function storeDomainCnameTarget() {
  const fromEnv = String(process.env.STORE_DOMAIN_CNAME_TARGET || '').trim().toLowerCase();
  if (fromEnv) return fromEnv;
  const base = String(process.env.CLIENT_URL || 'https://mysell.su')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return base || 'mysell.su';
}

/**
 * Нормализация домена: без схемы/пути, lowercase, без trailing dot.
 * @returns {string|null} null если пусто
 */
export function normalizeCustomDomain(raw) {
  let s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/\.$/, '');
  // IDN: оставляем как есть (punycode можно добавить позже)
  return s || null;
}

const DOMAIN_RE =
  /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function isValidCustomDomain(domain) {
  if (!domain) return false;
  if (domain.includes('localhost') || /^\d+\.\d+\.\d+\.\d+$/.test(domain)) return false;
  // Нельзя привязать наш служебный путь-хост как «свой» без поддомена shops.*
  const blocked = new Set(['mysell.su', 'www.mysell.su', 'dttrade.ru', 'www.dttrade.ru']);
  if (blocked.has(domain)) return false;
  return DOMAIN_RE.test(domain);
}

export function domainDnsInstructions(domain) {
  const target = storeDomainCnameTarget();
  return {
    domain,
    cnameTarget: target,
    steps: [
      `Создайте DNS-запись CNAME: ${domain} → ${target}`,
      'Дождитесь обновления DNS (обычно от нескольких минут до 24 часов)',
      'После проверки статуса домен станет активным (выпуск SSL — на стороне платформы)',
    ],
  };
}
