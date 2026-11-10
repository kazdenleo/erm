import fs from 'fs';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(line.slice(0, i) in process.env)) process.env[line.slice(0, i)] = v;
}

const { closePool } = await import('../../src/config/database.js');
const { startMpStockPushInBackground, getMpStockPushStatus } = await import(
  '../../src/services/marketplaceStockPush.job.js'
);

console.log('before', getMpStockPushStatus());
const started = startMpStockPushInBackground('1', {
  profileId: '1',
  source: 'admin_resume_after_master_flag',
  force: true,
});
console.log('started', started);

for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = getMpStockPushStatus();
  const brief = {
    inProgress: st.inProgress,
    lastError: st.lastError || null,
    result: st.lastResult
      ? {
          pushed: st.lastResult.pushed,
          failed: st.lastResult.failed,
          skipped: st.lastResult.skipped,
          productsTotal: st.lastResult.productsTotal,
        }
      : null,
  };
  console.log('tick', i, JSON.stringify(brief));
  if (!st.inProgress && i > 0) break;
}

await closePool();
process.exit(0);
