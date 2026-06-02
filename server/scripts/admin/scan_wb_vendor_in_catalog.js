#!/usr/bin/env node
/**
 * Сканировать каталог WB (list) и найти vendorCode.
 * node scripts/admin/scan_wb_vendor_in_catalog.js DTMK5014 [organizationId] [maxPages]
 */
import integrationsService from '../../src/services/integrations.service.js';

const vc = (process.argv[2] || 'DTMK5014').trim();
const organizationId = process.argv[3] || '3';
const maxPages = Number(process.argv[4] || 50);
const want = vc.toLowerCase();
const scope = { organizationId };

let cursor = { limit: 100 };
let page = 0;
let totalCards = 0;
const hits = [];

while (page < maxPages) {
  const body = {
    settings: {
      sort: { ascending: true },
      cursor,
      filter: { withPhoto: -1 }
    }
  };
  const data = await integrationsService._wbContentApiPost('/content/v2/get/cards/list', body, scope);
  const cards = data?.cards ?? [];
  if (!cards.length) break;
  for (const c of cards) {
    totalCards += 1;
    const codes = integrationsService._wbCardVendorCodes(c);
    if (codes.some((x) => String(x).trim().toLowerCase() === want)) {
      hits.push({
        nmId: c?.nmID ?? c?.nmId,
        vendorCodes: codes,
        title: (c?.title || '').slice(0, 80)
      });
    }
  }
  const next = data?.cursor;
  if (!next?.updatedAt || next?.nmID == null || cards.length < cursor.limit) break;
  cursor = { limit: 100, updatedAt: next.updatedAt, nmID: next.nmID };
  page += 1;
}

console.log(JSON.stringify({ vc, organizationId, pages: page + 1, totalCards, hits }, null, 2));
process.exit(hits.length ? 0 : 1);
