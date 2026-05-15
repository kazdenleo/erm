/**
 * Пересчёт остатков всех комплектов в БД (product_warehouse_stock + products).
 * Usage: node scripts/admin/recalculate_kit_stocks.js
 */
import { recalculateAllKitStocks } from '../../src/services/kitStock.service.js';

const n = await recalculateAllKitStocks();
console.log(`[recalculate_kit_stocks] Done. Kits processed: ${n}`);
