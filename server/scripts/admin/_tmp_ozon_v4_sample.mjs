import integrationsService from '../../src/services/integrations.service.js';

const cfg = await integrationsService.getMarketplaceConfig('ozon', { profileId: 1 });
const since = new Date(Date.now() - 2 * 864e5).toISOString();
const to = new Date().toISOString();
const r = await fetch('https://api-seller.ozon.ru/v4/posting/fbs/list', {
  method: 'POST',
  headers: {
    'Client-Id': String(cfg.client_id),
    'Api-Key': String(cfg.api_key || cfg.apiKey),
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    dir: 'DESC',
    cursor: '',
    limit: 5,
    filter: { since, to },
    with: { analytics_data: false, financial_data: false, barcodes: true },
    translit: false,
  }),
});
const j = await r.json();
const postings = j?.postings || [];
console.log(
  JSON.stringify(
    {
      status: r.status,
      count: postings.length,
      sample: postings.slice(0, 3).map((p) => ({
        posting_number: p.posting_number,
        status: p.status,
        in_process_at: p.in_process_at,
        products: p.products,
        keys: Object.keys(p),
      })),
    },
    null,
    2
  )
);
process.exit(0);
