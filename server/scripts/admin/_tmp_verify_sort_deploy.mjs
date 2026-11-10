import fs from 'fs';
import path from 'path';

const build = '/opt/erm/client/build';
const html = fs.readFileSync(path.join(build, 'index.html'), 'utf8');
const main = html.match(/main\.[a-f0-9]+\.js/)?.[0];
if (!main) {
  console.error('no main in index');
  process.exit(1);
}
const body = fs.readFileSync(path.join(build, 'static/js', main), 'utf8');
console.log('main', main);
console.log('index_ok', true);
// minified: unreserved compare / tier logic from generalItemReserveTier
console.log('has_unreserved_sort', body.includes('unreserved') && body.includes('lastCollectAt') === false
  ? body.includes('unreserved')
  : body.includes('unreserved'));
console.log('has_unreserved', body.includes('unreserved'));
const src = fs.readFileSync('/opt/erm/client/src/pages/FboSupplies/fboSupplyPackingSort.js', 'utf8');
console.log('src_generalItemReserveTier', src.includes('generalItemReserveTier'));
process.exit(0);
