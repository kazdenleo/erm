/**
 * Прогон синхронизации % выкупа из API маркетплейсов + пересчёт мин. цен.
 * node scripts/admin/run_buyout_daily_now.js [days]
 */
import { query, closePool } from '../../src/config/database.js';
import { recalculateBuyoutRatesForProfile } from '../../src/services/buyoutRateDaily.service.js';
import pricesService from '../../src/services/prices.service.js';

async function main() {
  const days = Number(process.argv[2] || 30) || 30;
  const profiles = await query(`SELECT id, name FROM profiles ORDER BY id`);
  if (!profiles.rows?.length) {
    throw new Error('Нет профилей в БД');
  }
  console.log(`Синхронизация % выкупа из API МП, период ${days} дн., профилей: ${profiles.rows.length}`);

  for (const p of profiles.rows) {
    const profileId = Number(p.id);
    console.log(`\n=== Профиль ${profileId} ${p.name || ''} ===`);
    const buyout = await recalculateBuyoutRatesForProfile(profileId, { windowDays: days });
    console.log('[Buyout]', buyout);

    const sample = await query(
      `SELECT COUNT(*) FILTER (WHERE buyout_rate_ozon IS NOT NULL) AS ozon,
              COUNT(*) FILTER (WHERE buyout_rate_wb IS NOT NULL) AS wb,
              COUNT(*) FILTER (WHERE buyout_rate_ym IS NOT NULL) AS ym,
              COUNT(*) AS total
       FROM products WHERE profile_id = $1`,
      [profileId]
    );
    console.log('[Products with MP buyout]', sample.rows[0]);

    if (buyout?.ok) {
      console.log('[Min prices] пересчёт из кэша...');
      const recalc = await pricesService.recalculateAndSaveAllFromCache({
        profileId,
        skipBuyoutSync: true,
      });
      console.log('[Min prices] done', recalc);
    }
  }
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    try {
      await closePool();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
