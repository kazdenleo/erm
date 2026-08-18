/**
 * Модули шаблона Rich-контента категории.
 * Копия server/src/utils/richContentTemplate.js для предпросмотра в конструкторе.
 */

export const RICH_MODULE_TYPES = [
  { type: 'heading', label: 'Заголовок' },
  { type: 'text', label: 'Текст' },
  { type: 'characteristics', label: 'Характеристики' },
  { type: 'list', label: 'Список' },
  { type: 'images', label: 'Фото' },
];

export const RICH_ALIGN_OPTIONS = [
  { value: 'left', label: 'Слева' },
  { value: 'center', label: 'По центру' },
  { value: 'right', label: 'Справа' },
];

export const RICH_SIZE_OPTIONS = [
  { value: '', label: 'По умолчанию' },
  { value: 's', label: 'Маленький' },
  { value: 'm', label: 'Обычный' },
  { value: 'l', label: 'Крупный' },
  { value: 'xl', label: 'Очень крупный' },
];

export const RICH_FONT_OPTIONS = [
  { value: 'sans', label: 'Без засечек' },
  { value: 'serif', label: 'С засечками' },
];

export const RICH_SPACE_OPTIONS = [
  { value: '', label: 'По умолчанию' },
  { value: 'none', label: 'Нет' },
  { value: 's', label: 'Маленький' },
  { value: 'm', label: 'Средний' },
  { value: 'l', label: 'Большой' },
];

export const RICH_BG_PRESETS = [
  { value: '', label: 'Без фона' },
  { value: '#f4f5f7', label: 'Серый' },
  { value: '#eef4ff', label: 'Голубой' },
  { value: '#f3f0ea', label: 'Песочный' },
  { value: '#111827', label: 'Тёмный' },
];

