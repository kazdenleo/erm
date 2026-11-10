import fs from 'fs';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(line.slice(0, i) in process.env)) process.env[line.slice(0, i)] = v;
}

const { query, closePool } = await import('../../src/config/database.js');
const { decryptConfigSecrets, resetSecretsCryptoCache } = await import('../../src/utils/secretsCrypto.js');
resetSecretsCryptoCache();

console.log(
  'warehouses push flags',
  (
    await query(
      `SELECT id, name, type,
              push_marketplace_stock, push_stock_ozon, push_stock_wb, push_stock_ym
       FROM warehouses
       WHERE type IS DISTINCT FROM 'supplier'
       ORDER BY id`
    )
  ).rows
);

console.log(
  'ozon mappings',
  (
    await query(
      `SELECT wm.id, w.name AS erp, wm.marketplace, wm.external_warehouse_id, wm.organization_id
       FROM warehouse_mappings wm
       LEFT JOIN warehouses w ON w.id = wm.warehouse_id
       WHERE lower(wm.marketplace) LIKE '%ozon%'
       ORDER BY wm.id`
    )
  ).rows
);

const ints = await query(
  `SELECT id, code, profile_id, organization_id, config
   FROM integrations
   WHERE lower(code) LIKE '%ozon%'
   ORDER BY id`
);
for (const row of ints.rows) {
  const cfg = decryptConfigSecrets(
    typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {}
  );
  const clientId = cfg.client_id ?? cfg.clientId ?? null;
  const apiKey = cfg.api_key ?? cfg.apiKey ?? null;
  console.log(
    JSON.stringify({
      id: row.id,
      profile_id: row.profile_id,
      organization_id: row.organization_id,
      clientId: clientId ? String(clientId) : null,
      apiKeyLen: apiKey ? String(apiKey).length : 0,
      apiKeyLooksEnc: String(apiKey || '').startsWith('enc:v1:'),
      apiKeyPrefix: apiKey ? String(apiKey).slice(0, 4) : null,
    })
  );

  if (clientId && apiKey && !String(apiKey).startsWith('enc:')) {
    const response = await fetch('https://api-seller.ozon.ru/v1/warehouse/list', {
      method: 'POST',
      headers: {
        'Client-Id': String(clientId),
        'Api-Key': String(apiKey),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const text = await response.text();
    console.log(
      JSON.stringify({
        id: row.id,
        pingStatus: response.status,
        pingBody: text.slice(0, 180),
      })
    );
  }
}

await closePool();
