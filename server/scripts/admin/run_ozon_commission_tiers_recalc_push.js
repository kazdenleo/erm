/**
 * После деплоя порогов комиссии Ozon:
 * 1) sync кэша калькулятора Ozon (выучит 17/23 и percent_above_300),
 * 2) пересчёт мин. цен из кэша,
 * 3) отправка мин. цен на маркетплейсы.
 *
 * node scripts/admin/run_ozon_commission_tiers_recalc_push.js
 */
import { closePool } from '../../src/config/database.js';
import pricesService from '../../src/services/prices.service.js';
import { pushForAllProfiles } from '../../src/services/marketplaceMinPricePush.service.js';

async function main() {
  console.log('[1/3] sync Ozon calculator cache (learn tiers + above300)...');
  const sync = await pricesService.syncCalculatorCacheFromApi({
    marketplaces: ['ozon'],
    delayMs: 150,
  });
  console.log('[1/3] sync done', JSON.stringify(sync?.ozon || sync, null, 2));

  console.log('[2/3] recalculate min prices from cache...');
  const recalc = await pricesService.recalculateAndSaveAllFromCache({
    skipBuyoutSync: true,
  });
  console.log('[2/3] recalc done', recalc);

  console.log('[3/3] push min prices to marketplaces...');
  const push = await pushForAllProfiles({});
  console.log('[3/3] push done', push);
}

main()
  .then(() => closePool())
  .then(() => {
    console.log('OK');
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    try {
      await closePool();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
