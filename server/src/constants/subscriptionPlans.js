/**
 * Тарифы SaaS (черновик — цены и лимиты правятся без миграции).
 * Trial даёт возможности как у «Бизнес».
 */

export const SUBSCRIPTION_STATUSES = Object.freeze([
  'trial',
  'active',
  'past_due',
  'suspended',
]);

export const PLAN_CODES = Object.freeze(['start', 'business', 'pro']);

export const TRIAL_DAYS = 7;

/** План, по которому работает пробный период. */
export const TRIAL_PLAN_CODE = 'business';

/**
 * @typedef {object} SubscriptionPlan
 * @property {string} code
 * @property {string} name
 * @property {number} priceMonthRub
 * @property {number|null} priceYearRub
 * @property {string} blurb
 * @property {boolean} highlighted
 * @property {number|null} maxUsers
 * @property {number|null} maxOrganizations
 * @property {number|null} maxMpCabinets
 * @property {number|null} maxProducts
 * @property {object} features
 * @property {string[]} featureLabels
 */

/** @type {Record<string, SubscriptionPlan>} */
export const SUBSCRIPTION_PLANS = Object.freeze({
  start: {
    code: 'start',
    name: 'Старт',
    priceMonthRub: 1490,
    priceYearRub: 14300,
    blurb: 'Для одного магазина и первых кабинетов МП.',
    highlighted: false,
    maxUsers: 2,
    maxOrganizations: 1,
    maxMpCabinets: 3,
    maxProducts: 500,
    features: {
      warehouse: true,
      ordersFbs: true,
      assembly: true,
      prices: true,
      fbo: false,
      purchases: false,
      kits: false,
      production: false,
      ads: false,
      analyticsExtended: false,
      ai: false,
      mobileApp: false,
    },
    featureLabels: [
      '2 пользователя',
      '1 организация',
      'До 3 кабинетов МП',
      'До 500 товаров',
      'Склад и заказы FBS',
      'Цены и пуш на МП',
      'Email / Telegram поддержка',
    ],
  },
  business: {
    code: 'business',
    name: 'Бизнес',
    priceMonthRub: 2490,
    priceYearRub: 23900,
    blurb: 'Для растущих селлеров с FBO, закупками и комплектами.',
    highlighted: true,
    maxUsers: 5,
    maxOrganizations: 3,
    maxMpCabinets: 9,
    maxProducts: 5000,
    features: {
      warehouse: true,
      ordersFbs: true,
      assembly: true,
      prices: true,
      fbo: true,
      purchases: true,
      kits: true,
      production: false,
      ads: true,
      analyticsExtended: false,
      ai: false,
      mobileApp: true,
    },
    featureLabels: [
      '5 пользователей',
      'До 3 организаций',
      'До 9 кабинетов МП',
      'До 5 000 товаров',
      'FBO-поставки и закупки',
      'Комплекты',
      'Базовая реклама и аналитика',
      'Мобильное приложение склада',
      'Приоритетная поддержка',
    ],
  },
  pro: {
    code: 'pro',
    name: 'Про',
    priceMonthRub: 3990,
    priceYearRub: 38300,
    blurb: 'Все модули: производство, AI и расширенная аналитика.',
    highlighted: false,
    maxUsers: 15,
    maxOrganizations: 10,
    maxMpCabinets: 30,
    maxProducts: null,
    features: {
      warehouse: true,
      ordersFbs: true,
      assembly: true,
      prices: true,
      fbo: true,
      purchases: true,
      kits: true,
      production: true,
      ads: true,
      analyticsExtended: true,
      ai: true,
      mobileApp: true,
    },
    featureLabels: [
      '15 пользователей',
      'До 10 организаций',
      'До 30 кабинетов МП',
      'Товары без лимита*',
      'Все модули продукта',
      'Производство и AI-помощник',
      'Расширенная аналитика',
      'Приоритет + созвон',
    ],
  },
});

export function getSubscriptionPlan(code) {
  const key = String(code || '')
    .trim()
    .toLowerCase();
  return SUBSCRIPTION_PLANS[key] || null;
}

export function listSubscriptionPlansPublic() {
  return PLAN_CODES.map((code) => {
    const p = SUBSCRIPTION_PLANS[code];
    return {
      code: p.code,
      name: p.name,
      priceMonthRub: p.priceMonthRub,
      priceYearRub: p.priceYearRub,
      blurb: p.blurb,
      highlighted: p.highlighted,
      maxUsers: p.maxUsers,
      maxOrganizations: p.maxOrganizations,
      maxMpCabinets: p.maxMpCabinets,
      maxProducts: p.maxProducts,
      features: p.features,
      featureLabels: p.featureLabels,
      trialDays: TRIAL_DAYS,
    };
  });
}

/** Поля profiles.* из тарифа (флаги модулей). */
export function planFeatureFlagsForProfile(planCode) {
  const plan = getSubscriptionPlan(planCode) || SUBSCRIPTION_PLANS.business;
  const f = plan.features || {};
  return {
    kits_enabled: f.kits !== false,
    production_enabled: f.production === true,
    fbo_enabled: f.fbo === true,
    pricing_strategies_enabled: f.prices !== false,
    tariff: plan.name,
  };
}

export function formatPlanPriceMonth(plan) {
  if (!plan) return '';
  return `${Number(plan.priceMonthRub).toLocaleString('ru-RU')} ₽`;
}
