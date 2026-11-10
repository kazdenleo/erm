import fs from 'fs';

const p = ['/opt/erm/data/wbTariffsCache.json', '/opt/erm/server/data/wbTariffsCache.json'].find((x) =>
  fs.existsSync(x)
);
console.log('file', p);
if (!p) process.exit(0);
const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
const list =
  raw?.response?.data?.warehouseList ||
  raw?.data?.warehouseList ||
  raw?.data?.response?.data?.warehouseList ||
  raw?.warehouseList ||
  [];
console.log('warehouses', Array.isArray(list) ? list.length : typeof list, 'keys', Object.keys(raw).slice(0, 12));
const rows = (Array.isArray(list) ? list : []).map((w) => ({
  name: w.warehouseName || w.geoName,
  id: w.warehouseId,
  base: w.boxDeliveryBase,
  liter: w.boxDeliveryLiter,
  coef: w.boxDeliveryCoefExpr,
  mpBase: w.boxDeliveryMarketplaceBase,
  mpLiter: w.boxDeliveryMarketplaceLiter,
  mpCoef: w.boxDeliveryMarketplaceCoefExpr,
}));
const coefs = {};
for (const r of rows) {
  const k = `${r.coef}|${r.mpCoef}`;
  coefs[k] = (coefs[k] || 0) + 1;
}
console.log('coef pairs', coefs);
console.log(
  'all',
  JSON.stringify(
    rows.map((r) => ({ name: r.name, base: r.base, liter: r.liter, coef: r.coef, mpBase: r.mpBase, mpCoef: r.mpCoef })),
    null,
    2
  )
);
console.log(
  'base 46',
  JSON.stringify(
    rows.filter((r) => String(r.base) === '46' || String(r.mpBase) === '46').slice(0, 12),
    null,
    2
  )
);
