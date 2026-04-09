/**
 * Import Orders
 * РРјРїРѕСЂС‚ Р·Р°РєР°Р·РѕРІ РёР· JSON РІ PostgreSQL
 */

import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

async function importOrders() {
  console.log('[Import] Starting orders import...');
  
  try {
    const ordersData = await readData('orders');
    const orders = ordersData && Array.isArray(ordersData.orders)
      ? ordersData.orders
      : (Array.isArray(ordersData) ? ordersData : []);
    
    if (orders.length === 0) {
      console.log('[Import] No orders found');
      return;
    }
    
    console.log(`[Import] Found ${orders.length} orders`);
    
    let imported = 0;
    let updated = 0;
    let errors = 0;
    
    // Импортируем каждый заказ в отдельной транзакции, чтобы ошибки не откатывали весь батч
    for (const order of orders) {
      try {
        await transaction(async (client) => {
            // РќР°С…РѕРґРёРј product_id РїРѕ offer_id РёР»Рё marketplace_sku
            let productId = null;
            if (order.offerId) {
              const productResult = await client.query(
                'SELECT id FROM products WHERE sku = $1',
                [order.offerId]
              );
              if (productResult.rows.length > 0) {
                productId = productResult.rows[0].id;
              }
            }
            
            // РџСЂРѕРІРµСЂСЏРµРј СЃСѓС‰РµСЃС‚РІРѕРІР°РЅРёРµ Р·Р°РєР°Р·Р°
            const existing = await client.query(
              'SELECT id FROM orders WHERE marketplace = $1 AND order_id = $2',
              [order.marketplace, order.orderId]
            );
            
            // Валидация данных
            let marketplaceSku = null;
            if (order.sku) {
              const parsed = parseInt(order.sku);
              if (!isNaN(parsed)) {
                marketplaceSku = parsed;
              }
            }
            
            const quantity = parseInt(order.quantity) || 1;
            const price = parseFloat(order.price) || 0;
            
            // Проверка валидности marketplace
            const validMarketplaces = ['ozon', 'wildberries', 'yandex'];
            if (!order.marketplace || !validMarketplaces.includes(order.marketplace)) {
              throw new Error(`Invalid marketplace: ${order.marketplace}`);
            }
            
            const orderData = {
              marketplace: order.marketplace,
              order_id: order.orderId,
              product_id: productId,
              offer_id: order.offerId || null,
              marketplace_sku: marketplaceSku,
              product_name: order.productName || null,
              quantity: quantity,
              price: price,
              status: order.status || null,
              customer_name: order.customerName || null,
              customer_phone: order.customerPhone || null,
              delivery_address: order.deliveryAddress || null,
              created_at: order.createdAt ? new Date(order.createdAt) : null,
              in_process_at: order.inProcessAt ? new Date(order.inProcessAt) : null,
              shipment_date: order.shipmentDate ? new Date(order.shipmentDate) : null
            };
            
            if (existing.rows.length > 0) {
              // РћР±РЅРѕРІР»СЏРµРј СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ Р·Р°РєР°Р·
              await client.query(`
                UPDATE orders SET
                  product_id = $3,
                  offer_id = $4,
                  marketplace_sku = $5,
                  product_name = $6,
                  quantity = $7,
                  price = $8,
                  status = $9,
                  customer_name = $10,
                  customer_phone = $11,
                  delivery_address = $12,
                  created_at = $13,
                  in_process_at = $14,
                  shipment_date = $15,
                  updated_at = CURRENT_TIMESTAMP
                WHERE marketplace = $1 AND order_id = $2
              `, [
                orderData.marketplace,
                orderData.order_id,
                orderData.product_id,
                orderData.offer_id,
                orderData.marketplace_sku,
                orderData.product_name,
                orderData.quantity,
                orderData.price,
                orderData.status,
                orderData.customer_name,
                orderData.customer_phone,
                orderData.delivery_address,
                orderData.created_at,
                orderData.in_process_at,
                orderData.shipment_date
              ]);
              updated++;
            } else {
              // Р’СЃС‚Р°РІР»СЏРµРј РЅРѕРІС‹Р№ Р·Р°РєР°Р·
              await client.query(`
                INSERT INTO orders (
                  marketplace, order_id, product_id, offer_id, marketplace_sku,
                  product_name, quantity, price, status, customer_name,
                  customer_phone, delivery_address, created_at, in_process_at, shipment_date
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
              `, [
                orderData.marketplace,
                orderData.order_id,
                orderData.product_id,
                orderData.offer_id,
                orderData.marketplace_sku,
                orderData.product_name,
                orderData.quantity,
                orderData.price,
                orderData.status,
                orderData.customer_name,
                orderData.customer_phone,
                orderData.delivery_address,
                orderData.created_at,
                orderData.in_process_at,
                orderData.shipment_date
              ]);
              imported++;
            }
        });
      } catch (error) {
        console.error(`[Import] Error importing order ${order.orderId}:`, error.message);
        errors++;
      }
      
      if ((imported + updated + errors) % 100 === 0) {
        console.log(`[Import] Processed ${imported + updated + errors}/${orders.length} orders`);
      }
    }
    
    console.log(`[Import] Orders import completed: ${imported} imported, ${updated} updated, ${errors} errors`);
  } catch (error) {
    console.error('[Import] Orders import failed:', error);
    throw error;
  }
}

// Р—Р°РїСѓСЃРє РёРјРїРѕСЂС‚Р°
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('10_import_orders.js'))) {
  importOrders()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importOrders;

