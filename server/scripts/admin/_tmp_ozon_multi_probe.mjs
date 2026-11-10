import integrationsService from '../../src/services/integrations.service.js';

async function call(cfg, path, body) {
  const r = await fetch(`https://api-seller.ozon.ru${path}`, {
    method: 'POST',
    headers: {
      'Client-Id': String(cfg.client_id),
      'Api-Key': String(cfg.api_key || cfg.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text.slice(0, 100) };
}

for (const profileId of [1, 6]) {
  const cfg = await integrationsService.getMarketplaceConfig('ozon', { profileId });
  const id = String(cfg.client_id || '');
  const v1 = await call(cfg, '/v1/description-category/tree', { language: 'DEFAULT' });
  await new Promise((r) => setTimeout(r, 1500));
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const to = new Date().toISOString();
  const v3 = await call(cfg, '/v3/posting/fbs/list', {
    dir: 'ASC',
    filter: { since, to },
    limit: 10,
    offset: 0,
  });
  console.log(
    JSON.stringify({
      profileId,
      clientId: `${id.slice(0, 3)}…${id.slice(-2)}`,
      v1_categories: v1.status,
      v3_postings: v3.status,
      v3_body: v3.body,
    })
  );
  await new Promise((r) => setTimeout(r, 2000));
}
process.exit(0);
