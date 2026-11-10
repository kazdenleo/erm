import pricesService from '../../src/services/prices.service.js';
import { clearOzonFbsLogisticsLearnedCache } from '../../src/utils/ozonLogisticsLearning.js';
import { closePool } from '../../src/config/database.js';

clearOzonFbsLogisticsLearnedCache();
const started = Date.now();
const r = await pricesService.recalculateAndSaveAllFromCache({
  skipBuyoutSync: true,
});
console.log(JSON.stringify({ ...r, elapsedMs: Date.now() - started }, null, 2));
await closePool();
