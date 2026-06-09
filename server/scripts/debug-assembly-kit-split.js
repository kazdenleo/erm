/**
 * Debug kit assembly split for a specific order.
 * Usage: node server/scripts/debug-assembly-kit-split.js [orderId] [marketplace]
 */
import { query } from '../src/config/database.js';
import {
  isKitProductId,
  findKitProductIdForMarketplaceOrder,
  getKitComponents,
  getNetReservedForOrderProduct,
  getReservedKitUnitsFromComponentsForOrder,
  readKitPhysicalOnHandFromDb
} from '../src/services/kitStock.service.js';
import { buildAssemblyOrderItems } from '../src/services/assemblyOrderItems.service.js';
import ordersService from '../src/services/orders.service.js';

const orderId = process.argv[2] || '28074693-0073-2';
const marketplace = process.argv[3] || 'ozon';

async function main() {
  const ord = await query(
    `SELECT * FROM orders WHERE marketplace = $1 AND order_id = $2 LIMIT 1`,
    [marketplace, String(orderId)]
  );
  const order = ord.rows[0];
  if (!order) {
    console.log('Order not found:', { marketplace, orderId });
    process.exit(1);
  }
  console.log('Order:', {
    id: order.id,
    order_id: order.order_id,
    status: order.status,
    product_id: order.product_id,
    offer_id: order.offer_id,
    marketplace_sku: order.marketplace_sku,
    product_name: order.product_name,
    quantity: order.quantity
  });

  const linePid = order.product_id ?? (await ordersService.resolveProductIdForAssemblyLine(order));
  console.log('Resolved linePid:', linePid);

  const kitBySku = await findKitProductIdForMarketplaceOrder(Number(linePid) || 0, order);
  console.log('findKitProductIdForMarketplaceOrder:', kitBySku);
  console.log('isKitProductId(linePid):', linePid ? await isKitProductId(linePid) : false);
  if (kitBySku) {
    console.log('isKitProductId(kit):', await isKitProductId(kitBySku));
    console.log('kit_components:', await getKitComponents(kitBySku));
  }

  const oid = Number(order.id);
  const kitId = kitBySku || (linePid && (await isKitProductId(linePid)) ? Number(linePid) : null);
  if (kitId) {
    const onKit = await getNetReservedForOrderProduct(oid, kitId, order.order_id);
    const fromComp = await getReservedKitUnitsFromComponentsForOrder(kitId, oid);
    const physical = await readKitPhysicalOnHandFromDb(kitId, null, {});
    console.log('Reserve/shipment state:', { onKit, fromComp, physical });
  }

  const productSku = await query(
    `SELECT p.id, p.sku, p.name, p.product_type
     FROM products p
     LEFT JOIN product_skus ps ON ps.product_id = p.id
     WHERE p.sku ILIKE '%H650375%' OR ps.sku ILIKE '%H650375%'
     LIMIT 20`
  );
  console.log('Products matching H650375:', productSku.rows);

  const orderItems = await buildAssemblyOrderItems(order, ordersService, {});
  console.log('buildAssemblyOrderItems:', JSON.stringify(orderItems, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
