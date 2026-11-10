/**
 * Одноразовый импорт только Ozon FBS через /v4/posting/fbs/list → upsert.
 * Usage: node scripts/admin/_tmp_ozon_import_once.mjs [profileId]
 */
import 'dotenv/config';
import '../../src/config/database.js';
import integrationsService from '../../src/services/integrations.service.js';
import repositoryFactory from '../../src/config/repository-factory.js';

function mapStatus(status) {
  const s = String(status || '').toLowerCase().trim();
  const map = {
    awaiting_packaging: 'new',
    awaiting_registration: 'new',
    awaiting_approve: 'new',
    awaiting_validate: 'new',
    acceptance_in_progress: 'in_assembly',
    awaiting_deliver: 'in_assembly',
    awaiting_delivery: 'in_assembly',
    sent_by_seller: 'in_transit',
    driver_pickup: 'in_transit',
    delivering: 'in_transit',
    at_last_mile: 'in_transit',
    driving_to_pickup_point: 'in_transit',
    arrived_to_pickup_point: 'in_transit',
    cancel: 'cancelled',
    cancelled: 'cancelled',
    delivered: 'delivered',
    delivery: 'in_transit',
  };
  return map[s] || (s === 'unknown' ? 'new' : s || 'new');
}

function mapPosting(order) {
  const postingNumber = order?.posting_number != null ? String(order.posting_number).trim() : '';
  if (!postingNumber) return [];
  const products = Array.isArray(order.products) ? order.products.filter(Boolean) : [];
  const lines = products.length ? products : [null];
  const multi = lines.length > 1;
  return lines.map((p, idx) => {
    const priceRaw = p?.price?.amount ?? p?.price;
    const priceNum = parseFloat(priceRaw);
    const qty = parseInt(p?.quantity, 10);
    return {
      marketplace: 'ozon',
      orderId: !multi ? postingNumber : idx === 0 ? postingNumber : `${postingNumber}~${idx}`,
      orderGroupId: multi ? postingNumber : null,
      offerId: p?.offer_id != null ? String(p.offer_id).trim() : '',
      sku: p?.sku != null && p.sku !== '' ? String(p.sku).trim() : '',
      productName: p?.name != null ? String(p.name) : '',
      quantity: !Number.isNaN(qty) && qty > 0 ? qty : 1,
      price: !Number.isNaN(priceNum) ? priceNum : 0,
      status: mapStatus(order.status),
      createdAt: order.in_process_at || order.created_at || '',
      inProcessAt: order.in_process_at || '',
      shipmentDate: order.shipment_date || '',
      customerName: '',
      customerPhone: '',
      deliveryAddress: String(order?.delivery_method?.warehouse_id || ''),
    };
  });
}

async function fetchList(cfg, since, to) {
  const acc = [];
  let cursor = '';
  for (let page = 0; page < 100; page++) {
    const r = await fetch('https://api-seller.ozon.ru/v4/posting/fbs/list', {
      method: 'POST',
      headers: {
        'Client-Id': String(cfg.client_id),
        'Api-Key': String(cfg.api_key || cfg.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dir: 'ASC',
        cursor,
        limit: 100,
        filter: { since: since.toISOString(), to: to.toISOString() },
        with: { analytics_data: false, financial_data: false, barcodes: true },
        translit: false,
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`v4 list ${r.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const postings = Array.isArray(data?.postings) ? data.postings : [];
    acc.push(...postings);
    if (!data?.has_next || !data?.cursor || !postings.length) break;
    cursor = String(data.cursor);
    await new Promise((r) => setTimeout(r, 300));
  }
  return acc;
}

const profileId = Number(process.argv[2] || 1);
const cfg = await integrationsService.getMarketplaceConfig('ozon', { profileId });
if (!cfg?.client_id || !(cfg.api_key || cfg.apiKey)) {
  console.error('No ozon keys for profile', profileId);
  process.exit(1);
}

const to = new Date();
const since = new Date(to.getTime() - 7 * 864e5);
console.log(`profile=${profileId} fetching v4 list ${since.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`);
const postings = await fetchList(cfg, since, to);
const rows = postings.flatMap(mapPosting);
const byStatus = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
console.log(JSON.stringify({ postings: postings.length, rows: rows.length, byStatus }, null, 2));

try {
  if (typeof repositoryFactory.initialize === 'function') {
    await repositoryFactory.initialize();
  }
  console.log('pg?', repositoryFactory.isUsingPostgreSQL?.());
  const repo = repositoryFactory.getOrdersRepository();
  const tagged = rows.map((r) => ({ ...r, profileId, profile_id: profileId }));
  await repo.upsertFromSyncBatch(tagged);
  console.log('upsert ok', tagged.length);
  const news = rows.filter((r) => r.status === 'new').map((r) => r.orderId);
  console.log('new orderIds sample:', news.slice(0, 20));
} catch (e) {
  console.error('UPSERT FAIL:', e?.stack || e?.message || e);
  process.exit(1);
}
process.exit(0);
