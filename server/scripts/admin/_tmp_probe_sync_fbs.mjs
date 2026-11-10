import jwt from 'jsonwebtoken';
import 'dotenv/config';

const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

await fetch('http://localhost:3001/api/orders/sync-fbs/reset', { method: 'POST', headers });
const syncRes = await fetch('http://localhost:3001/api/orders/sync-fbs', {
  method: 'POST',
  headers,
  body: JSON.stringify({ refreshStatuses: true, daysBack: 7 }),
});
console.log('POST', syncRes.status, await syncRes.json().then((j) => ({ started: j.started })));

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = await (await fetch('http://localhost:3001/api/orders/sync-fbs/status', { headers })).json();
  const d = st.data || {};
  if (!d.inProgress) {
    console.log(
      JSON.stringify(
        {
          err: d.lastSyncError,
          wb: d.lastSyncResult?.wildberries,
          oz: d.lastSyncResult?.ozon,
          ym: d.lastSyncResult?.yandex,
        },
        null,
        2
      )
    );
    process.exit(0);
  }
  if (i % 5 === 0) console.log('… still in progress', i * 2, 's');
}
console.log('timeout waiting for sync');
