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

function renderTextWidget(widget) {
  const title = joinContent(widget.title);
  const text = joinContent(widget.text);
  const paras = Array.isArray(widget.text?.content)
    ? widget.text.content.filter(Boolean)
    : text
      ? [text]
      : [];
  return `
    <section class="rc-block">
      ${title ? `<h1 class="rc-title">${escapeHtml(title)}</h1>` : ''}
      ${paras.map((p) => `<p class="rc-text">${escapeHtml(p)}</p>`).join('')}
    </section>
  `;
}

function renderTableWidget(widget) {
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
    <section class="rc-block">
      ${title ? `<h2 class="rc-h">${escapeHtml(title)}</h2>` : ''}
      <table class="rc-table">
        ${headRow ? `<thead>${headRow}</thead>` : ''}
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderShowcaseWidget(widget) {
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
    <section class="rc-block">
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
  .rc-title { font-size: 28px; line-height: 1.25; margin: 0 0 10px; font-weight: 700; }
  .rc-h { font-size: 20px; margin: 0 0 12px; font-weight: 700; }
  .rc-text { font-size: 16px; line-height: 1.55; margin: 0 0 10px; color: #2b2b2b; }
  .rc-muted { color: #888; font-size: 14px; }
  .rc-table { width: 100%; border-collapse: collapse; font-size: 15px; }
  .rc-table th, .rc-table td { padding: 10px 12px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
  .rc-table thead th { color: #888; font-weight: 600; font-size: 13px; }
  .rc-table tbody th { width: 42%; color: #666; font-weight: 500; background: #fafafa; }
  .rc-gallery { display: grid; gap: 12px; grid-template-columns: 1fr; }
  .rc-gallery--chess { grid-template-columns: 1fr 1fr; }
  .rc-shot { margin: 0; }
  .rc-shot img { width: 100%; display: block; border-radius: 12px; background: #f6f6f6; object-fit: contain; max-height: 520px; }
  .rc-shot figcaption { font-size: 13px; color: #666; margin-top: 6px; }
  .rc-list { margin: 0; padding-left: 20px; }
  .rc-list li { margin: 0 0 6px; line-height: 1.45; }
  @media (max-width: 640px) {
    .rc-title { font-size: 22px; }
    .rc-gallery--chess { grid-template-columns: 1fr; }
  }
`;

const MP_TITLE = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };

export function buildRichContentPreviewHtml(marketplace, payload) {
  const mp = String(marketplace || '').toLowerCase();
  const label = MP_TITLE[mp] || mp;
  let inner = '';
  if (mp === 'ozon') {
    const json = parseOzonJson(payload);
    inner = json ? renderOzonWidgets(json) : '<p class="rc-muted">Нет JSON Rich-контента.</p>';
  } else {
    inner = renderStructuredText(payload?.description);
  }
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
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

export function hasRichContentPreview(marketplace, payload) {
  if (!payload) return false;
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
