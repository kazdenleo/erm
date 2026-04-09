/**
 * Import All Data
 * Р“Р»Р°РІРЅС‹Р№ СЃРєСЂРёРїС‚ РґР»СЏ РёРјРїРѕСЂС‚Р° РІСЃРµС… РґР°РЅРЅС‹С… РёР· JSON РІ PostgreSQL
 */

import importBrands from './01_import_brands.js';
import importCategories from './02_import_categories.js';
import importProducts from './03_import_products.js';
import importSuppliers from './07_import_suppliers.js';
import importWarehouses from './08_import_warehouses.js';
import importSupplierStocks from './09_import_supplier_stocks.js';
import importOrders from './10_import_orders.js';
import importIntegrations from './11_import_integrations.js';
import importCategoryMappings from './12_import_category_mappings.js';
import importWarehouseMappings from './13_import_warehouse_mappings.js';
import importWBCaches from './14_import_wb_caches.js';

async function importAll() {
  console.log('[Import] Starting full data import...');
  console.log('[Import] Make sure all migrations are applied first!\n');
  
  try {
    // РџРѕСЂСЏРґРѕРє РІР°Р¶РµРЅ РёР·-Р·Р° РІРЅРµС€РЅРёС… РєР»СЋС‡РµР№
    console.log('Step 1: Importing brands...');
    await importBrands();
    
    console.log('\nStep 2: Importing categories...');
    await importCategories();
    
    console.log('\nStep 3: Importing suppliers...');
    await importSuppliers();
    
    console.log('\nStep 4: Importing products...');
    await importProducts();
    
    console.log('\nStep 5: Importing warehouses...');
    await importWarehouses();
    
    console.log('\nStep 6: Importing supplier stocks...');
    await importSupplierStocks();
    
    console.log('\nStep 7: Importing orders...');
    await importOrders();
    
    console.log('\nStep 8: Importing integrations...');
    await importIntegrations();
    
    console.log('\nStep 9: Importing category mappings...');
    await importCategoryMappings();
    
    console.log('\nStep 10: Importing warehouse mappings...');
    await importWarehouseMappings();
    
    console.log('\nStep 11: Importing WB caches...');
    await importWBCaches();
    
    console.log('\n[Import] All imports completed successfully!');
  } catch (error) {
    console.error('[Import] Import failed:', error);
    throw error;
  }
}

// Р—Р°РїСѓСЃРє РёРјРїРѕСЂС‚Р°
const isMainModule = import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('import_all.js'));
if (isMainModule) {
  importAll()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importAll;
