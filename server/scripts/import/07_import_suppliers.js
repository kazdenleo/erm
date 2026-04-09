/**
 * Import Suppliers
 * РРјРїРѕСЂС‚ РїРѕСЃС‚Р°РІС‰РёРєРѕРІ РёР· JSON РІ PostgreSQL
 */

import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

async function importSuppliers() {
  console.log('[Import] Starting suppliers import...');
  
  try {
    // РРјРїРѕСЂС‚РёСЂСѓРµРј РїРѕСЃС‚Р°РІС‰РёРєРѕРІ РёР· РєРѕРЅС„РёРіСѓСЂР°С†РёРѕРЅРЅС‹С… С„Р°Р№Р»РѕРІ
    const suppliers = [
      {
        name: 'Mikado',
        code: 'mikado',
        api_config: await readData('mikado'),
        is_active: true
      },
      {
        name: 'Moskvorechie',
        code: 'moskvorechie',
        api_config: await readData('moskvorechie'),
        is_active: true
      }
    ];
    
    let imported = 0;
    let updated = 0;
    
    await transaction(async (client) => {
      for (const supplier of suppliers) {
        try {
          // РџСЂРѕРІРµСЂСЏРµРј СЃСѓС‰РµСЃС‚РІРѕРІР°РЅРёРµ
          const existing = await client.query(
            'SELECT id FROM suppliers WHERE code = $1',
            [supplier.code]
          );
          
          if (existing.rows.length > 0) {
            // РћР±РЅРѕРІР»СЏРµРј СЃСѓС‰РµСЃС‚РІСѓСЋС‰РµРіРѕ РїРѕСЃС‚Р°РІС‰РёРєР°
            await client.query(`
              UPDATE suppliers SET
                name = $2,
                api_config = $3,
                is_active = $4,
                updated_at = CURRENT_TIMESTAMP
              WHERE code = $1
            `, [
              supplier.code,
              supplier.name,
              JSON.stringify(supplier.api_config || {}),
              supplier.is_active
            ]);
            updated++;
          } else {
            // Р’СЃС‚Р°РІР»СЏРµРј РЅРѕРІРѕРіРѕ РїРѕСЃС‚Р°РІС‰РёРєР°
            await client.query(`
              INSERT INTO suppliers (name, code, api_config, is_active)
              VALUES ($1, $2, $3, $4)
            `, [
              supplier.name,
              supplier.code,
              JSON.stringify(supplier.api_config || {}),
              supplier.is_active
            ]);
            imported++;
          }
        } catch (error) {
          console.error(`[Import] Error importing supplier "${supplier.code}":`, error.message);
        }
      }
    });
    
    console.log(`[Import] Suppliers import completed: ${imported} imported, ${updated} updated`);
  } catch (error) {
    console.error('[Import] Suppliers import failed:', error);
    throw error;
  }
}

// Р—Р°РїСѓСЃРє РёРјРїРѕСЂС‚Р°
const isMainModule = import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('07_import_suppliers.js'));
if (isMainModule) {
  importSuppliers()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importSuppliers;

