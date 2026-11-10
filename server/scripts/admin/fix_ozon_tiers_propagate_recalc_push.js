/**
 * Быстрый фикс: разнести percent_above_300 по категориям из уже известных высоких %,
 * пересчитать мин. цены из кэша и запушить на МП.
 *
 * Полный sync API — отдельно (run_ozon_commission_tiers_recalc_push.js).
 *
 * node scripts/admin/fix_ozon_tiers_propagate_recalc_push.js
 */
import { closePool } from '../../src/config/database.js';
import pricesService from '../../src/services/prices.service.js';
import { pushForAllProfiles } from '../../src/services/marketplaceMinPricePush.service.js';

async function main() {
  console.log('[1/3] propagate percent_above_300 + tier_rates...');
  const prop = await pricesService._propagateOzonPercentAbove300InCache();
  console.log('[1/3] done', prop);

  console.log('[2/3] recalculate min prices from cache...');
  const recalc = await pricesService.recalculateAndSaveAllFromCache({
    skipBuyoutSync: true,
  });
  console.log('[2/3] recalc done', recalc);

  console.log('[3/3] push min prices...');
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
