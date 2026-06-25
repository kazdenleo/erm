/**
 * Видимость разделов меню по ролям аккаунта.
 * В БД profiles.role_nav_sections: { "picker": { "products": false } } — скрыть; по умолчанию всё видно.
 */

export const NAV_SECTION_KEYS = [
  'analytics',
  'products',
  'orders',
  'shipments',
  'fbo',
  'questions',
  'reviews',
  'wb_returns',
  'warehouse_stock',
  'warehouse_purchases',
  'warehouse_production',
  'warehouse_receipts',
  'warehouse_transfer',
  'warehouse_return_supplier',
  'warehouse_return_customer',
  'warehouse_inventory',
  'warehouse_writeoff',
  'prices',
  'settings_general',
  'settings_attributes',
  'settings_labels',
  'settings_users',
  'settings_roles',
  'organizations',
  'warehouses',
  'suppliers',
  'categories',
  'brands',
  'integrations',
];

export const NAV_SECTION_LABELS = {
  analytics: 'Аналитика',
  products: 'Товары',
  orders: 'Заказы',
  shipments: 'Отгрузки',
  fbo: 'Поставки FBO',
  questions: 'Вопросы',
  reviews: 'Отзывы',
  wb_returns: 'Возвраты',
  warehouse_stock: 'Склад — остатки',
  warehouse_purchases: 'Склад — закупка',
  warehouse_production: 'Склад — производство',
  warehouse_receipts: 'Склад — приёмка',
  warehouse_transfer: 'Склад — перемещение',
  warehouse_return_supplier: 'Склад — возврат поставщику',
  warehouse_return_customer: 'Склад — возврат от клиентов',
  warehouse_inventory: 'Склад — инвентаризация',
  warehouse_writeoff: 'Склад — списание',
  prices: 'Цены',
  settings_general: 'Настройки — общие',
  settings_attributes: 'Настройки — атрибуты',
  settings_labels: 'Настройки — этикетки',
  settings_users: 'Настройки — пользователи',
  settings_roles: 'Настройки — роли',
  organizations: 'Организации',
  warehouses: 'Склады',
  suppliers: 'Поставщики',
  categories: 'Категории',
  brands: 'Бренды',
  integrations: 'Интеграции',
};

export const NAV_SECTION_GROUPS = [
  {
    title: 'Основное',
    keys: ['analytics', 'products', 'orders', 'shipments', 'prices'],
  },
  {
    title: 'Маркетплейс',
    keys: ['fbo', 'questions', 'reviews', 'wb_returns'],
  },
  {
    title: 'Склад',
    keys: [
      'warehouse_stock',
      'warehouse_purchases',
      'warehouse_production',
      'warehouse_receipts',
      'warehouse_transfer',
      'warehouse_return_supplier',
      'warehouse_return_customer',
      'warehouse_inventory',
      'warehouse_writeoff',
    ],
  },
  {
    title: 'Справочники и настройки',
    keys: [
      'settings_general',
      'settings_attributes',
      'settings_labels',
      'settings_users',
      'settings_roles',
      'organizations',
      'warehouses',
      'suppliers',
      'categories',
      'brands',
      'integrations',
    ],
  },
];

/** Пресеты при смене роли (только для подсказки в UI; админ может переопределить). */
export const ROLE_NAV_PRESETS = {
  picker: {
    analytics: false,
    products: false,
    prices: false,
    fbo: false,
    questions: false,
    reviews: false,
    wb_returns: false,
    settings_general: false,
    settings_attributes: false,
    settings_labels: false,
    settings_users: false,
    settings_roles: false,
    organizations: false,
    warehouses: false,
    suppliers: false,
    categories: false,
    brands: false,
    integrations: false,
    warehouse_purchases: false,
    warehouse_production: false,
    warehouse_return_supplier: false,
    warehouse_return_customer: false,
    warehouse_inventory: false,
    warehouse_writeoff: false,
  },
  warehouse_manager: {
    analytics: false,
    products: false,
    prices: false,
    fbo: false,
    questions: false,
    reviews: false,
    wb_returns: false,
    orders: false,
    shipments: false,
    settings_users: false,
    settings_roles: false,
    integrations: false,
  },
  editor: {
    warehouse_stock: false,
    warehouse_purchases: false,
    warehouse_production: false,
    warehouse_receipts: false,
    warehouse_transfer: false,
    warehouse_return_supplier: false,
    warehouse_return_customer: false,
    warehouse_inventory: false,
    warehouse_writeoff: false,
    settings_users: false,
    settings_roles: false,
  },
  admin: {},
};

export const CONFIGURABLE_ACCOUNT_ROLES = ['picker', 'warehouse_manager', 'editor'];

export const ACCOUNT_ROLE_LABELS = {
  admin: 'Администратор',
  picker: 'Сборщик',
  warehouse_manager: 'Руководитель склада',
  editor: 'Редактор',
};

