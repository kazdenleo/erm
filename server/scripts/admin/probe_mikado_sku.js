/**
 * Probe Mikado API XML for SKU (usage: node scripts/admin/probe_mikado_sku.js E410151)
 */
import integrationsService from '../../src/services/integrations.service.js';
import { query, closePool } from '../../src/config/database.js';

const sku = process.argv[2] || 'E410151';

async function main() {
  const prod = await query(
    `SELECT p.sku, b.name AS brand
     FROM products p
     LEFT JOIN brands b ON p.brand_id = b.id
     WHERE p.sku = $1`,
    [sku]
  );
  const brand = prod.rows[0]?.brand || '';
  console.log('product:', prod.rows[0]);

  const sup = await query(`SELECT code, api_config FROM suppliers WHERE LOWER(code) = 'mikado'`);
  console.log('mikado warehouses config:', sup.rows[0]?.api_config?.warehouses);

  const cfg = await integrationsService.getSupplierConfig('mikado');
  const url = `http://mikado-parts.ru/ws1/service.asmx/CodeBrandStockInfo?Code=${encodeURIComponent(
    sku
  )}&Brand=${encodeURIComponent(brand)}&ClientID=${encodeURIComponent(cfg.user_id)}&Password=${encodeURIComponent(
    cfg.password
  )}`;
  console.log('\nURL:', url.replace(cfg.password, '***'));

  const res = await fetch(url, { headers: { Accept: 'application/xml, text/xml, */*' } });
  const xml = await res.text();
  console.log('\nXML length:', xml.length);

  const lines = [...xml.matchAll(/<CodeBrandLine>([\s\S]*?)<\/CodeBrandLine>/gi)];
  console.log('CodeBrandLine count:', lines.length);
  for (const m of lines) {
    const item = m[1];
    const name = item.match(/<StokName>(.*?)<\/StokName>/i)?.[1]?.trim();
    const qty =
      item.match(/<StockQTY>(\d+)<\/StockQTY>/i)?.[1] ||
      item.match(/<Stock>(\d+)<\/Stock>/i)?.[1] ||
      item.match(/<Quantity>(\d+)<\/Quantity>/i)?.[1];
    const delay = item.match(/<DeliveryDelay>(\d+)<\/DeliveryDelay>/i)?.[1];
    console.log({ name, qty, delay });
  }

  const firstQty = xml.match(/<StockQTY>(\d+)<\/StockQTY>/i)?.[1];
  console.log('\nFirst StockQTY match (current logic):', firstQty);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
