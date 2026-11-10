/**
 * После смены индекса локализации WB: обновить логистику в кэше,
 * пересчитать мин. цены из кэша и выгрузить на WB.
 *
 * node scripts/admin/recalc_wb_min_after_il.js
 */
import { query, closePool } from '../../src/config/database.js';
import { computeWbVolumeBaseTariff, resolveWbLocalizationIndex } from '../../src/utils/wbTariffs.js';
import pricesService from '../../src/services/prices.service.js';
import { pushForProduct } from '../../src/services/marketplaceMinPricePush.service.js';
import integrationsService from '../../src/services/integrations.service.js';

function recomputeLogistics(calc, il) {
  const vol = Number(calc.volume_weight) || 0;
  let touched = false;
  for (const suffix of ['_fbo', '_fbs', '']) {
    const baseKey = `logistics_base${suffix}`;
    const literKey = `logistics_liter${suffix}`;
    const costKey = `logistics_cost${suffix}`;
    const base = Number(calc[baseKey]);
    if (!(base > 0)) continue;
    const liter = Number(calc[literKey]) || 0;
    const volumeCost = computeWbVolumeBaseTariff(base, liter, vol);
    if (!(volumeCost > 0)) continue;
    const next = Math.round(volumeCost * il * 100) / 100;
    if (Number(calc[costKey]) !== next) touched = true;
    calc[costKey] = next;
  }
  if (Number(calc.logistics_localization_index) !== il) touched = true;
  calc.logistics_localization_index = il;
  if (calc.logistics_cost_fbo != null) {
    calc.logistics_cost = calc.logistics_cost_fbo;
    calc.logistics_base = calc.logistics_base_fbo;
    calc.logistics_liter = calc.logistics_liter_fbo;
  }
  return touched;
}

async function main() {
  const wbCfg = await integrationsService.getMarketplaceConfig('wildberries', { profileId: 1 });
  const il = resolveWbLocalizationIndex(wbCfg?.localization_index);
  console.log('IL', il, 'raw', wbCfg?.localization_index);

  const res = await query(
    `SELECT product_id, calculator FROM product_mp_calculator_cache WHERE marketplace = 'wb'`
  );
  const ids = [];
  let skipped = 0;
  for (const row of res.rows || []) {
    const calc = row.calculator && typeof row.calculator === 'object' ? { ...row.calculator } : null;
    if (!calc) {
      skipped++;
      continue;
    }
    if (!recomputeLogistics(calc, il)) {
      skipped++;
      continue;
    }
    await pricesService._upsertMpCalculatorCache(row.product_id, 'wb', calc, 'wb_il_recalc');
    ids.push(Number(row.product_id));
  }
  console.log('[1/3] cache', { updated: ids.length, skipped, il });

  console.log('[2/3] recalc min prices from cache...');
  const recalc = await pricesService.recalculateAndSaveAllFromCache({ skipBuyoutSync: true });
  console.log('[2/3] recalc', {
    totalProcessed: recalc?.totalProcessed,
    updated: Array.isArray(recalc?.updated) ? recalc.updated.length : recalc?.updated,
  });

  // Мин. цены пересчитались у всех из кэша (ИЛ берётся из настроек в enrich) — пушим все WB.
  const pushIds = (res.rows || [])
    .map((r) => Number(r.product_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  console.log('[3/3] push WB', pushIds.length, '(cacheTouched', ids.length, ')');
  let pushed = 0;
  let failed = 0;
  for (const productId of pushIds) {
    try {
      await pushForProduct(productId, { marketplaces: ['wb'] });
      pushed++;
      if (pushed % 100 === 0) console.log('push progress', pushed);
    } catch (e) {
      failed++;
      console.error('push fail', productId, e?.message || e);
    }
  }
  console.log('[3/3] push done', { pushed, failed });

  const checkPrice = await query(
    `SELECT min_price, min_price_fbo, min_price_fbs, updated_at
       FROM product_marketplace_prices
      WHERE product_id = 187 AND marketplace = 'wb'`
  );
  const checkCache = await query(
    `SELECT calculator->>'logistics_cost_fbo' AS log_fbo,
            calculator->>'logistics_base_fbo' AS base_fbo,
            calculator->>'logistics_localization_index' AS il
       FROM product_mp_calculator_cache
      WHERE product_id = 187 AND marketplace = 'wb'`
  );
  console.log('KN1030K', { price: checkPrice.rows[0] || null, cache: checkCache.rows[0] || null });
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
