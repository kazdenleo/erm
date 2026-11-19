/**
 * Шрифты для SVG→PNG этикеток (sharp/librsvg).
 * На Linux без системного Arial кириллица иначе рисуется «иероглифами»/квадратами.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(__dirname, '../../assets/fonts');

export const LABEL_FONT_FAMILY = 'ERMLabel';

let cachedCss = null;

function readFontBase64(fileName) {
  const full = path.join(FONTS_DIR, fileName);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full).toString('base64');
}

/** CSS @font-face с DejaVu (кириллица), для вставки в &lt;defs&gt;&lt;style&gt; SVG. */
export function getLabelSvgFontFaceCss() {
  if (cachedCss != null) return cachedCss;
  const regular = readFontBase64('DejaVuSans.ttf');
  const bold = readFontBase64('DejaVuSans-Bold.ttf');
  if (!regular) {
    cachedCss = '';
    return cachedCss;
  }
  const faces = [
    `@font-face{font-family:'${LABEL_FONT_FAMILY}';src:url('data:font/ttf;base64,${regular}') format('truetype');font-weight:400;font-style:normal;}`,
  ];
  if (bold) {
    faces.push(
      `@font-face{font-family:'${LABEL_FONT_FAMILY}';src:url('data:font/ttf;base64,${bold}') format('truetype');font-weight:700;font-style:normal;}`
    );
  }
  cachedCss = faces.join('\n');
  return cachedCss;
}

/** font-family для &lt;text&gt;: встроенный ERMLabel, иначе системные с кириллицей. */
export function labelSvgFontFamily({ monospace = false } = {}) {
  if (monospace) {
    return `'${LABEL_FONT_FAMILY}', Consolas, 'Courier New', monospace`;
  }
  return `'${LABEL_FONT_FAMILY}', 'DejaVu Sans', Arial, sans-serif`;
}

/** Обернуть SVG: добавить @font-face в defs, если ещё нет. */
export function ensureLabelSvgFonts(svg) {
  const css = getLabelSvgFontFaceCss();
  if (!css) return svg;
  const s = String(svg);
  if (s.includes(`font-family:'${LABEL_FONT_FAMILY}'`) || s.includes(`font-family="${LABEL_FONT_FAMILY}"`)) {
    if (s.includes('@font-face') && s.includes(LABEL_FONT_FAMILY)) return s;
  }
  const styleBlock = `<defs><style type="text/css"><![CDATA[\n${css}\n]]></style></defs>`;
  if (/<defs[\s>]/i.test(s)) {
    return s.replace(/<defs([^>]*)>/i, `<defs$1><style type="text/css"><![CDATA[\n${css}\n]]></style>`);
  }
  return s.replace(/<svg([^>]*)>/i, `<svg$1>${styleBlock}`);
}
