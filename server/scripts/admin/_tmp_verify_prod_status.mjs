import { query, closePool } from '../../src/config/database.js';
import fs from 'fs';

const c = await query(
  `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='fbo_supplies_status_check'`
);
console.log('DB:', c.rows[0]?.def || 'MISSING');

const checks = [
  ['server statuses', '/opt/erm/server/src/constants/fboSupplyStatuses.js', 'collecting'],
  ['packing check', '/opt/erm/server/src/utils/fboSupplyPackingCheck.js', 'ensureFboSupplyStatusAtLeast'],
  ['collect promote', '/opt/erm/server/src/services/fboSuppliesCollect.service.js', 'collecting'],
  ['client statuses', '/opt/erm/client/src/constants/fboSupplyStatuses.js', 'Сборка'],
  ['hover unreserved', '/opt/erm/client/src/pages/FboSupplies/fboSupplyItemReserve.js', 'Не в резерве'],
];
for (const [label, path, needle] of checks) {
  const txt = fs.readFileSync(path, 'utf8');
  console.log(label + ':', txt.includes(needle) ? 'OK' : 'MISSING');
}

const js = fs.readdirSync('/opt/erm/client/build/static/js').filter((f) => f.startsWith('main.') && f.endsWith('.js'));
const css = fs.readdirSync('/opt/erm/client/build/static/css').filter((f) => f.startsWith('main.') && f.endsWith('.css'));
const newest = (files, dir) =>
  files
    .map((f) => ({ f, m: fs.statSync(`${dir}/${f}`).mtime }))
    .sort((a, b) => b.m - a.m)[0];
const j = newest(js, '/opt/erm/client/build/static/js');
const cfile = newest(css, '/opt/erm/client/build/static/css');
console.log('build js:', j?.f, j?.m?.toISOString());
console.log('build css:', cfile?.f, cfile?.m?.toISOString());

await closePool();
