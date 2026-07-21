/**
 * После react-scripts build каталоги в build/ часто получают 0700 (umask).
 * Nginx (www-data) не может читать static/ и architectui/ — сайт отдаёт 404/HTML.
 */
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');

if (!fs.existsSync(buildDir)) {
  process.exit(0);
}

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

walk(buildDir);
console.log('[fix-build-perms] build/ permissions set to 755/644');
