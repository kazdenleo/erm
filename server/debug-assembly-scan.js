import { query } from './src/config/database.js';
import ordersRepo from './src/repositories/orders.repository.pg.js';

const orderId = process.argv[2] || '4735170811';
const barcode = process.argv[3] || '4680037012960';
const productId = process.argv[4] ? Number(process.argv[4]) : 13;

async function main() {
  console.log('Args:', { orderId, barcode, productId });

  const orderRow = await query(
    `SELECT status, product_id, offer_id, marketplace_sku, product_name
     FROM orders
     WHERE marketplace = 'wb' AND order_id = $1`,
    [String(orderId)]
  );
  console.log('DB order row:', orderRow.rows[0] || null);

  const scan = await fetch(`http://localhost:3001/api/assembly/find-by-barcode?barcode=${encodeURIComponent(barcode)}`);
  console.log('HTTP /api/assembly/find-by-barcode status:', scan.status);
  console.log('HTTP body:', await scan.text());

  const repoFound = await ordersRepo.findFirstAssembledByProductIdOrSku(productId);
  console.log('Repo findFirstAssembledByProductIdOrSku:', repoFound);
}

main().catch((e) => {
  console.error('[debug-assembly-scan] failed:', e);
  process.exitCode = 1;
});

