#!/usr/bin/env node
/**
 * Проверка поиска карточки WB по vendorCode.
 * node scripts/admin/test_wb_vendor_lookup.js DTMK5014 [organizationId]
 */
import integrationsService from '../../src/services/integrations.service.js';

const vc = process.argv[2] || 'DTMK5014';
const organizationId = process.argv[3] || process.env.ORG_ID || '3';

const card = await integrationsService.getWildberriesProductByVendorCode(vc, { organizationId });
console.log(JSON.stringify({ vendorCode: vc, organizationId, card }, null, 2));
process.exit(card?.nmId ? 0 : 1);
