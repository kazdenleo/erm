import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveMarketplaceIdentifiersPath() {
  const fromRepo = path.join(__dirname, '../../../docs/marketplace-product-identifiers.md');
  if (fs.existsSync(fromRepo)) return fromRepo;
  const fromCwd = path.join(process.cwd(), 'docs/marketplace-product-identifiers.md');
  if (fs.existsSync(fromCwd)) return fromCwd;
  return null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * GET /api/help/marketplace-product-identifiers
 * Читает markdown из репозитория и отдаёт как простую HTML-страницу (удобно открыть из браузера).
 */
export function marketplaceProductIdentifiersHelp(req, res) {
  const filePath = resolveMarketplaceIdentifiersPath();
  if (!filePath) {
    return res.status(404).type('text/plain; charset=utf-8').send('Файл справочника не найден на сервере.');
  }
  let md = '';
  try {
    md = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return res.status(500).type('text/plain; charset=utf-8').send(`Ошибка чтения справочника: ${e?.message || e}`);
  }
  const body = escapeHtml(md);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Идентификаторы товара на маркетплейсах — ERM</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; line-height: 1.5; max-width: 52rem; margin: 0 auto; padding: 1rem 1.25rem; color: #222; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 14px; margin: 0; }
    .nav { margin-bottom: 1rem; font-size: 14px; }
    a { color: #0d6efd; }
  </style>
</head>
<body>
  <div class="nav"><a href="/">← В приложение</a></div>
  <pre>${body}</pre>
</body>
</html>`);
}
