/**
 * Downloads Controller
 * Раздача установочных файлов (в т.ч. Print Helper).
 */

import fs from 'fs';
import path from 'path';
import config from '../config/index.js';

function getDownloadsDir() {
  return path.join(config.paths.dataDir, 'downloads');
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export async function downloadPrintHelperInstaller(req, res) {
  const downloadsDir = getDownloadsDir();
  const fileName = 'erm-print-helper-setup.exe';
  const filePath = path.join(downloadsDir, fileName);
  const st = statSafe(filePath);
  if (!st || !st.isFile()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({
      ok: false,
      message:
        `Установщик Print Helper не найден на сервере. ` +
        `Положите файл в ${downloadsDir.replace(/\\/g, '/')} под именем ${fileName}.`,
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(st.size));
  return res.download(filePath, fileName);
}

