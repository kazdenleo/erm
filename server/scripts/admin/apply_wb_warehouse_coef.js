/**
 * Кэш WB считался по складу СГТ (46/14), а отгрузка идёт со «Свой склад РФ» (78,2/23,8).
 * База в API уже включает коэффициент склада. Подменяем тариф и пересчитываем мин. цены.
 *
 * node scripts/admin/apply_wb_warehouse_coef.js
 */
import fs from 'fs';
import { query, closePool } from '../../src/config/database.js';
import { computeWbVolumeBaseTariff, extractWbWarehouseList, parseWbTariffAmount, wbTariffWarehouseLabel } from '../../src/utils/wbTariffs.js';
import pricesService from '../../src/services/prices.service.js';
import { pushForProduct } from '../../src/services/marketplaceMinPricePush.service.js';

function loadRfRates() {
  const path = ['/opt/erm/data/wbTariffsCache.json', '/opt/erm/server/data/wbTariffsCache.json'].find((p) =>
    fs.existsSync(p)
  );
  if (!path) throw new Error('wbTariffsCache.json not found');
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const list = extractWbWarehouseList(raw.data || raw);
  const row = list.find((w) => wbTariffWarehouseLabel(w).toLowerCase() === 'свой склад рф');
  if (!row) throw new Error('Свой склад РФ not in tariffs');
  const base = parseWbTariffAmount(row.boxDeliveryMarketplaceBase);
  const liter = parseWbTariffAmount(row.boxDeliveryMarketplaceLiter);
  const coef = parseWbTariffAmount(row.boxDeliveryMarketplaceCoefExpr, 100);
  if (!(base > 0)) throw new Error('empty РФ marketplace base');
  return { base, liter, coef: coef > 0 ? coef : 100 };
}

function usesSgtRate(calc, suffix) {
  const base = Number(calc[`logistics_base${suffix}`]);
  const liter = Number(calc[`logistics_liter${suffix}`]);
  return Math.abs(base - 46) < 0.05 && Math.abs(liter - 14) < 0.05;
}

function applyRates(calc, suffix, rates) {
  if (!usesSgtRate(calc, suffix)) return false;
  const vol = Number(calc.volume_weight) || 0;
  const il = Number(calc.logistics_localization_index) > 0 ? Number(calc.logistics_localization_index) : 1;
  calc[`logistics_base${suffix}`] = rates.base;
  calc[`logistics_liter${suffix}`] = rates.liter;
  calc[`logistics_raw_base${suffix}`] = rates.base;
  calc[`logistics_raw_liter${suffix}`] = rates.liter;
  calc[`logistics_coef${suffix}`] = rates.coef;
  const volumeCost = computeWbVolumeBaseTariff(rates.base, rates.liter, vol);
  if (volumeCost > 0) {
    calc[`logistics_cost${suffix}`] = Math.round(volumeCost * il * 100) / 100;
  }
  return true;
}

async function main() {
  const rates = loadRfRates();
  console.log('RF rates', rates);
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
    const onlyFbs = process.argv.includes('--fbs-only');
    const touchedFbo = onlyFbs ? false : applyRates(calc, '_fbo', rates);
    const touchedFbs = applyRates(calc, '_fbs', rates);
    const touchedBase = onlyFbs ? false : applyRates(calc, '', rates);
    const touched = touchedFbo || touchedFbs || touchedBase;
    if (!touched) {
      skipped++;
      continue;
    }
    if (calc.logistics_base_fbo != null) {
      calc.logistics_base = calc.logistics_base_fbo;
      calc.logistics_liter = calc.logistics_liter_fbo;
      calc.logistics_cost = calc.logistics_cost_fbo;
      calc.logistics_coef = calc.logistics_coef_fbo;
      calc.logistics_raw_base = calc.logistics_raw_base_fbo;
      calc.logistics_raw_liter = calc.logistics_raw_liter_fbo;
    }
    await pricesService._upsertMpCalculatorCache(row.product_id, 'wb', calc, 'wb_rf_warehouse');
    ids.push(Number(row.product_id));
  }
  console.log('[1/3] cache', { updated: ids.length, skipped, fbsOnly: process.argv.includes('--fbs-only') });
  if (process.argv.includes('--fbs-only')) {
    console.log('FBS cache only, skip recalc/push');
    return;
  }

  console.log('[2/3] recalc min prices from cache...');
  const recalc = await pricesService.recalculateAndSaveAllFromCache({ skipBuyoutSync: true });
  console.log('[2/3] recalc', recalc);

  console.log('[3/3] push WB', ids.length);
  let pushed = 0;
  let failed = 0;
  for (const productId of ids) {
    try {
      await pushForProduct(productId, { marketplaces: ['wb'] });
      pushed++;
    } catch (e) {
      failed++;
      console.error('push fail', productId, e?.message || e);
    }
  }
  console.log('[3/3] push done', { pushed, failed });
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
