#!/usr/bin/env node
/**
 * Проверка поиска карточки WB по vendorCode.
 * node scripts/admin/test_wb_vendor_lookup.js DTMK5014 [organizationId]
 */
import integrationsService from '../../src/services/integrations.service.js';

const vc = process.argv[2] || 'DTMK5014';
const organizationId = process.argv[3] || process.env.ORG_ID || '3';

const scope = { organizationId };
const body = {
  settings: {
    cursor: { limit: 20 },
    filter: { withPhoto: -1, textSearch: vc }
  }
};
let listSample = [];
try {
  const data = await integrationsService._wbContentApiPost('/content/v2/get/cards/list', body, scope);
  const cards = data?.cards ?? [];
  listSample = cards.slice(0, 5).map((c) => ({
    nmId: c?.nmID ?? c?.nmId,
    vendorCode: c?.vendorCode ?? c?.vendor_code,
    title: (c?.title || '').slice(0, 60)
  }));
  console.log('textSearch count:', cards.length, 'sample:', JSON.stringify(listSample, null, 2));
} catch (e) {
  console.log('textSearch error:', e?.message || e);
}

const card = await integrationsService.getWildberriesProductByVendorCode(vc, scope);
console.log(JSON.stringify({ vendorCode: vc, organizationId, card }, null, 2));
process.exit(card?.nmId ? 0 : 1);
