import { closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';
import fboSuppliesPurchaseCalcService from '../../src/services/fboSuppliesPurchaseCalc.service.js';

const ids = [525, 1270, 524];
const avail = await fboSupplyReserveService.getAvailableStockAndIncomingForPurchaseCalc(ids, {
  profileId: 6,
  warehouseId: 6,
  excludeSupplyIds: [206],
});
console.log('avail exclude 206', Object.fromEntries(avail));

const calc = await fboSuppliesPurchaseCalcService.calculate([206], { profileId: 6 });
const rows = calc.rows.filter((r) => ['SM-5005', 'SN-2170', 'SN-2171'].includes(r.sku));
console.log(
  'calc 206',
  rows.map((r) => ({
    sku: r.sku,
    need: r.supplyQtyTotal,
    onHand: r.onHand,
    incoming: r.incoming,
    incomingTotal: r.incomingTotal,
    toPurchase: r.toPurchase,
  }))
);
await closePool();
