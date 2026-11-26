/**
 * Модель раскладки интернет-магазина (редактор на тарифе Про).
 * Шаблоны задают стартовый layout; без Про можно только переключать template_code.
 */

export const STORE_EDITOR_FEATURE = 'storeEditor';

export const STORE_LAYOUT_VERSION = 1;

export const STORE_BLOCK_TYPES = Object.freeze([
  {
    type: 'hero',
    name: 'Шапка / герой',
    blurb: 'Название, слоган и кнопка',
  },
  {
    type: 'banner',
    name: 'Баннер',
    blurb: 'Картинка с ссылкой',
  },
  {
    type: 'featured',
    name: 'Подборка товаров',
    blurb: 'Выбранные SKU с витрины',
  },
  {
    type: 'catalog',
    name: 'Каталог',
    blurb: 'Сетка или список товаров',
  },
  {
    type: 'rich_text',
    name: 'Текст',
    blurb: 'Произвольный текстовый блок',
  },
  {
    type: 'contacts',
    name: 'Контакты',
    blurb: 'Телефон, email, адрес магазина',
  },
]);

const ALLOWED_TYPES = new Set(STORE_BLOCK_TYPES.map((b) => b.type));

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function block(type, props = {}, enabled = true) {
  return {
    id: uid(type),
    type,
    enabled: enabled !== false,
    props: props && typeof props === 'object' ? props : {},
  };
}

/** Стартовая раскладка по коду шаблона. */
export function defaultLayoutForTemplate(templateCode) {
  const t = String(templateCode || 'minimal').toLowerCase();
  if (t === 'showcase') {
    return {
      version: STORE_LAYOUT_VERSION,
      blocks: [
        block('hero', { showCta: true, ctaLabel: 'Смотреть каталог', ctaHref: '#catalog' }),
        block('banner', { imageUrl: '', href: '', alt: '' }, false),
        block('featured', { title: 'Хиты', productIds: [] }),
        block('catalog', { title: 'Все товары', anchor: 'catalog' }),
        block('rich_text', { title: '', body: '' }, false),
        block('contacts', {}),
      ],
    };
  }
  if (t === 'catalog') {
    return {
      version: STORE_LAYOUT_VERSION,
      blocks: [
        block('hero', { showCta: false, compact: true }),
        block('catalog', { title: 'Каталог', density: 'list', anchor: 'catalog' }),
        block('contacts', {}),
      ],
    };
  }
  return {
    version: STORE_LAYOUT_VERSION,
    blocks: [
      block('hero', { showCta: false }),
      block('catalog', { title: '', anchor: 'catalog' }),
      block('contacts', {}),
    ],
  };
}

export function defaultThemeFromStore({ brandColor, logoUrl } = {}) {
  const brand = /^#[0-9a-fA-F]{6}$/.test(String(brandColor || ''))
    ? String(brandColor).toLowerCase()
    : '#0f766e';
  return {
    brandColor: brand,
    accentColor: brand,
    backgroundColor: '#f8fafc',
    surfaceColor: '#ffffff',
    textColor: '#0f172a',
    mutedColor: '#64748b',
    fontHeading: 'system',
    fontBody: 'system',
    borderRadius: 14,
    logoUrl: logoUrl || null,
  };
}

