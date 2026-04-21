/**
 * Сборка ERM Print Helper в один .exe и папку для распространения.
 * Требуется: Node.js 18+, npm install уже выполнен.
 * Результат: dist/erm-print-helper.exe + dist/SumatraPDF.exe (+ README)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname);
const distDir = path.join(root, 'dist');

function run(cmd, opts = {}) {
  console.log('>', cmd);
  return execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
}

/** Поиск editbin (Visual Studio / Build Tools) для SUBSYSTEM:WINDOWS */
function findEditbin() {
  const envPath = process.env.EDITBIN_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const vswhere =
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (!fs.existsSync(vswhere)) return null;
  try {
    const install = execSync(
      `"${vswhere}" -latest -products * -property installationPath`,
      { encoding: 'utf8' }
    ).trim();
    if (!install) return null;
    const msvcRoot = path.join(install, 'VC', 'Tools', 'MSVC');
    if (!fs.existsSync(msvcRoot)) return null;
    const versions = fs.readdirSync(msvcRoot).sort().reverse();
    for (const v of versions) {
      const ed = path.join(msvcRoot, v, 'bin', 'Hostx64', 'x64', 'editbin.exe');
      if (fs.existsSync(ed)) return ed;
    }
  } catch (_) {}
  return null;
}

// Папка dist
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

// Иконка для трея (если ещё не создана)
const trayIcoSrc = path.join(root, 'assets', 'tray.ico');
if (!fs.existsSync(trayIcoSrc)) {
  run('node create-tray-icon.cjs');
}

// Скачать бинарник трея для systray2 (меню в трее)
const trayDir = path.join(root, 'node_modules', 'systray2', 'traybin');
const trayExe = path.join(trayDir, 'tray_windows_release.exe');
if (!fs.existsSync(trayExe)) {
  console.log('Скачивание tray_windows_release.exe для меню в трее...');
  fs.mkdirSync(trayDir, { recursive: true });
  const url = 'https://github.com/felixhao28/systray-portable/releases/download/latest/tray_windows_release.exe';
  try {
    if (process.platform === 'win32') {
      execSync(`powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${trayExe.replace(/'/g, "''")}' -UseBasicParsing"`, { cwd: root, stdio: 'inherit' });
    } else {
      execSync(`curl -sL -o "${trayExe}" "${url}"`, { cwd: root, stdio: 'inherit' });
    }
    if (fs.existsSync(trayExe)) console.log('tray_windows_release.exe загружен.');
  } catch (e) {
    console.warn('Не удалось скачать tray. Меню в трее будет недоступно. Скачайте вручную и положите в node_modules/systray2/traybin/');
  }
}

