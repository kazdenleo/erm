/**
 * Тестовая генерация Rich-контента карточки из уже заполненных полей.
 * Ozon: JSON виджетов (атрибут 11254). WB / YM: структурированный текст описания
 * (отдельного Rich JSON в их Content API нет).
 */

export const OZON_RICH_CONTENT_ATTR_ID = 11254;
export const OZON_SIZE_TABLE_ATTR_ID = 13164;
export const OZON_ANNOTATION_ATTR_ID = 4191;

const OZON_SKIP_ATTR_IDS = new Set([
  OZON_RICH_CONTENT_ATTR_ID,
  OZON_SIZE_TABLE_ATTR_ID,
  OZON_ANNOTATION_ATTR_ID,
  21837,
  21841,
]);

const WB_SKIP_CHARC_IDS = new Set(['90849', '90745', '90846', '90652', '90673', '90630']);

const MAX_TABLE_ROWS = 18;
const MAX_CELL = 180;
const MAX_DESC = 4500;
const MAX_OZON_IMAGES = 6;
const WB_YM_DESC_MAX = 5000;

function asText(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'Да' : 'Нет';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) {
    return v.map((x) => asText(x)).filter(Boolean).join(', ');
  }
  if (typeof v === 'object') {
    if (v.dictionary_value_id != null && v.value == null && v.id == null) {
      return '';
    }
    const inner = v.value ?? v.id ?? v.name ?? v.text;
    if (inner != null && typeof inner !== 'object') return asText(inner);
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  return String(v).trim();
}

function stripDictArrow(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const idx = t.indexOf('->');
  if (idx > 0) return t.slice(0, idx).trim();
  return t;
}

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function skipAttrName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  if (/rich.?контент|rich.?content|json/i.test(n)) return true;
  if (/^описани|^аннотац|^html/.test(n)) return true;
  if (/изображен|видео|инфографик/.test(n)) return true;
  if (/^(длина|ширина|высота)\s+(упаковк|товар)/.test(n)) return true;
  if (/^вес\s+(с\s+)?упаковк|^вес\s+товар/.test(n)) return true;
  return false;
}

function isPublicHttpUrl(url) {
  const u = String(url || '').trim();
  if (!/^https:\/\//i.test(u)) return false;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (host.endsWith('.local')) return false;
    return true;
  } catch {
    return false;
  }
}

