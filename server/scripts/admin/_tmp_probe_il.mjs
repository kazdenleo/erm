import integrationsService from '../../src/services/integrations.service.js';
import { closePool } from '../../src/config/database.js';

const cfg = await integrationsService.getMarketplaceConfig('wildberries', { profileId: 1 });
console.log(
  JSON.stringify(
    {
      localization_index: cfg?.localization_index ?? null,
      localizationIndex: cfg?.localizationIndex ?? null,
      acquiring_percent: cfg?.acquiring_percent ?? null,
      gem_services_percent: cfg?.gem_services_percent ?? null,
      spp_percent: cfg?.spp_percent ?? null,
    },
    null,
    2
  )
);
await closePool();
