import 'dotenv/config';
import { FBO_SUPPLY_STATUSES } from '../../src/constants/fboSupplyStatuses.js';
import { readFileSync } from 'fs';

console.log('runtime_FBO_SUPPLY_STATUSES', FBO_SUPPLY_STATUSES);

const file = readFileSync(
  new URL('../../src/constants/fboSupplyStatuses.js', import.meta.url),
  'utf8'
);
console.log('file_head', file.split('\n').slice(0, 35).join('\n'));

// Simulate parseFboListStatuses
const allowed = new Set(FBO_SUPPLY_STATUSES);
const raw = 'new,collecting,packing,ready_for_supply'.split(',');
const out = [];
for (const part of raw) {
  const key = String(part || '').trim().toLowerCase();
  if (!key || !allowed.has(key) || out.includes(key)) continue;
  out.push(key);
}
console.log('parsed_statuses', out);
console.log(
  'would_drop',
  raw.filter((x) => !allowed.has(x.trim().toLowerCase()))
);

process.exit(0);