function uniquePairs(pairs) {
  const out = [];
  const seen = new Set();
  for (const p of pairs || []) {
    const name = clip(p?.name, 80);
    const value = clip(stripDictArrow(asText(p?.value)), MAX_CELL);
    if (!name || !value) continue;
    if (skipAttrName(name)) continue;
    const key = `${name.toLowerCase()}::${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, value });
    if (out.length >= MAX_TABLE_ROWS) break;
  }
  return out;
}

const OZON_SIZE_BY_KEY = { s: 'size1', m: 'size2', l: 'size4', xl: 'size5' };

function hexLuminance(hex) {
  const t = String(hex || '').replace('#', '');
  if (t.length !== 6) return 0.2;
  const n = parseInt(t, 16);
  if (!Number.isFinite(n)) return 0.2;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function ozonTokensFromStyle(style, role = 'text') {
  const s = style && typeof style === 'object' ? style : {};
  const sizeKey = role === 'title' ? s.titleSize || 'l' : s.textSize || 'm';
  const hex = role === 'title' ? s.titleColor : s.textColor;
  let color = 'color1';
  if (hex && hexLuminance(hex) > 0.5) color = 'color2';
  const align = ['left', 'center', 'right'].includes(s.align) ? s.align : 'left';
  return {
    size: OZON_SIZE_BY_KEY[sizeKey] || (role === 'title' ? 'size4' : 'size2'),
    align,
    color,
  };
}

function textWidget(title, paragraphs, style) {
  const titleTok = ozonTokensFromStyle(style, 'title');
  const textTok = ozonTokensFromStyle(style, 'text');
  const widget = { widgetName: 'raText' };
  if (title) {
    widget.title = {
      content: [clip(title, 120)],
      size: titleTok.size,
      align: titleTok.align,
      color: titleTok.color,
    };
  }
  const lines = (Array.isArray(paragraphs) ? paragraphs : [paragraphs])
    .map((x) => clip(x, MAX_DESC))
    .filter(Boolean);
  if (lines.length) {
    widget.text = {
      size: textTok.size,
      align: textTok.align,
      color: textTok.color,
      content: lines,
    };
  }
  return widget;
}

function tableWidget(title, rows, style) {
  const titleTok = ozonTokensFromStyle(style, 'title');
  const textTok = ozonTokensFromStyle(style, 'text');
  return {
    widgetName: 'raTable',
    title: {
      content: [clip(title, 80)],
      size: titleTok.size,
      align: titleTok.align,
      color: titleTok.color,
    },
    headers: [
      { content: ['Параметр'], color: 'color2', align: textTok.align },
      { content: ['Значение'], color: 'color2', align: textTok.align },
    ],
    body: rows.map((row) => [
      { content: [row.name], color: textTok.color, align: textTok.align },
      { content: [row.value], color: textTok.color, align: textTok.align },
    ]),
  };
}

function showcaseWidget(urls) {
  const blocks = urls.slice(0, MAX_OZON_IMAGES).map((src) => ({
    img: {
      src,
      srcMobile: src,
      alt: '',
      width: 900,
      height: 1200,
      widthMobile: 640,
      heightMobile: 853,
    },
    imgLink: '',
    title: { content: null },
    text: { content: null },
  }));
  return {
    widgetName: 'raShowcase',
    type: blocks.length >= 2 ? 'chess' : 'roll',
    blocks,
    text: { content: null },
  };
}

/**
 * @param {{
 *   name?: string,
 *   brand?: string,
 *   sku?: string,
 *   description?: string,
 *   characteristics?: Array<{ name?: string, value?: * }>,
 *   imageUrls?: string[],
 * }} input
 */
export function buildOzonRichContentFromResolved(blocks) {
  const content = [];
  for (const block of blocks || []) {
    if (!block) continue;
    if (block.type === 'heading') {
      content.push(textWidget(block.title, block.subtitle ? [block.subtitle] : [], block.style));
      continue;
    }
    if (block.type === 'text') {
      content.push(textWidget(block.title, block.body ? [block.body] : [], block.style));
      continue;
    }
    if (block.type === 'characteristics' && Array.isArray(block.rows) && block.rows.length) {
      content.push(tableWidget(block.title || 'Характеристики', block.rows, block.style));
      continue;
    }
    if (block.type === 'list' && Array.isArray(block.items) && block.items.length) {
      content.push(textWidget(block.title, block.items.map((x) => `• ${x}`), block.style));
      continue;
    }
    if (block.type === 'images' && Array.isArray(block.urls) && block.urls.length) {
      content.push(showcaseWidget(block.urls));
    }
  }
  if (!content.length) {
    content.push(textWidget('Товар', ['Недостаточно данных карточки для Rich-контента.']));
  }
  return { content, version: 0.3 };
}

export function buildStructuredDescriptionFromResolved(blocks, { maxLen = WB_YM_DESC_MAX } = {}) {
  const lines = [];
  for (const block of blocks || []) {
    if (!block) continue;
    if (block.type === 'heading') {
      if (block.title) lines.push(block.title);
      if (block.subtitle) lines.push(block.subtitle);
      lines.push('');
      continue;
    }
    if (block.type === 'text') {
      if (block.title) lines.push(block.title);
      if (block.body) lines.push(block.body);
      lines.push('');
      continue;
    }
    if (block.type === 'characteristics' && block.rows?.length) {
      if (block.title) lines.push(`${block.title}:`);
      for (const row of block.rows) lines.push(`• ${row.name}: ${row.value}`);
      lines.push('');
      continue;
    }
    if (block.type === 'list' && block.items?.length) {
      if (block.title) lines.push(block.title);
      for (const item of block.items) lines.push(`• ${item}`);
      lines.push('');
    }
  }
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) text = 'Товар';
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 1).trim()}…`;
  return text;
}

export function buildOzonRichContentJson(input = {}) {
  const name = clip(input.name, 200);
  const brand = clip(input.brand, 80);
  const sku = clip(input.sku, 80);
  const description = clip(String(input.description || '').replace(/<[^>]+>/g, ' '), MAX_DESC);
  const characteristics = uniquePairs([
    brand ? { name: 'Бренд', value: brand } : null,
    sku ? { name: 'Артикул', value: sku } : null,
    ...(input.characteristics || []),
  ].filter(Boolean));
  const images = (input.imageUrls || []).filter(isPublicHttpUrl).slice(0, MAX_OZON_IMAGES);

  const content = [];
  if (name) content.push(textWidget(name, brand ? [`Бренд: ${brand}`] : []));
  if (characteristics.length) content.push(tableWidget('Характеристики', characteristics));
  if (description) content.push(textWidget('Описание', [description]));
  if (images.length) content.push(showcaseWidget(images));

  if (!content.length) {
    content.push(textWidget(name || sku || 'Товар', ['Недостаточно данных карточки для Rich-контента.']));
  }

  return {
    content,
    version: 0.3,
  };
}

export function stringifyOzonRichContent(json) {
  return JSON.stringify(json);
}

function structuredDescription(input = {}, { maxLen = WB_YM_DESC_MAX } = {}) {
  const name = clip(input.name, 200);
  const brand = clip(input.brand, 80);
  const sku = clip(input.sku, 80);
  const description = clip(String(input.description || '').replace(/<[^>]+>/g, ' '), MAX_DESC);
  const characteristics = uniquePairs([
    brand ? { name: 'Бренд', value: brand } : null,
    sku ? { name: 'Артикул', value: sku } : null,
    ...(input.characteristics || []),
  ].filter(Boolean));

  const lines = [];
  if (name) lines.push(name, '');
  if (characteristics.length) {
    lines.push('Характеристики:');
    for (const row of characteristics) {
      lines.push(`• ${row.name}: ${row.value}`);
    }
    lines.push('');
  }
  if (description) {
    lines.push('Описание:', description);
  }
  let text = lines.join('\n').trim();
  if (!text) text = [name, sku].filter(Boolean).join(' ') || 'Товар';
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 1).trim()}…`;
  return text;
}

export function buildWbStructuredDescription(input = {}) {
  return structuredDescription(input);
}

export function buildYmStructuredDescription(input = {}) {
  return structuredDescription(input);
}

export function isOzonRichContentAttrId(id) {
  const n = Number(id);
  return n === OZON_RICH_CONTENT_ATTR_ID || n === OZON_SIZE_TABLE_ATTR_ID;
}

export function shouldSkipOzonAttrForRichTable(id, name) {
  const n = Number(id);
  if (Number.isFinite(n) && OZON_SKIP_ATTR_IDS.has(n)) return true;
  return skipAttrName(name);
}

export function shouldSkipWbCharcForRichTable(id, name) {
  if (WB_SKIP_CHARC_IDS.has(String(id))) return true;
  return skipAttrName(name);
}

export { isPublicHttpUrl, uniquePairs, stripDictArrow, asText };
