import { closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

const profileId = Number(process.argv[2] || 6);
console.log('rebalanceReservesForProfile', profileId, 'start', new Date().toISOString());
const t0 = Date.now();
const result = await fboSupplyReserveService.rebalanceReservesForProfile(profileId, {
  skipMarketplaceSync: true,
});
console.log('done in', Date.now() - t0, 'ms', result);
await closePool();
