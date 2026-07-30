/**
 * После react-scripts build каталоги в build/ иногда получают 0700 (umask).
 * Также /opt/erm/client может быть 700 — nginx (www-data) не сможет пройти к build/
 * → отдаёт 404/HTML вместо SPA.
 */
const fs = require('fs');
const path = require('path');

const clientDir = path.join(__dirname, '..');
const buildDir = path.join(clientDir, 'build');

function fixPerms(targetPath, isDir) {
  try {
    fs.chmodSync(targetPath, isDir ? 0o755 : 0o644);
  } catch (err) {
    console.warn(`[fix-build-perms] skip ${targetPath}: ${err.message}`);
  }
}

function walk(dir) {
  fixPerms(dir, true);
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else fixPerms(full, false);
  }
}

// Родитель client/: иначе 700 блокирует traverse к build/ для www-data.
fixPerms(clientDir, true);

if (!fs.existsSync(buildDir)) {
  process.exit(0);
}

walk(buildDir);
console.log('[fix-build-perms] client/ 755; build/ permissions set to 755/644');