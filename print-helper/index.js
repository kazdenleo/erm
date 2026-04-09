/**
 * Локальный Print Helper для ERM
 * Слушает запросы на печать этикетки и отправляет файл на принтер без диалога (тихая печать).
 * Запускается на рабочем месте сборки. После сборки заказа клиент вызывает GET /print?orderId=...&labelUrl=...
 * Поддерживается только Windows (используется pdf-to-printer).
 */

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { print } from 'pdf-to-printer';

const PORT = Number(process.env.PRINT_HELPER_PORT) || 9100;
const app = express();
app.use(cors());

if (process.platform !== 'win32') {
  console.warn('[print-helper] Работает только на Windows. На других ОС печать через этот сервис недоступна.');
}

function getExtensionFromContentType(contentType) {
  if (!contentType) return '.pdf';
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct.includes('pdf')) return '.pdf';
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  return '.pdf';
}

app.get('/print', async (req, res) => {
  const { orderId, labelUrl } = req.query;
  if (!labelUrl) {
    return res.status(400).json({ ok: false, message: 'Укажите labelUrl' });
  }

  if (process.platform !== 'win32') {
    return res.status(501).json({ ok: false, message: 'Тихая печать поддерживается только на Windows' });
  }

  let tmpPath = null;
  try {
    const response = await fetch(String(labelUrl), { redirect: 'follow' });
    if (!response.ok) {
      return res.status(502).json({ ok: false, message: `Не удалось загрузить этикетку: ${response.status}` });
    }
    const contentType = response.headers.get('content-type');
    const ext = getExtensionFromContentType(contentType);
    const buf = await response.buffer();
    tmpPath = path.join(os.tmpdir(), `erm-label-${orderId || Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, buf);

    await print(tmpPath, { silent: true });
    res.json({ ok: true, message: 'Отправлено на печать' });
  } catch (err) {
    console.error('[print-helper] Ошибка печати:', err.message);
    res.status(500).json({ ok: false, message: err.message || 'Ошибка печати' });
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, platform: process.platform });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[print-helper] Слушаю http://127.0.0.1:${PORT}. Печать: GET /print?orderId=...&labelUrl=...`);
});
