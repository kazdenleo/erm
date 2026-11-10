import pricesService from '../../src/services/prices.service.js';
import { listYmPromos } from '../../src/services/marketplacePromotions.service.js';
import { closePool } from '../../src/config/database.js';

const scope = { integrationScope: { profileId: Number(process.env.PROFILE_ID || 1) } };

const ozon = await pricesService.getOzonActions(scope);
const ozonList = ozon?.result || ozon?.data || [];
console.log('OZON ok=', ozon?.ok, 'n=', ozonList.length);
for (const a of ozonList.slice(0, 8)) {
  console.log(
    'ozon',
    JSON.stringify({
      id: a.id,
      title: (a.title || '').slice(0, 40),
      participating_products_count: a.participating_products_count,
      potential_products_count: a.potential_products_count,
      banned_products_count: a.banned_products_count,
      is_participating: a.is_participating,
      keys: Object.keys(a),
    })
  );
}

const wb = await pricesService.getWBActions(scope);
const wbList = wb?.data || wb?.promotions || [];
console.log('WB ok=', wb?.ok, 'n=', wbList.length);
for (const a of wbList.slice(0, 8)) {
  console.log(
    'wb',
    JSON.stringify({
      id: a.id,
      name: (a.name || '').slice(0, 40),
      inPromoActionTotal: a.inPromoActionTotal,
      inPromoActionLeftovers: a.inPromoActionLeftovers,
      notInPromoActionTotal: a.notInPromoActionTotal,
      notInPromoActionLeftovers: a.notInPromoActionLeftovers,
      participationPercentage: a.participationPercentage,
      keys: Object.keys(a),
    })
  );
}

const ym = await listYmPromos(scope);
console.log('YM ok=', ym?.ok, 'n=', (ym?.promos || []).length);
for (const a of (ym?.promos || []).slice(0, 8)) {
  console.log('ym', JSON.stringify({ id: a.id, name: (a.name || '').slice(0, 40), keys: Object.keys(a), raw: a }));
}

await closePool();
