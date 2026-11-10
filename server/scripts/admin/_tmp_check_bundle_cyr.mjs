import fs from 'fs';
import path from 'path';

const html = fs.readFileSync('/opt/erm/client/build/index.html', 'utf8');
const main = html.match(/main\.[a-f0-9]+\.js/)?.[0];
const file = path.join('/opt/erm/client/build/static/js', main);
const buf = fs.readFileSync(file);
const s = buf.toString('utf8');
console.log('file', main, 'size', buf.length);

function has(str) {
  return buf.includes(Buffer.from(str, 'utf8'));
}

for (const str of [
  'Собирается',
  'Упаковывается',
  'Сборка',
  'Упаковка',
  'Готова к отгрузке',
  'lastCollectAt',
  'FBO_SUPPLY_ACTIVE_MS',
  'isFboSupplyActivityFresh',
]) {
  console.log(JSON.stringify(str), has(str));
}

const i = s.indexOf('lastCollectAt');
console.log('--- context around lastCollectAt ---');
console.log(s.slice(Math.max(0, i - 250), i + 450));

const src = fs.readFileSync('/opt/erm/client/src/constants/fboSupplyStatuses.js');
console.log('src bytes has Собирается', src.includes(Buffer.from('Собирается', 'utf8')));
console.log('src mtime', fs.statSync('/opt/erm/client/src/constants/fboSupplyStatuses.js').mtime.toISOString());
console.log('bundle mtime', fs.statSync(file).mtime.toISOString());
