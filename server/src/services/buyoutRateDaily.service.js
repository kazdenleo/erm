/**
 * Суточный пересчёт % выкупа из API маркетплейсов.
 */

export {
  fetchMarketplaceBuyoutRatesForProfile as recalculateBuyoutRatesForProfile,
  fetchMarketplaceBuyoutRatesForAllProfiles as recalculateBuyoutRatesForAllProfiles,
  syncMarketplaceBuyoutForProduct,
} from './marketplaceBuyoutFetch.service.js';
