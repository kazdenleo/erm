import 'dotenv/config';
import { query } from '../../src/config/database.js';
import fs from 'fs';
import path from 'path';

const buildDir = '/opt/erm/client/build';
const jsDir = path.join(buildDir, 'static/js');
const html = fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8');
const m = html.match(/main\.[a-f0-9]+\.js/);
console.log('index.html main', m?.[0] || null);

const mains = fs
  .readdirSync(jsDir)
  .filter((f) => f.startsWith('main.') && f.endsWith('.js'))
  .map((f) => ({ f, mtime: fs.statSync(path.join(jsDir, f)).mtimeMs, size: fs.statSync(path.join(jsDir, f)).size }))
  .sort((a, b) => b.mtime - a.mtime);
console.log(
  'mains',
  mains.slice(0, 8).map((x) => `${x.f} size=${x.size} mtime=${new Date(x.mtime).toISOString()}`)
);

const target = m?.[0] || mains[0]?.f;
if (!target) {
  console.error('no main js');
  process.exit(1);
}
const body = fs.readFileSync(path.join(jsDir, target), 'utf8');
console.log('checking', target);
for (const s of [
  'Собирается',
  'Упаковывается',
  'Сборка',
  'lastCollectAt',
  'isFboSupplyActivityFresh',
  'Готова к отгрузке',
  'Упакован',
]) {
  console.log(s, body.includes(s));
}

const src = fs.readFileSync('/opt/erm/client/src/constants/fboSupplyStatuses.js', 'utf8');
console.log('src has Собирается', src.includes('Собирается'));
console.log('src has FBO_SUPPLY_ACTIVE_MS', src.includes('FBO_SUPPLY_ACTIVE_MS'));

const cols = await query(
  `SELECT column_name
   FROM information_schema.columns
   WHERE table_name = 'fbo_supplies'
     AND column_name IN ('last_collect_at', 'last_pack_at')
   ORDER BY 1`
);
console.log('cols', cols.rows);

const statuses = await query(
  `SELECT status, COUNT(*)::int AS n FROM fbo_supplies GROUP BY 1 ORDER BY 1`
);
console.log('statuses', statuses.rows);

process.exit(0);
