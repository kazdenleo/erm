import fs from 'fs';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(line.slice(0, i) in process.env)) process.env[line.slice(0, i)] = v;
}

const ordersSync = await import('../../src/services/orders.sync.service.js');
const mpPush = await import('../../src/services/marketplaceStockPush.job.js');

const getOrdersStatus =
  ordersSync.getSyncFbsStatus ||
  ordersSync.getOrdersSyncStatus ||
  ordersSync.default?.getSyncFbsStatus ||
  null;

console.log('ordersSync exports', Object.keys(ordersSync).filter((k) => /sync|status|progress|lock/i.test(k)));
console.log('mpPush exports', Object.keys(mpPush));

try {
  if (typeof mpPush.getMpStockPushStatus === 'function') {
    console.log('mpStockPush', mpPush.getMpStockPushStatus());
  }
} catch (e) {
  console.log('mpStockPush err', e.message);
}

try {
  const mod = ordersSync.default || ordersSync;
  for (const name of Object.keys(ordersSync)) {
    if (/status/i.test(name) && typeof ordersSync[name] === 'function') {
      try {
        console.log(name, ordersSync[name]());
      } catch (e) {
        console.log(name, 'err', e.message);
      }
    }
  }
  if (mod && typeof mod.getStatus === 'function') console.log('default.getStatus', mod.getStatus());
} catch (e) {
  console.log('orders status err', e.message);
}

process.exit(0);
