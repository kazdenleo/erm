import integrationsService from '../../src/services/integrations.service.js';

for (const profileId of [1, 6]) {
  const cfg = await integrationsService.getMarketplaceConfig('ozon', { profileId });
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const to = new Date().toISOString();
  const r = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/list', {
    method: 'POST',
    headers: {
      'Client-Id': String(cfg.client_id),
      'Api-Key': String(cfg.api_key),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ dir: 'ASC', filter: { since, to }, limit: 50, offset: 0 }),
  });
  const text = await r.text();
  let n = null;
  try {
    n = (JSON.parse(text)?.result?.postings || []).length;
  } catch {
    /* ignore */
  }
  console.log(JSON.stringify({ profileId, status: r.status, postings: n, body: text.slice(0, 120) }));
  await new Promise((resolve) => setTimeout(resolve, 2500));
}
process.exit(0);
