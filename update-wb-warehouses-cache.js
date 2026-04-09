import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');

async function loadAllWBWarehouses(apiKey) {
  try {
    console.log('[WB Warehouses Cache] Loading all WB warehouses...');
    
    const warehouses = [];
    const date = new Date().toISOString().split('T')[0];
    
    // Загружаем данные о складах из API тарифов на коробки
    const boxResponse = await fetch(`https://common-api.wildberries.ru/api/v1/tariffs/box?date=${date}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': String(apiKey)
      },
      timeout: 10000
    });
    
    // Загружаем данные о тарифах возврата
    const returnResponse = await fetch(`https://common-api.wildberries.ru/api/v1/tariffs/return?date=${date}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': String(apiKey)
      },
      timeout: 10000
    });
    
    let boxData = null;
    let returnData = null;
    
    if (boxResponse.ok) {
      boxData = await boxResponse.json();
      console.log('[WB Warehouses Cache] Box tariffs loaded successfully');
    } else {
      console.error(`[WB Warehouses Cache] Error loading box tariffs: ${boxResponse.status} ${boxResponse.statusText}`);
    }
    
    if (returnResponse.ok) {
      returnData = await returnResponse.json();
      console.log('[WB Warehouses Cache] Return tariffs loaded successfully');
      // Логируем структуру первого склада возвратов для отладки
      if (returnData.response?.data?.warehouseList && returnData.response.data.warehouseList.length > 0) {
        console.log('[WB Warehouses Cache] Sample return warehouse structure:', JSON.stringify(returnData.response.data.warehouseList[0], null, 2));
        console.log('[WB Warehouses Cache] Return warehouse keys:', Object.keys(returnData.response.data.warehouseList[0]));
      }
    } else {
      console.error(`[WB Warehouses Cache] Error loading return tariffs: ${returnResponse.status} ${returnResponse.statusText}`);
    }
    
    // Создаем мапу возвратов по ID склада
    const returnTariffsMap = new Map();
    if (returnData?.response?.data?.warehouseList && Array.isArray(returnData.response.data.warehouseList)) {
      console.log(`[WB Warehouses Cache] Processing ${returnData.response.data.warehouseList.length} return warehouses`);
      returnData.response.data.warehouseList.forEach(warehouse => {
        const returnTariffs = {};
        Object.keys(warehouse).forEach(key => {
          if (key.startsWith('deliveryDump') || key.startsWith('delivery') || key.startsWith('return') || key.startsWith('dump')) {
            if (warehouse[key] !== undefined && warehouse[key] !== null && warehouse[key] !== '') {
              returnTariffs[key] = warehouse[key];
            }
          }
        });
        console.log(`[WB Warehouses Cache] Return tariffs for warehouse ${warehouse.warehouseName}:`, returnTariffs);
        // Используем warehouseName как ключ, так как warehouseID отсутствует
        returnTariffsMap.set(warehouse.warehouseName, returnTariffs);
      });
      console.log(`[WB Warehouses Cache] Created return tariffs map with ${returnTariffsMap.size} entries`);
    } else {
      console.log('[WB Warehouses Cache] No return data available or invalid format');
    }
    
    if (boxData?.response?.data?.warehouseList && Array.isArray(boxData.response.data.warehouseList)) {
      // Логируем структуру первого склада для отладки
      if (boxData.response.data.warehouseList.length > 0) {
        console.log('[WB Warehouses Cache] Sample box warehouse structure:', JSON.stringify(boxData.response.data.warehouseList[0], null, 2));
      }
      
      boxData.response.data.warehouseList.forEach(warehouse => {
        // Сохраняем все поля тарифов, которые приходят от WB API
        const tariffs = {};
        
        // Сохраняем все поля, которые начинаются с 'box' (все тарифы WB)
        Object.keys(warehouse).forEach(key => {
          if (key.startsWith('box')) {
            if (warehouse[key] !== undefined && warehouse[key] !== null && warehouse[key] !== '') {
              tariffs[key] = warehouse[key];
            }
          }
        });
        
        // Добавляем тарифы возврата, если они есть
        // Ищем по warehouseName, так как в API возвратов нет warehouseID
        const returnTariffs = returnTariffsMap.get(warehouse.warehouseName);
        
        if (returnTariffs) {
          console.log(`[WB Warehouses Cache] Adding return tariffs for warehouse ${warehouse.warehouseName}:`, returnTariffs);
          Object.assign(tariffs, returnTariffs);
        } else {
          console.log(`[WB Warehouses Cache] No return tariffs found for warehouse ${warehouse.warehouseName}`);
        }
        
        warehouses.push({
          id: warehouse.warehouseID || warehouse.warehouseName, // Используем warehouseName если warehouseID отсутствует
          name: warehouse.warehouseName,
          address: warehouse.warehouseAddress || '',
          city: warehouse.city || '',
          region: warehouse.region || '',
          geoName: warehouse.geoName || '',
          tariffs: tariffs,
          lastUpdated: new Date().toISOString()
        });
      });
      console.log(`[WB Warehouses Cache] Loaded ${warehouses.length} warehouses with box and return tariffs`);
    }
    
    return warehouses;
    
  } catch (error) {
    console.error('[WB Warehouses Cache] Error loading warehouses:', error);
    return [];
  }
}

// Функция для обновления кэша складов WB
async function updateWBWarehousesCache() {
  try {
    console.log('[WB Warehouses Cache] Starting warehouses cache update...');
    
    // Читаем конфигурацию WB
    const configFile = path.join(DATA_DIR, 'wildberries.json');
    if (!fs.existsSync(configFile)) {
      console.error('[WB Warehouses Cache] WB config file not found');
      return;
    }
    
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const { api_key } = config;
    
    if (!api_key) {
      console.error('[WB Warehouses Cache] No WB API key found');
      return;
    }
    
    // Загружаем данные о складах
    const warehouses = await loadAllWBWarehouses(api_key);
    
    if (warehouses && warehouses.length > 0) {
      const warehousesFile = path.join(DATA_DIR, 'wbWarehousesCache.json');
      fs.writeFileSync(warehousesFile, JSON.stringify(warehouses, null, 2));
      console.log(`[WB Warehouses Cache] Successfully saved ${warehouses.length} warehouses to cache`);
    } else {
      console.error('[WB Warehouses Cache] No warehouses data received');
    }
    
  } catch (error) {
    console.error('[WB Warehouses Cache] Error updating cache:', error);
  }
}

// Запускаем обновление, если скрипт вызван напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
  updateWBWarehousesCache();
}

export { updateWBWarehousesCache };
