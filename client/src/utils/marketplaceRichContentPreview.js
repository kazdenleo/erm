/**
 * Сверстанный предпросмотр Rich-контента (как страница карточки, не сырой JSON).
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function joinContent(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(joinContent).filter(Boolean).join(' ');
  if (typeof node === 'object') return joinContent(node.content);
  return '';
}

function parseOzonJson(payload) {
  if (payload?.json && typeof payload.json === 'object') return payload.json;
  const raw = payload?.jsonString;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function resolvePreviewImageUrl(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t) || t.startsWith('data:image/')) return t;
  if (t.startsWith('/')) {
    try {
      if (typeof window !== 'undefined' && window.location?.origin) {
        return `${window.location.origin}${t}`;
      }
    } catch {
      /* ignore */
    }
  }
  return t;
}

function cssUrl(raw) {
  const u = String(raw || '')
    .replace(/\\/g, '/')
    .replace(/'/g, '%27')
    .replace(/[\r\n]/g, '');
  return `url('${u}')`;
}

function cssFromModuleStyle(style) {
  const s = style && typeof style === 'object' ? style : {};
  const titlePx = { s: '18px', m: '22px', l: '28px', xl: '34px' }[s.titleSize];
  const textPx = { s: '14px', m: '16px', l: '18px', xl: '20px' }[s.textSize];
  const pad = { none: '0', s: '10px 12px', m: '16px 18px', l: '24px 22px' }[s.padding];
  const rad = { none: '0', s: '6px', m: '12px', l: '20px' }[s.radius];
  const parts = [];
  if (s.background) parts.push(`background-color:${String(s.background).replace(/[^#a-fA-F0-9]/g, '')}`);
  if (s.textColor) parts.push(`color:${String(s.textColor).replace(/[^#a-fA-F0-9]/g, '')}`);
  const img = resolvePreviewImageUrl(s.backgroundImage);
  if (img) {
    parts.push(`background-image:${cssUrl(img)}`);
    if (s.backgroundFit === 'repeat') {
      parts.push('background-repeat:repeat');
      parts.push('background-size:auto');
    } else {
      parts.push('background-repeat:no-repeat');
      parts.push(`background-size:${s.backgroundFit === 'contain' ? 'contain' : 'cover'}`);
      parts.push('background-position:center');
    }
    parts.push('min-height:160px');
  }
  if (s.align === 'center' || s.align === 'right' || s.align === 'left') {
    parts.push(`text-align:${s.align}`);
  }
  if (pad) parts.push(`padding:${pad}`);
  if (rad) parts.push(`border-radius:${rad}`);
  if (s.font === 'serif') parts.push("font-family:Georgia,'Times New Roman',serif");
  if (titlePx) parts.push(`--rc-title-size:${titlePx}`);
  if (textPx) parts.push(`--rc-text-size:${textPx}`);
  if (s.titleColor) parts.push(`--rc-title-color:${String(s.titleColor).replace(/[^#a-fA-F0-9]/g, '')}`);
  if (s.boldTitle === false) parts.push('--rc-title-weight:500');
  return parts.join(';');
}

function sectionOpen(style) {
  const css = cssFromModuleStyle(style);
  return css ? `<section class="rc-block rc-block--styled" style="${css}">` : '<section class="rc-block">';
}

function renderTextWidget(widget, style) {
  const title = joinContent(widget.title);
  const text = joinContent(widget.text);
  const paras = Array.isArray(widget.text?.content)
    ? widget.text.content.filter(Boolean)
    : text
      ? [text]
      : [];
  const headingTag = title && paras.length ? 'h2' : 'h1';
  const headingClass = headingTag === 'h1' ? 'rc-title' : 'rc-h';
  return `
    ${sectionOpen(style || widgetStyleFromOzon(widget))}
      ${title ? `<${headingTag} class="${headingClass}">${escapeHtml(title)}</${headingTag}>` : ''}
      ${paras.map((p) => `<p class="rc-text">${escapeHtml(p)}</p>`).join('')}
    </section>
  `;
}

function widgetStyleFromOzon(widget) {
  const size = String(widget?.title?.size || widget?.text?.size || '');
  const align = String(widget?.title?.align || widget?.text?.align || 'left');
  const titleSize = size === 'size5' ? 'xl' : size === 'size4' ? 'l' : size === 'size1' ? 's' : size === 'size2' ? 'm' : '';
  return { align, titleSize, textSize: String(widget?.text?.size) === 'size1' ? 's' : '' };
}

function renderTableWidget(widget, style) {
  const title = joinContent(widget.title);
  const headers = Array.isArray(widget.headers) ? widget.headers : [];
  const body = Array.isArray(widget.body) ? widget.body : [];
  const headRow = headers.length
    ? `<tr>${headers.map((c) => `<th>${escapeHtml(joinContent(c))}</th>`).join('')}</tr>`
    : '';
  const rows = body
    .map((row) => {
      const cells = Array.isArray(row) ? row : [];
      return `<tr>${cells.map((c, i) => `<t${i === 0 ? 'h' : 'd'}>${escapeHtml(joinContent(c))}</t${i === 0 ? 'h' : 'd'}>`).join('')}</tr>`;
    })
    .join('');
  return `
    ${sectionOpen(style || widgetStyleFromOzon(widget))}
      ${title ? `<h2 class="rc-h">${escapeHtml(title)}</h2>` : ''}
      <table class="rc-table">
        ${headRow ? `<thead>${headRow}</thead>` : ''}
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderShowcaseWidget(widget, style) {
  const blocks = Array.isArray(widget.blocks) ? widget.blocks : [];
  const chess = String(widget.type || '') === 'chess' && blocks.length >= 2;
  const items = blocks
    .map((b) => {
      const src = b?.img?.src || b?.img?.srcMobile || '';
      if (!src) return '';
      const alt = b?.img?.alt || joinContent(b?.title) || '';
      const cap = joinContent(b?.text);
      return `
        <figure class="rc-shot">
          <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />
          ${cap ? `<figcaption>${escapeHtml(cap)}</figcaption>` : ''}
        </figure>
      `;
    })
    .join('');
  if (!items) return '';
  return `
    ${sectionOpen(style)}
      <div class="rc-gallery ${chess ? 'rc-gallery--chess' : ''}">${items}</div>
    </section>
  `;
}

function renderOzonWidgets(json) {
  const content = Array.isArray(json?.content) ? json.content : [];
  return content
    .map((w) => {
      const name = String(w?.widgetName || '');
      if (name === 'raText' || name === 'raTextBlock') return renderTextWidget(w);
      if (name === 'raTable') return renderTableWidget(w);
      if (name === 'raShowcase') return renderShowcaseWidget(w);
      return '';
    })
    .join('');
}

function renderStructuredText(description) {
  const raw = String(description || '').trim();
  if (!raw) return '<p class="rc-muted">Нет текста описания.</p>';
  const blocks = [];
  let list = [];
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul class="rc-list">${list.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      flushList();
      continue;
    }
    if (t.startsWith('• ') || t.startsWith('- ')) {
      list.push(t.replace(/^[•\-]\s*/, ''));
      continue;
    }
    flushList();
    if (/^(Характеристики|Описание)\s*:?\s*$/i.test(t)) {
      blocks.push(`<h2 class="rc-h">${escapeHtml(t.replace(/:$/, ''))}</h2>`);
    } else if (blocks.length === 0) {
      blocks.push(`<h1 class="rc-title">${escapeHtml(t)}</h1>`);
    } else {
      blocks.push(`<p class="rc-text">${escapeHtml(t)}</p>`);
    }
  }
  flushList();
  return `<section class="rc-block">${blocks.join('')}</section>`;
}

const PAGE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #f2f3f5; }
  body { font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif; color: #1a1a1a; }
  .rc-page { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  .rc-card { background: #fff; border-radius: 16px; padding: 28px 24px 36px; box-shadow: 0 8px 28px rgba(0,0,0,.06); }
  .rc-mp { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: #7a7a7a; margin: 0 0 8px; }
  .rc-block { margin: 0 0 28px; }
  .rc-block--styled { overflow: hidden; background-repeat: no-repeat; }
  .rc-title { font-size: var(--rc-title-size, 28px); line-height: 1.25; margin: 0 0 10px; font-weight: var(--rc-title-weight, 700); color: var(--rc-title-color, inherit); }
  .rc-h { font-size: var(--rc-title-size, 20px); margin: 0 0 12px; font-weight: var(--rc-title-weight, 700); color: var(--rc-title-color, inherit); }
  .rc-text { font-size: var(--rc-text-size, 16px); line-height: 1.55; margin: 0 0 10px; color: inherit; }
  .rc-muted { color: #888; font-size: 14px; }
  .rc-table { width: 100%; border-collapse: collapse; font-size: var(--rc-text-size, 15px); }
  .rc-table th, .rc-table td { padding: 10px 12px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
  .rc-table thead th { color: #888; font-weight: 600; font-size: 13px; }
  .rc-table tbody th { width: 42%; color: #666; font-weight: 500; background: #fafafa; }
  .rc-block--styled .rc-table tbody th { background: transparent; color: inherit; }
  .rc-gallery { display: grid; gap: 12px; grid-template-columns: 1fr; }
  .rc-gallery--chess { grid-template-columns: 1fr 1fr; }
  .rc-shot { margin: 0; }
  .rc-shot img { width: 100%; display: block; border-radius: 12px; background: #f6f6f6; object-fit: contain; max-height: 520px; }
  .rc-shot figcaption { font-size: 13px; color: #666; margin-top: 6px; }
  .rc-list { margin: 0; padding-left: 20px; }
  .rc-list li { margin: 0 0 6px; line-height: 1.45; }
  @media (max-width: 640px) {
    .rc-title { font-size: var(--rc-title-size, 22px); }
    .rc-gallery--chess { grid-template-columns: 1fr; }
  }
`;

const MP_TITLE = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };

function wrapPreviewPage(marketplace, inner) {
  const mp = String(marketplace || '').toLowerCase();
  const label = MP_TITLE[mp] || mp;
  let baseHref = '';
  try {
    if (typeof window !== 'undefined' && window.location?.origin) {
      baseHref = `<base href="${escapeHtml(`${window.location.origin}/`)}" />`;
    }
  } catch {
    baseHref = '';
  }
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${baseHref}
  <title>Предпросмотр Rich-контента — ${escapeHtml(label)}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="rc-page">
    <div class="rc-card">
      <p class="rc-mp">${escapeHtml(label)} · предпросмотр вёрстки</p>
      ${inner}
    </div>
  </div>
</body>
</html>`;
}

function renderResolvedBlocks(blocks) {
  return (blocks || [])
    .map((block) => {
      if (block.type === 'heading') {
        return renderTextWidget(
          {
            title: { content: block.title },
            text: { content: block.subtitle ? [block.subtitle] : [] },
          },
          block.style
        );
      }
      if (block.type === 'text') {
        return renderTextWidget(
          {
            title: { content: block.title },
            text: { content: block.body ? [block.body] : [] },
          },
          block.style
        );
      }
      if (block.type === 'characteristics') {
        return renderTableWidget(
          {
            title: { content: block.title },
            body: (block.rows || []).map((row) => [
              { content: row.name },
              { content: row.value },
            ]),
          },
          block.style
        );
      }
      if (block.type === 'list') {
        const title = block.title ? `<h2 class="rc-h">${escapeHtml(block.title)}</h2>` : '';
        const items = (block.items || [])
          .map((x) => `<li>${escapeHtml(x)}</li>`)
          .join('');
        return `${sectionOpen(block.style)}${title}<ul class="rc-list">${items}</ul></section>`;
      }
      if (block.type === 'images') {
        return renderShowcaseWidget(
          {
            blocks: (block.urls || []).map((src) => ({ img: { src } })),
          },
          block.style
        );
      }
      return '';
    })
    .join('');
}

function resolvedBlocksToText(blocks) {
  const lines = [];
  for (const block of blocks || []) {
    if (block.type === 'heading') {
      if (block.title) lines.push(block.title);
      if (block.subtitle) lines.push(block.subtitle);
      lines.push('');
    } else if (block.type === 'text') {
      if (block.title) lines.push(block.title);
      if (block.body) lines.push(block.body);
      lines.push('');
    } else if (block.type === 'characteristics') {
      if (block.title) lines.push(`${block.title}:`);
      for (const row of block.rows || []) lines.push(`• ${row.name}: ${row.value}`);
      lines.push('');
    } else if (block.type === 'list') {
      if (block.title) lines.push(block.title);
      for (const item of block.items || []) lines.push(`• ${item}`);
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildRichContentPreviewHtml(marketplace, payload) {
  const mp = String(marketplace || '').toLowerCase();
  if (Array.isArray(payload?.previewBlocks) && payload.previewBlocks.length) {
    return buildRichContentPreviewHtmlFromResolved(mp, payload.previewBlocks);
  }
  let inner = '';
  if (mp === 'ozon') {
    const json = parseOzonJson(payload);
    inner = json ? renderOzonWidgets(json) : '<p class="rc-muted">Нет JSON Rich-контента.</p>';
  } else {
    inner = renderStructuredText(payload?.description);
  }
  return wrapPreviewPage(mp, inner);
}

export function buildRichContentPreviewHtmlFromResolved(marketplace, blocks) {
  const mp = String(marketplace || 'ozon').toLowerCase();
  const inner =
    mp === 'ozon'
      ? renderResolvedBlocks(blocks) || '<p class="rc-muted">Модули пока ничего не выводят.</p>'
      : renderStructuredText(resolvedBlocksToText(blocks));
  return wrapPreviewPage(mp, inner);
}

export function hasRichContentPreview(marketplace, payload) {
  if (!payload) return false;
  if (Array.isArray(payload.previewBlocks) && payload.previewBlocks.length) return true;
  const mp = String(marketplace || '').toLowerCase();
  if (mp === 'ozon') return Boolean(parseOzonJson(payload));
  return Boolean(String(payload.description || '').trim());
}

export function openRichContentPreviewPage(marketplace, payload) {
  const html = buildRichContentPreviewHtml(marketplace, payload);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener');
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error('Браузер заблокировал новое окно. Разрешите всплывающие окна для предпросмотра.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return win;
}
