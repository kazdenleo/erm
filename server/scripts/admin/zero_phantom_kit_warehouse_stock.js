/**
 * Обнулить фантомные остатки комплектов в product_warehouse_stock
 * (остатки без движений поступления/списания по SKU комплекта).
 *
 * Usage: node scripts/admin/zero_phantom_kit_warehouse_stock.js
 */
import { zeroPhantomKitWarehouseStock } from '../../src/services/kitStock.service.js';

const n = await zeroPhantomKitWarehouseStock();
console.log(`[zero_phantom_kit_warehouse_stock] Kits cleared: ${n}`);
