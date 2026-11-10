import fs from 'fs';
const d = JSON.parse(fs.readFileSync('/root/.pm2/dump.pm2', 'utf8'));
const p = d.find((x) => x.name === 'erm-api');
console.log(
  JSON.stringify(
    {
      max_memory_restart: p?.max_memory_restart,
      kill_timeout: p?.kill_timeout,
      node_args: p?.node_args,
      restart_time: p?.restart_time,
      unstable_restarts: p?.unstable_restarts,
      created_at: p?.pm_id != null ? p.pm_uptime : null,
      env_keys: Object.keys(p?.env || {}).filter((k) => /OZON|ORDERS|MEMORY|NODE/i.test(k)),
    },
    null,
    2
  )
);