function sanitizeBlockProps(type, props) {
  const p = props && typeof props === 'object' && !Array.isArray(props) ? props : {};
  switch (type) {
    case 'hero':
      return {
        title: String(p.title || '').slice(0, 200),
        subtitle: String(p.subtitle || '').slice(0, 500),
        showCta: p.showCta !== false,
        ctaLabel: String(p.ctaLabel || 'Смотреть каталог').slice(0, 80),
        ctaHref: String(p.ctaHref || '#catalog').slice(0, 300),
        compact: p.compact === true,
      };
    case 'banner':
      return {
        imageUrl: String(p.imageUrl || '').slice(0, 2000),
        href: String(p.href || '').slice(0, 500),
        alt: String(p.alt || '').slice(0, 200),
      };
    case 'featured': {
      const ids = Array.isArray(p.productIds)
        ? p.productIds
            .map((x) => Number(x))
            .filter((n) => Number.isFinite(n) && n > 0)
            .slice(0, 24)
        : [];
      return {
        title: String(p.title || 'Подборка').slice(0, 120),
        productIds: ids,
      };
    }
    case 'catalog':
      return {
        title: String(p.title || '').slice(0, 120),
        anchor: String(p.anchor || 'catalog').slice(0, 64),
        density: p.density === 'list' ? 'list' : 'grid',
        limit: (() => {
          const n = Number(p.limit);
          return Number.isFinite(n) && n > 0 ? Math.min(500, Math.round(n)) : null;
        })(),
      };
    case 'rich_text':
      return {
        title: String(p.title || '').slice(0, 120),
        body: String(p.body || '').slice(0, 8000),
      };
    case 'contacts':
      return {};
    default:
      return {};
  }
}

/** Нормализация layout от клиента / БД. */
export function sanitizeLayout(raw, { templateCode } = {}) {
  const fallback = defaultLayoutForTemplate(templateCode);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks) || raw.blocks.length === 0) {
    return fallback;
  }
  const blocks = [];
  for (const b of raw.blocks) {
    if (!b || typeof b !== 'object') continue;
    const type = String(b.type || '').trim();
    if (!ALLOWED_TYPES.has(type)) continue;
    blocks.push({
      id: String(b.id || uid(type)).slice(0, 64),
      type,
      enabled: b.enabled !== false,
      props: sanitizeBlockProps(type, b.props),
    });
  }
  if (!blocks.length) return fallback;
  if (!blocks.some((b) => b.type === 'catalog')) {
    blocks.push(block('catalog', { title: 'Каталог', anchor: 'catalog' }));
  }
  return {
    version: STORE_LAYOUT_VERSION,
    blocks: blocks.slice(0, 40),
  };
}

export function normalizeStoreTheme(raw, storeLike = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const base = defaultThemeFromStore(storeLike);
  const merged = { ...base, ...src };
  const hex = (v, def) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v).toLowerCase() : def);
  const radius = Number(merged.borderRadius);
  return {
    brandColor: hex(merged.brandColor, base.brandColor),
    accentColor: hex(merged.accentColor, hex(merged.brandColor, base.brandColor)),
    backgroundColor: hex(merged.backgroundColor, base.backgroundColor),
    surfaceColor: hex(merged.surfaceColor, base.surfaceColor),
    textColor: hex(merged.textColor, base.textColor),
    mutedColor: hex(merged.mutedColor, base.mutedColor),
    fontHeading: ['system', 'serif', 'display'].includes(String(merged.fontHeading))
      ? String(merged.fontHeading)
      : 'system',
    fontBody: ['system', 'serif'].includes(String(merged.fontBody))
      ? String(merged.fontBody)
      : 'system',
    borderRadius: Number.isFinite(radius) ? Math.min(24, Math.max(0, Math.round(radius))) : 14,
    logoUrl:
      merged.logoUrl != null && String(merged.logoUrl).trim()
        ? String(merged.logoUrl).trim().slice(0, 2000)
        : null,
  };
}

export function resolveStoreLayout(store) {
  const templateCode = store?.templateCode || 'minimal';
  const hasBlocks =
    store?.layoutJson &&
    typeof store.layoutJson === 'object' &&
    Array.isArray(store.layoutJson.blocks) &&
    store.layoutJson.blocks.length > 0;
  return sanitizeLayout(hasBlocks ? store.layoutJson : null, { templateCode });
}

export function resolveStoreTheme(store) {
  return normalizeStoreTheme(store?.themeJson, {
    brandColor: store?.brandColor,
    logoUrl: store?.logoUrl,
  });
}