// Сборка через pkg; node16 чаще есть в кэше (при ошибке попробуйте: npx pkg index.cjs -t node18-win-x64 -o dist/erm-print-helper.exe)
const outExeRel = 'dist/erm-print-helper.exe';
const outExeAbs = path.join(root, outExeRel);
// pkg сам делает unlink целевого файла. Если старый erm-print-helper.exe занят (процесс/антивирус) —
// EPERM. Собираем всегда во временный уникальный файл, затем подменяем финальное имя.
const tempOutRel = `dist/erm-print-helper.build.${Date.now()}.exe`;
const tempOutAbs = path.join(root, tempOutRel);
run(`npx pkg index.cjs --targets node16-win-x64 --output ${tempOutRel}`);
try {
  if (!fs.existsSync(tempOutAbs)) {
    throw new Error(`pkg did not produce ${tempOutRel}`);
  }
  try {
    if (fs.existsSync(outExeAbs)) fs.unlinkSync(outExeAbs);
  } catch (e) {
    console.warn(
      'Could not replace dist/erm-print-helper.exe (file may be in use). Leaving build as:',
      path.basename(tempOutRel)
    );
    console.warn('Stop erm-print-helper (tray) or close apps locking the exe, then run npm run build:exe again.');
  }
  if (fs.existsSync(tempOutAbs)) {
    if (!fs.existsSync(outExeAbs)) {
      fs.renameSync(tempOutAbs, outExeAbs);
    }
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}

const mainExe = path.join(distDir, 'erm-print-helper.exe');
if (fs.existsSync(trayExe)) {
  const distTrayBin = path.join(distDir, 'traybin');
  fs.mkdirSync(distTrayBin, { recursive: true });
  fs.copyFileSync(trayExe, path.join(distTrayBin, 'tray_windows_release.exe'));
  console.log('traybin/tray_windows_release.exe скопирован в dist/ (иконка в трее)');
}

if (process.platform === 'win32' && fs.existsSync(mainExe)) {
  const editbin = findEditbin();
  if (editbin) {
    try {
      execSync(`"${editbin}" /SUBSYSTEM:WINDOWS "${mainExe}"`, { stdio: 'inherit' });
      console.log('editbin: подсистема WINDOWS — запуск без окна консоли.');
    } catch (e) {
      console.warn('editbin не выполнен:', e.message);
    }
  } else {
    console.warn('');
    console.warn('editbin.exe не найден. Установите «Desktop development with C++» / VS Build Tools,');
    console.warn('или задайте переменную EDITBIN_PATH на полный путь к editbin.exe');
    console.warn('(для exe без мигания консоли). Иначе используется скрытый перезапуск процесса.');
    console.warn('');
  }
}

// Копируем SumatraPDF: в pdf-to-printer он может быть в dist/ или в корне пакета
const ppt = path.join(root, 'node_modules', 'pdf-to-printer');
let sumatraSrc = null;
if (fs.existsSync(ppt)) {
  const candidates = [
    path.join(ppt, 'dist', 'SumatraPDF-3.4.6-32.exe'),
    path.join(ppt, 'SumatraPDF-3.4.6-32.exe'),
    path.join(ppt, 'SumatraPDF.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      sumatraSrc = c;
      break;
    }
  }
  const dir = path.join(ppt, 'dist');
  if (!sumatraSrc && fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.exe'));
    if (files.length) sumatraSrc = path.join(dir, files[0]);
  }
}

const sumatraDst = path.join(distDir, 'SumatraPDF.exe');
if (sumatraSrc) {
  fs.copyFileSync(sumatraSrc, sumatraDst);
  console.log('SumatraPDF скопирован в dist/SumatraPDF.exe');
} else {
  console.warn('');
  console.warn('SumatraPDF не найден в node_modules/pdf-to-printer.');
  console.warn('Скачайте вручную: https://www.sumatrapdfreader.org/download-free-pdf-viewer');
  console.warn('Положите SumatraPDF.exe в папку dist/ рядом с erm-print-helper.exe.');
  console.warn('');
}

// Копируем VBS-лаунчер и иконку трея
const vbsSrc = path.join(root, 'run-tray.vbs');
if (fs.existsSync(vbsSrc)) {
  fs.copyFileSync(vbsSrc, path.join(distDir, 'run-tray.vbs'));
  console.log('run-tray.vbs скопирован в dist/');
}
const trayIco = path.join(root, 'assets', 'tray.ico');
if (fs.existsSync(trayIco)) {
  fs.copyFileSync(trayIco, path.join(distDir, 'tray.ico'));
  console.log('tray.ico скопирован в dist/');
}

// Краткая инструкция в dist
const readme = `ERM Print Helper — тихая печать этикеток (только exe)

Распространяйте всю папку dist/ целиком (exe, traybin/, tray.ico, SumatraPDF.exe …).

1. Запуск: erm-print-helper.exe. Консоли нет; иконка в области уведомлений
   (Win11: стрелка «Показать скрытые значки» — перетащите иконку на панель).
   Правый клик по иконке — Перезапустить / Выход.
   Также: http://127.0.0.1:9100/

2. Отладка с консолью: cmd → set ERM_PRINT_HELPER_SHOW_CONSOLE=1 && erm-print-helper.exe
   Лог ошибок трея: print-helper.log в папке с exe.

3. Рядом с exe нужны SumatraPDF.exe, папка traybin, файл tray.ico.

4. На сервере ERM: PRINT_HELPER_URL=http://127.0.0.1:9100

Автозапуск: ярлык на erm-print-helper.exe в shell:startup.
Node.js на ПК не нужен.
`;
fs.writeFileSync(path.join(distDir, 'README.txt'), readme, 'utf8');
console.log('Готово. Папка для распространения: dist/');
console.log('  - erm-print-helper.exe (+ editbin WINDOWS при наличии VS Build Tools)');
console.log('  - traybin/tray_windows_release.exe, tray.ico');
console.log('  - SumatraPDF.exe', sumatraSrc ? '(скопирован)' : '(положите вручную)');
console.log('  - README.txt');
