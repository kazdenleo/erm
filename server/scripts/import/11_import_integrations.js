/**
 * Import Integrations
 * РРјРїРѕСЂС‚ РёРЅС‚РµРіСЂР°С†РёР№ РёР· JSON РІ PostgreSQL
 */

import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

async function importIntegrations() {
  console.log('[Import] Starting integrations import...');
  
  try {
    const integrations = [
      {
        type: 'marketplace',
        name: 'Ozon',
        code: 'ozon',
        config: await readData('ozon'),
        is_active: true
      },
      {
        type: 'marketplace',
        name: 'Wildberries',
        code: 'wildberries',
        config: await readData('wildberries'),
        is_active: true
      },
      {
        type: 'marketplace',
        name: 'Yandex Market',
        code: 'yandex',
        config: await readData('yandex'),
        is_active: true
      },
      {
        type: 'supplier',
        name: 'Mikado',
        code: 'mikado',
        config: await readData('mikado'),
        is_active: true
      },
      {
        type: 'supplier',
        name: 'Moskvorechie',
        code: 'moskvorechie',
        config: await readData('moskvorechie'),
        is_active: true
      }
    ];
    
    let imported = 0;
    let updated = 0;
    
    await transaction(async (client) => {
      for (const integration of integrations) {
        try {
          // РџСЂРѕРІРµСЂСЏРµРј СЃСѓС‰РµСЃС‚РІРѕРІР°РЅРёРµ
          const existing = await client.query(
            'SELECT id FROM integrations WHERE code = $1',
            [integration.code]
          );
          
          if (existing.rows.length > 0) {
            // РћР±РЅРѕРІР»СЏРµРј СЃСѓС‰РµСЃС‚РІСѓСЋС‰СѓСЋ РёРЅС‚РµРіСЂР°С†РёСЋ
            await client.query(`
              UPDATE integrations SET
                type = $2,
                name = $3,
                config = $4,
                is_active = $5,
                updated_at = CURRENT_TIMESTAMP
              WHERE code = $1
            `, [
              integration.code,
              integration.type,
              integration.name,
              JSON.stringify(integration.config || {}),
              integration.is_active
            ]);
            updated++;
          } else {
            // Р’СЃС‚Р°РІР»СЏРµРј РЅРѕРІСѓСЋ РёРЅС‚РµРіСЂР°С†РёСЋ
            await client.query(`
              INSERT INTO integrations (type, name, code, config, is_active)
              VALUES ($1, $2, $3, $4, $5)
            `, [
              integration.type,
              integration.name,
              integration.code,
              JSON.stringify(integration.config || {}),
              integration.is_active
            ]);
            imported++;
          }
        } catch (error) {
          console.error(`[Import] Error importing integration "${integration.code}":`, error.message);
        }
      }
    });
    
    console.log(`[Import] Integrations import completed: ${imported} imported, ${updated} updated`);
  } catch (error) {
    console.error('[Import] Integrations import failed:', error);
    throw error;
  }
}

// Р—Р°РїСѓСЃРє РёРјРїРѕСЂС‚Р°
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('11_import_integrations.js'))) {
  importIntegrations()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importIntegrations;

