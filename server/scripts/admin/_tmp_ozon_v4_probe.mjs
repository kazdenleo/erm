import integrationsService from '../../src/services/integrations.service.js';

for (const profileId of [1, 6]) {
  const cfg = await integrationsService.getMarketplaceConfig('ozon', { profileId });
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const to = new Date().toISOString();
  const r = await fetch('https://api-seller.ozon.ru/v4/posting/fbs/list', {
    method: 'POST',
    headers: {
      'Client-Id': String(cfg.client_id),
      'Api-Key': String(cfg.api_key || cfg.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dir: 'ASC',
      cursor: '',
      limit: 50,
      filter: { since, to },
      with: { analytics_data: false, financial_data: false, barcodes: true },
      translit: false,
    }),
  });
  const text = await r.text();
  let n = null;
  let hasNext = null;
  try {
    const j = JSON.parse(text);
    const postings = j?.postings ?? j?.result?.postings ?? [];
    n = Array.isArray(postings) ? postings.length : null;
    hasNext = j?.has_next ?? j?.result?.has_next ?? null;
  } catch {
    /* ignore */
  }
  console.log(JSON.stringify({ profileId, status: r.status, postings: n, hasNext, body: text.slice(0, 160) }));
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
process.exit(0);
