import integrationsService from '../../src/services/integrations.service.js';
import { closePool } from '../../src/config/database.js';

const cfg = await integrationsService.getMarketplaceConfig('ozon', { profileId: 1 });
const clientId = cfg?.client_id || cfg?.clientId;
const apiKey = cfg?.api_key || cfg?.apiKey;

async function rawPost(path, body) {
  const res = await fetch(`https://api-seller.ozon.ru${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Client-Id': String(clientId),
      'Api-Key': String(apiKey),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { parseError: true, text: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

const types = await rawPost('/v1/finance/accrual/types', {});
const typeList = types.json?.accrual_types || types.json?.result?.accrual_types || [];
const interesting = typeList.filter((t) =>
  /commission|logistic|delivery|sale|acquiring|хран|достав|комисс|эквайр/i.test(
    `${t.name || ''} ${t.description || ''}`
  )
);

const day = '2026-10-20';
const byDay = await rawPost('/v1/finance/accrual/by-day', { date: day, last_id: '' });
const list = byDay.json?.result?.accruals || [];
const postings = list.filter((a) => a.accrued_category === 'POSTING');
const summary = postings.map((a) => {
  const p = a.posting?.products?.[0];
  const c = p?.commission || {};
  return {
    id: a.accrual_id,
    unit: a.unit_number,
    schema: a.posting?.delivery_schema,
    total: a.total_amount?.amount,
    sku: p?.sku,
    seller_price: c.seller_price?.amount,
    sale_amount: c.sale_amount?.amount,
    sale_commission: c.sale_commission?.amount,
    commission: c.commission?.amount,
    delivery: p?.delivery,
  };
});

console.log(
  JSON.stringify(
    {
      typeCount: typeList.length,
      interestingTypes: interesting.slice(0, 40),
      postingSummary: summary,
    },
    null,
    2
  )
);
await closePool();
