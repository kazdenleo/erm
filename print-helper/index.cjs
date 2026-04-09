/**
 * ERM Print Helper — тихая печать этикеток.
 * Запуск только через erm-print-helper.exe (рядом должен быть SumatraPDF.exe).
 * Windows only.
 */

const isPkg = typeof process.pkg !== 'undefined';
if (!isPkg) {
  console.error('Запускайте только erm-print-helper.exe. Node.js на этом ПК не нужен.');
  process.exit(1);
}

// Windows: без окна консоли. Первый процесс сразу перезапускает себя с CREATE_NO_WINDOW и завершается.
// Отладка: set ERM_PRINT_HELPER_SHOW_CONSOLE=1 — без перезапуска, консоль видна.
if (
  process.platform === 'win32' &&
  !process.env.ERM_PRINT_HELPER_CHILD &&
  process.env.ERM_PRINT_HELPER_SHOW_CONSOLE !== '1'
) {
  require('child_process').spawn(process.execPath, process.argv.slice(1), {
    env: { ...process.env, ERM_PRINT_HELPER_CHILD: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  process.exit(0);
}

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process'); // Sumatra + restart
const { PDFDocument } = require('pdf-lib');

const PORT = Number(process.env.PRINT_HELPER_PORT) || 9100;
const app = express();
app.use(cors());

function getExeDir() {
  return path.dirname(process.execPath);
}

// Трей ищет ./traybin относительно cwd — всегда «дом» = папка exe.
try {
  process.chdir(getExeDir());
} catch (_) {}

/** Минимальная иконка 16×16, если рядом с exe нет tray.ico */
function ensureTrayIco(exeDir) {
  const iconPath = path.join(exeDir, 'tray.ico');
  if (fs.existsSync(iconPath)) return iconPath;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 16;
  entry[1] = 16;
  entry[4] = 1;
  entry[6] = 32;
  entry.writeUInt32LE(40 + 16 * 16 * 4, 8);
  entry.writeUInt32LE(22, 12);
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(16, 4);
  dib.writeInt32LE(32, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 16 * 16 * 4; i += 4) {
    pixels[i] = 0x4a;
    pixels[i + 1] = 0x90;
    pixels[i + 2] = 0xe8;
    pixels[i + 3] = 255;
  }
  try {
    fs.writeFileSync(iconPath, Buffer.concat([header, entry, dib, pixels]));
  } catch (_) {}
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

function logTrayDiag(exeDir, message) {
  try {
    fs.appendFileSync(
      path.join(exeDir, 'print-helper.log'),
      `[${new Date().toISOString()}] ${message}\n`
    );
  } catch (_) {}
}

function getSumatraPath() {
  if (process.platform !== 'win32') return null;
  const exe = path.join(getExeDir(), 'SumatraPDF.exe');
  return fs.existsSync(exe) ? exe : null;
}

function getTempLabelDir() {
  const dir = path.join(getExeDir(), 'temp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getExtensionFromContentType(contentType) {
  if (!contentType) return '.pdf';
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct.includes('pdf')) return '.pdf';
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  return '.pdf';
}

function isPdfBuffer(buf) {
  return buf && buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}
function isPngBuffer(buf) {
  return buf && buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

// Размер страницы этикетки: мм → пункты (72 pt = 1 дюйм ≈ 25.4 мм).
function mmToPt(mm) {
  return (mm / 25.4) * 72;
}

/** Парсит labelSize: ширина × высота (мм). 58×40 → страница PDF 58 мм ширина, 40 мм высота. Ориентация как у стикера. */
function parseLabelSize(labelSize) {
  const raw = String(labelSize || '').trim().toLowerCase();
  let wMm = 58;
  let hMm = 40;
  const m = raw.match(/^(\d+)\s*[x×]\s*(\d+)$/);
  if (m) {
    wMm = Math.max(10, Math.min(500, Number(m[1]) || 58));
    hMm = Math.max(10, Math.min(500, Number(m[2]) || 40));
  } else if (raw === '75x120' || raw === '120x75') {
    wMm = 75;
    hMm = 120;
  }
  return { widthPt: mmToPt(wMm), heightPt: mmToPt(hMm) };
}

/** Конвертация PNG в одностраничный PDF с заданным размером страницы (одна этикетка на лист). */
async function pngToPdfBuffer(pngBuffer, labelSizeParam) {
  const { widthPt, heightPt } = parseLabelSize(labelSizeParam);
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(pngBuffer);
  const page = doc.addPage([widthPt, heightPt]);
  const scaled = image.scaleToFit(widthPt, heightPt);
  const x = (widthPt - scaled.width) / 2;
  const y = (heightPt - scaled.height) / 2;
  page.drawImage(image, { x, y, width: scaled.width, height: scaled.height });
  return Buffer.from(await doc.save());
}

function printFile(filePath) {
  const sumatra = getSumatraPath();
  if (!sumatra) {
    return Promise.reject(new Error('Положите SumatraPDF.exe в папку с erm-print-helper.exe.'));
  }
  const fullPath = path.resolve(filePath);
  return new Promise((resolve, reject) => {
    const proc = spawn(sumatra, ['-print-to-default', '-silent', '-exit-when-done', '-print-settings', '1,noscale,landscape', fullPath], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SumatraPDF exit code ${code}`));
    });
  });
}

if (process.platform !== 'win32') {
  console.warn('[print-helper] Работает только на Windows.');
}

app.get('/print', async (req, res) => {
  const { orderId, labelUrl, labelSize } = req.query;
  if (!labelUrl) {
    return res.status(400).json({ ok: false, message: 'Укажите labelUrl' });
  }

  if (process.platform !== 'win32') {
    return res.status(501).json({ ok: false, message: 'Тихая печать только на Windows' });
  }

  let tmpPath = null;
  try {
    const response = await fetch(String(labelUrl), { redirect: 'follow' });
    if (!response.ok) {
      return res.status(502).json({ ok: false, message: `Не удалось загрузить этикетку: ${response.status}` });
    }
    const buf = await response.buffer();
    if (!buf || buf.length === 0) {
      return res.status(502).json({ ok: false, message: 'Этикетка пуста или не загружена для заказа' });
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    if (contentType.includes('text/html')) {
      return res.status(502).json({ ok: false, message: 'Сервер вернул страницу вместо этикетки (проверьте доступ к API)' });
    }
    if (!isPdfBuffer(buf) && !isPngBuffer(buf)) {
      console.error('[print-helper] Файл не PDF и не PNG (первые байты:', buf.slice(0, 20).toString('hex'), '). Возможно, сервер вернул HTML.');
      return res.status(502).json({ ok: false, message: 'Получен не файл этикетки (PDF/PNG). Проверьте, что сервер отдаёт этикетку по этому URL без авторизации.' });
    }

    const tempDir = getTempLabelDir();
    const baseName = `label-${orderId || Date.now()}`;
    let toPrint;
    if (isPngBuffer(buf)) {
      const dims = parseLabelSize(labelSize);
      const pdfBuf = await pngToPdfBuffer(buf, labelSize);
      tmpPath = path.join(tempDir, baseName + '.pdf');
      fs.writeFileSync(tmpPath, pdfBuf);
      toPrint = tmpPath;
      console.log('[print-helper] PNG→PDF:', tmpPath, 'книжная (шир×выс)', Math.round(dims.widthPt / 72 * 25.4) + '×' + Math.round(dims.heightPt / 72 * 25.4) + ' мм', pdfBuf.length, 'байт');
    } else {
      tmpPath = path.join(tempDir, baseName + '.pdf');
      fs.writeFileSync(tmpPath, buf);
      toPrint = tmpPath;
      console.log('[print-helper] Файл:', tmpPath, buf.length, 'байт');
    }

    await printFile(toPrint);
    res.json({ ok: true, message: 'Отправлено на печать' });
  } catch (err) {
    console.error('[print-helper] Ошибка печати:', err.message);
    res.status(500).json({ ok: false, message: err.message || 'Ошибка печати' });
  } finally {
    if (tmpPath) {
      const toDelete = tmpPath;
      setTimeout(() => {
        try { if (fs.existsSync(toDelete)) fs.unlinkSync(toDelete); } catch (_) {}
      }, 60000);
    }
  }
});

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(
    '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>ERM Print Helper</title>' +
    '<style>body{font-family:system-ui,sans-serif;padding:20px;max-width:360px}h1{font-size:1.1rem;margin:0 0 12px 0}p{margin:8px 0;color:#444;font-size:14px}a{color:#0066cc;text-decoration:none}a:hover{text-decoration:underline}.btn{display:inline-block;margin:4px 8px 4px 0;padding:8px 14px;background:#0066cc;color:#fff;border-radius:6px;font-size:14px}.btn:hover{background:#0052a3;color:#fff}.btn.danger{background:#c00}.btn.danger:hover{background:#a00}</style></head><body>' +
    '<h1>ERM Print Helper</h1><p>Сервис тихой печати этикеток запущен в фоне.</p>' +
    '<p><a href="http://127.0.0.1:' + PORT + '/restart" class="btn">Перезапустить</a> <a href="http://127.0.0.1:' + PORT + '/exit" class="btn danger">Выключить</a></p>' +
    '<p><a href="http://127.0.0.1:' + PORT + '/health">Статус сервиса</a></p></body></html>'
  );
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    platform: process.platform,
    sumatraFound: !!getSumatraPath(),
  });
});

// Управление без окна: выход и перезапуск (для запуска через run-tray.vbs)
app.get('/exit', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send('<html><body><p>Print Helper завершён.</p><p><a href="http://127.0.0.1:' + PORT + '">Запустить снова</a> — запустите run-tray.vbs из папки с exe.</p></body></html>');
  setTimeout(() => process.exit(0), 300);
});

app.get('/restart', (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).send('Перезапуск только на Windows');
  }
  const exeDir = getExeDir();
  const vbsPath = path.join(exeDir, 'run-tray.vbs');
  if (!fs.existsSync(vbsPath)) {
    return res.status(404).send('Файл run-tray.vbs не найден рядом с exe. Перезапустите вручную.');
  }
  spawn('wscript.exe', [vbsPath], { cwd: exeDir, detached: true, stdio: 'ignore', windowsHide: true });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send('<html><body><p>Перезапуск… Окно закроется.</p></body></html>');
  setTimeout(() => process.exit(0), 500);
});

// Создать temp при старте и показать путь (папка рядом с exe)
const exeDir = getExeDir();
const tempDir = getTempLabelDir();
console.log('[print-helper] Папка exe:', exeDir);
console.log('[print-helper] Папка temp (этикетки):', tempDir);

let systrayRef = null;

function startTray() {
  if (process.platform !== 'win32') return;
  try {
    const SysTray = require('systray2').default;
    const iconPath = ensureTrayIco(exeDir);
    const vbsPath = path.join(exeDir, 'run-tray.vbs');
    const itemRestart = {
      title: 'Перезапустить',
      tooltip: '',
      checked: false,
      enabled: true,
      click: () => {
        if (fs.existsSync(vbsPath)) {
          spawn('wscript.exe', [vbsPath], { cwd: exeDir, detached: true, stdio: 'ignore', windowsHide: true });
        }
        process.exit(0);
      },
    };
    const itemExit = {
      title: 'Выход',
      tooltip: '',
      checked: false,
      enabled: true,
      click: () => {
        if (systrayRef) systrayRef.kill(false);
        process.exit(0);
      },
    };
    if (!iconPath) {
      logTrayDiag(exeDir, 'Нет tray.ico — трей не запущен');
      return;
    }
    const systray = new SysTray({
      menu: {
        icon: iconPath,
        title: 'ERM Print Helper',
        tooltip: 'Печать этикеток — http://127.0.0.1:' + PORT,
        items: [itemRestart, SysTray.separator, itemExit],
      },
      copyDir: path.join(exeDir, 'traybin'),
      debug: false,
    });
    systrayRef = systray;
    systray.onClick((action) => {
      if (action.item && typeof action.item.click === 'function') action.item.click();
    });
    systray.ready().then(() => {
      console.log('[print-helper] Иконка в трее: правый клик — Перезапустить / Выход.');
    }).catch((err) => {
      logTrayDiag(exeDir, `Трей ready: ${err.message}`);
      console.warn('[print-helper] Трей недоступен:', err.message);
    });
  } catch (err) {
    logTrayDiag(exeDir, `Трей start: ${err.message}`);
    console.warn('[print-helper] Трей недоступен:', err.message);
  }
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[print-helper] http://127.0.0.1:${PORT}`);
  startTray();
});