export function normalizeAccountRoleKey(v) {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  if (!s || s === 'admin') return s || null;
  return CONFIGURABLE_ACCOUNT_ROLES.includes(s) ? s : null;
}

export function parseRoleNavSections(raw) {
  const src = parseNavSections(raw);
  const out = {};
  for (const role of [...CONFIGURABLE_ACCOUNT_ROLES, 'admin']) {
    if (src[role] != null && typeof src[role] === 'object' && !Array.isArray(src[role])) {
      out[role] = normalizeNavSections(src[role]);
    }
  }
  return out;
}

export function resolveNavSectionsForAccountRole(roleNavSections, accountRole) {
  const role = normalizeAccountRoleKey(accountRole) || 'editor';
  if (role === 'admin') return {};
  const all = parseRoleNavSections(roleNavSections);
  if (Object.prototype.hasOwnProperty.call(all, role)) {
    return all[role];
  }
  return ROLE_NAV_PRESETS[role] || {};
}

export function roleNavSectionsToFormState(roleNavSections, accountRole) {
  return navSectionsToFormState(resolveNavSectionsForAccountRole(roleNavSections, accountRole));
}

export function parseNavSections(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export function isNavSectionEnabled(navSections, key) {
  if (!key) return true;
  const map = parseNavSections(navSections);
  return map[key] !== false;
}

/** Нормализует вход: только известные ключи, значения boolean. */
export function normalizeNavSections(input) {
  const src = parseNavSections(input);
  const out = {};
  for (const key of NAV_SECTION_KEYS) {
    if (src[key] === false) out[key] = false;
    else if (src[key] === true) out[key] = true;
  }
  return out;
}

export function defaultNavSectionsAllEnabled() {
  const out = {};
  for (const key of NAV_SECTION_KEYS) out[key] = true;
  return out;
}

export function navSectionsToFormState(raw) {
  const map = parseNavSections(raw);
  const out = defaultNavSectionsAllEnabled();
  for (const key of NAV_SECTION_KEYS) {
    if (map[key] === false) out[key] = false;
  }
  return out;
}

export function formStateToNavSections(formState) {
  const out = {};
  for (const key of NAV_SECTION_KEYS) {
    if (formState?.[key] === false) out[key] = false;
  }
  return out;
}

/** Для /auth/me → features.nav_* */
export function buildUserNavFeatures(navSections) {
  const map = parseNavSections(navSections);
  const features = {};
  for (const key of NAV_SECTION_KEYS) {
    features[`nav_${key}`] = map[key] !== false;
  }
  return features;
}

export function navSectionKeyForPath(pathname, search = '') {
  const path = String(pathname || '');
  const sp = new URLSearchParams(search || '');
  if (path === '/' || path === '') return 'analytics';
  if (path.startsWith('/products')) return 'products';
  if (path.startsWith('/orders')) return 'orders';
  if (path.startsWith('/shipments')) return 'shipments';
  if (path.startsWith('/stock-levels/fbo-supplies') || path.startsWith('/fbo-supplies')) return 'fbo';
  if (path.startsWith('/questions')) return 'questions';
  if (path.startsWith('/reviews')) return 'reviews';
  if (path.startsWith('/returns') || path.startsWith('/wb-returns')) return 'wb_returns';
  if (path.startsWith('/prices')) return 'prices';
  if (path.startsWith('/production')) return 'warehouse_production';
  if (path.startsWith('/stock-levels/purchases')) return 'warehouse_purchases';
  if (path.startsWith('/stock-levels/warehouse')) {
    const op = sp.get('op') || 'table';
    const opMap = {
      table: 'warehouse_stock',
      receipts_list: 'warehouse_receipts',
      transfer: 'warehouse_transfer',
      return_supplier: 'warehouse_return_supplier',
      return_customer: 'warehouse_return_customer',
      inventory: 'warehouse_inventory',
      writeoff: 'warehouse_writeoff',
    };
    return opMap[op] || 'warehouse_stock';
  }
  if (path.startsWith('/settings/users')) return 'settings_users';
  if (path.startsWith('/settings/roles')) return 'settings_users';
  if (path.startsWith('/settings/attributes')) return 'settings_attributes';
  if (path.startsWith('/settings/labels')) return 'settings_labels';
  if (path.startsWith('/settings')) return 'settings_general';
  if (path.startsWith('/organizations')) return 'organizations';
  if (path.startsWith('/warehouses')) return 'warehouses';
  if (path.startsWith('/suppliers')) return 'suppliers';
  if (path.startsWith('/categories')) return 'categories';
  if (path.startsWith('/brands')) return 'brands';
  if (path.startsWith('/integrations')) return 'integrations';
  if (path.startsWith('/assembly')) return 'orders';
  return null;
}
