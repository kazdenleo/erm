#!/usr/bin/env node
import integrationsService from '../../src/services/integrations.service.js';
const nmId = process.argv[2];
const organizationId = process.argv[3] || '3';
const r = await integrationsService.getWildberriesProductInfo({ nm_id: nmId, organizationId });
console.log(JSON.stringify({ nmId: r?.nmId, vendorCode: r?.vendorCode, title: r?.title }, null, 2));
