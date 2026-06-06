/**
 * Быстрая проверка фильтра brandId в productsService.getPage.
 * node scripts/admin/test_brand_filter.js [profileId] [brandId]
 */
import productsService from '../../src/services/products.service.js';

const profileId = Number(process.argv[2] || 6);
const brandId = process.argv[3] || '7';

const all = await productsService.getPage({ profileId, limit: 3, offset: 0 });
const filtered = await productsService.getPage({ profileId, brandId, limit: 3, offset: 0 });

console.log(JSON.stringify({
  profileId,
  brandId,
  allTotal: all.total,
  filteredTotal: filtered.total,
  filteredBrands: [...new Set(filtered.items.map((p) => p.brand || p.brand_name || null))],
  filteredBrandIds: [...new Set(filtered.items.map((p) => p.brand_id ?? p.brandId ?? null))],
}, null, 2));

process.exit(0);