export const RICH_BG_FIT_OPTIONS = [
  { value: 'cover', label: 'Заполнить' },
  { value: 'contain', label: 'Поместить целиком' },
  { value: 'repeat', label: 'Повторять' },
];

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function asHex(v) {
  const t = String(v || '').trim();
  if (!HEX_RE.test(t)) return '';
  if (t.length === 4) {
    return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`.toLowerCase();
  }
  return t.toLowerCase();
}

export function asBackgroundImageUrl(raw) {
  const t = String(raw || '').trim();
  if (!t || t.length > 1500) return '';
  if (/[\s<>'"]/.test(t)) return '';
  if (/^(javascript|data|vbscript):/i.test(t)) return '';
  if (/^https:\/\//i.test(t)) return t;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(t)) return t;
  if (/^\/uploads\/rich-content\/[A-Za-z0-9._-]+$/i.test(t)) return t;
  return '';
}

export function normalizeModuleStyle(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const size = (v) => (['s', 'm', 'l', 'xl'].includes(v) ? v : '');
  const space = (v) => (['none', 's', 'm', 'l'].includes(v) ? v : '');
  const fit = ['cover', 'contain', 'repeat'].includes(s.backgroundFit) ? s.backgroundFit : 'cover';
  return {
    background: asHex(s.background),
    backgroundImage: asBackgroundImageUrl(s.backgroundImage),
    backgroundFit: fit,
    titleColor: asHex(s.titleColor),
    textColor: asHex(s.textColor),
    align: ['left', 'center', 'right'].includes(s.align) ? s.align : 'left',
    titleSize: size(s.titleSize),
    textSize: size(s.textSize),
    font: s.font === 'serif' ? 'serif' : 'sans',
    boldTitle: s.boldTitle !== false,
    padding: space(s.padding),
    radius: space(s.radius),
  };
}

function newId(type) {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function defaultRichContentModules() {
  return [
    {
      id: 'heading',
      type: 'heading',
      enabled: true,
      source: 'name',
      text: '',
      showBrand: true,
    },
    {
      id: 'chars',
      type: 'characteristics',
      enabled: true,
      mode: 'auto',
      title: 'Характеристики',
      includeBrand: true,
      includeSku: true,
      fields: [],
    },
    {
      id: 'desc',
      type: 'text',
      enabled: true,
      source: 'description',
      title: 'Описание',
      text: '',
    },
    {
      id: 'photos',
      type: 'images',
      enabled: true,
      max: 6,
    },
  ];
}

function asField(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(raw.key || raw.id || '').trim();
  const label = String(raw.label || raw.name || '').trim();
  if (!key && !label) return null;
  return { key: key || label, label: label || key };
}

export function normalizeRichContentModules(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) return defaultRichContentModules();
  return list.map((mod, idx) => {
    const type = RICH_MODULE_TYPES.some((t) => t.type === mod?.type) ? mod.type : 'text';
    const base = {
      id: String(mod?.id || `${type}-${idx}`),
      type,
      enabled: mod?.enabled !== false,
      style: normalizeModuleStyle(mod?.style),
    };
    if (type === 'heading') {
      return {
        ...base,
        source: mod?.source === 'custom' ? 'custom' : 'name',
        text: String(mod?.text || ''),
        showBrand: mod?.showBrand !== false,
      };
    }
    if (type === 'text') {
      const src = String(mod?.source || 'description');
      return {
        ...base,
        source: ['description', 'custom', 'brand'].includes(src) ? src : 'description',
        title: String(mod?.title || ''),
        text: String(mod?.text || ''),
      };
    }
    if (type === 'characteristics') {
      return {
        ...base,
        mode: mod?.mode === 'selected' ? 'selected' : 'auto',
        title: String(mod?.title || 'Характеристики'),
        includeBrand: mod?.includeBrand !== false,
        includeSku: mod?.includeSku !== false,
        fields: Array.isArray(mod?.fields) ? mod.fields.map(asField).filter(Boolean) : [],
      };
    }
    if (type === 'list') {
      const items = Array.isArray(mod?.items)
        ? mod.items.map((x) => String(x || '').trim()).filter(Boolean)
        : String(mod?.text || '')
            .split(/\r?\n/)
            .map((x) => x.replace(/^[•\-]\s*/, '').trim())
            .filter(Boolean);
      return {
        ...base,
        title: String(mod?.title || ''),
        items,
      };
    }
    return {
      ...base,
      max: Math.min(15, Math.max(1, Number(mod?.max) || 6)),
    };
  });
}

export function createRichContentModule(type) {
  const t = RICH_MODULE_TYPES.some((x) => x.type === type) ? type : 'text';
  const style = normalizeModuleStyle({});
  if (t === 'heading') {
    return { id: newId(t), type: t, enabled: true, source: 'name', text: '', showBrand: true, style };
  }
  if (t === 'text') {
    return { id: newId(t), type: t, enabled: true, source: 'custom', title: '', text: '', style };
  }
  if (t === 'characteristics') {
    return {
      id: newId(t),
      type: t,
      enabled: true,
      mode: 'auto',
      title: 'Характеристики',
      includeBrand: true,
      includeSku: true,
      fields: [],
      style,
    };
  }
  if (t === 'list') {
    return { id: newId(t), type: t, enabled: true, title: '', items: [''], style };
  }
  return { id: newId(t), type: 'images', enabled: true, max: 6, style };
}

export function fillRichPlaceholders(text, ctx = {}) {
  let out = String(text || '');
  const map = {
    name: ctx.name || '',
    brand: ctx.brand || '',
    sku: ctx.sku || '',
    description: ctx.description || '',
  };
  out = out.replace(/\{\{\s*(name|brand|sku|description)\s*\}\}/gi, (_, key) => map[key.toLowerCase()] || '');
  out = out.replace(/\{\{\s*attr:([^}]+)\s*\}\}/gi, (_, rawKey) => {
    const key = String(rawKey || '').trim();
    if (!key) return '';
    const byId = ctx.attrsById instanceof Map ? ctx.attrsById.get(key) : ctx.attrsById?.[key];
    if (byId) return byId.value || '';
    const byName = ctx.attrsByName instanceof Map
      ? ctx.attrsByName.get(key.toLowerCase())
      : ctx.attrsByName?.[key.toLowerCase()];
    return byName?.value || '';
  });
  return out.replace(/\s+/g, ' ').trim();
}

function pickCharacteristics(mod, ctx) {
  const rows = [];
  const seen = new Set();
  const push = (name, value) => {
    const n = String(name || '').trim();
    const v = String(value || '').trim();
    if (!n || !v) return;
    const k = n.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({ name: n, value: v });
  };
  if (mod.includeBrand) push('Бренд', ctx.brand);
  if (mod.includeSku) push('Артикул', ctx.sku);
  const all = Array.isArray(ctx.characteristics) ? ctx.characteristics : [];
  if (mod.mode === 'selected' && Array.isArray(mod.fields) && mod.fields.length) {
    for (const field of mod.fields) {
      const key = String(field.key || '').trim();
      const label = String(field.label || field.key || '').trim();
      const hit =
        all.find((r) => String(r.id) === key || String(r.name).toLowerCase() === key.toLowerCase()) ||
        (ctx.attrsById instanceof Map ? ctx.attrsById.get(key) : null) ||
        (ctx.attrsByName instanceof Map ? ctx.attrsByName.get(key.toLowerCase()) : null);
      push(label || hit?.name, hit?.value);
    }
    return rows;
  }
  for (const row of all) push(row.name, row.value);
  return rows;
}

export function parseStoredRichContentModules(raw) {
  if (raw == null || raw === '') return null;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || !value.length) return null;
  const modules = normalizeRichContentModules(value);
  return modules.length ? modules : null;
}

export function syncCharacteristicsFields(modules, available) {
  const avail = (available || []).map(asField).filter(Boolean);
  const byKey = new Map(avail.map((f) => [String(f.key), f]));
  return normalizeRichContentModules(modules).map((mod) => {
    if (mod.type !== 'characteristics') return mod;
    const prev = Array.isArray(mod.fields) ? mod.fields : [];
    const kept = prev
      .map((f) => {
        const fresh = byKey.get(String(f.key));
        return fresh ? { ...f, label: fresh.label || f.label } : f;
      })
      .filter((f) => f.key);
    const have = new Set(kept.map((f) => String(f.key)));
    const added = avail.filter((f) => !have.has(String(f.key)));
    return { ...mod, fields: [...kept, ...added] };
  });
}

export function resolveRichModulesForRender(modules, ctx) {
  const out = [];
  for (const mod of normalizeRichContentModules(modules)) {
    if (!mod.enabled) continue;
    if (mod.type === 'heading') {
      const title =
        mod.source === 'custom'
          ? fillRichPlaceholders(mod.text, ctx)
          : String(ctx.name || '').trim();
      const subtitle = mod.showBrand && ctx.brand ? `Бренд: ${ctx.brand}` : '';
      if (!title && !subtitle) continue;
      out.push({ type: 'heading', title, subtitle, style: mod.style });
      continue;
    }
    if (mod.type === 'text') {
      let body = '';
      if (mod.source === 'description') body = String(ctx.description || '').trim();
      else if (mod.source === 'brand') body = String(ctx.brand || '').trim();
      else body = fillRichPlaceholders(mod.text, ctx);
      const title = fillRichPlaceholders(mod.title, ctx);
      if (!body && !title) continue;
      out.push({ type: 'text', title, body, style: mod.style });
      continue;
    }
    if (mod.type === 'characteristics') {
      const rows = pickCharacteristics(mod, ctx);
      if (!rows.length) continue;
      out.push({ type: 'characteristics', title: mod.title || 'Характеристики', rows, style: mod.style });
      continue;
    }
    if (mod.type === 'list') {
      const items = (mod.items || [])
        .map((x) => fillRichPlaceholders(x, ctx))
        .filter(Boolean);
      if (!items.length) continue;
      out.push({ type: 'list', title: fillRichPlaceholders(mod.title, ctx), items, style: mod.style });
      continue;
    }
    if (mod.type === 'images') {
      const urls = (ctx.imageUrls || []).slice(0, mod.max || 6);
      if (!urls.length) continue;
      out.push({ type: 'images', urls, style: mod.style });
    }
  }
  return out;
}

export function sampleRichContentContext(available = []) {
  const characteristics = (available || []).slice(0, 8).map((f) => ({
    id: String(f.key),
    name: f.label || f.key,
    value: 'пример',
  }));
  if (!characteristics.length) {
    characteristics.push({ id: 'oem', name: 'OEM', value: '1K0411303' });
  }
  const attrsById = new Map();
  const attrsByName = new Map();
  for (const row of characteristics) {
    attrsById.set(String(row.id), row);
    attrsByName.set(String(row.name).toLowerCase(), row);
  }
  return {
    name: 'Стойка стабилизатора передняя',
    brand: 'Zekkert',
    sku: 'SS-1234',
    description: 'Передняя стойка стабилизатора для легковых автомобилей.',
    characteristics,
    attrsById,
    attrsByName,
    imageUrls: [],
  };
}
