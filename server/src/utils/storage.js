/**
 * Storage Utility
 * Утилита для работы с файловым хранилищем (JSON файлы)
 * В будущем будет заменена на PostgreSQL
 */

import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Важно: `config.paths.dataDir` указывает на `<repo>/data`.
// Раньше здесь был `join(__dirname, '../../data')`, что при запуске из папки `server/`
// превращалось в `<repo>/server/data` и раздувало хранилище на два каталога:
// - runtimeNotifications/tokenStatusCache в `<repo>/server/data`
// - маркетплейсы в `<repo>/data`
// Из-за этого UI мог показывать "старые" ошибки, не видя актуальный tokenStatusCache.
const DATA_DIR = config.paths.dataDir || join(__dirname, '../../../data');

const DATA_FILES = {
  // Маркетплейсы
  ozon: join(DATA_DIR, 'ozon.json'),
  wildberries: join(DATA_DIR, 'wildberries.json'),
  yandex: join(DATA_DIR, 'yandex.json'),
  
  // Поставщики
  mikado: join(DATA_DIR, 'mikado.json'),
  moskvorechie: join(DATA_DIR, 'moskvorechie.json'),
  suppliers: join(DATA_DIR, 'suppliers.json'),
  
  // Другие данные
  categories: join(DATA_DIR, 'categories.json'),
  brands: join(DATA_DIR, 'brands.json'),
  products: join(DATA_DIR, 'products.json'),
  warehouses: join(DATA_DIR, 'warehouses.json'),
  warehouse_suppliers: join(DATA_DIR, 'warehouse_suppliers.json'),
  warehouse_mappings: join(DATA_DIR, 'warehouseMappings.json'),
  supplierStockCache: join(DATA_DIR, 'supplierStockCache.json'),
  orders: join(DATA_DIR, 'orders.json'),
  shipments: join(DATA_DIR, 'shipments.json'),
  categoryMappings: join(DATA_DIR, 'categoryMappings.json'),
  wbCategoriesCache: join(DATA_DIR, 'wbCategoriesCache.json'),
  wbCommissionsCache: join(DATA_DIR, 'wbCommissionsCache.json'),
  wbWarehousesCache: join(DATA_DIR, 'wbWarehousesCache.json'),
  wbTariffsCache: join(DATA_DIR, 'wbTariffsCache.json'),
  ozonActionsCache: join(DATA_DIR, 'ozonActionsCache.json'),
  ozonActionProductsCache: join(DATA_DIR, 'ozonActionProductsCache.json'),
  wbPromotionsCache: join(DATA_DIR, 'wbPromotionsCache.json'),
  tokenStatusCache: join(DATA_DIR, 'tokenStatusCache.json'),

  // Runtime notifications (ошибки фоновых задач / интеграций)
  runtimeNotifications: join(DATA_DIR, 'runtimeNotifications.json')
  ,
  // Сертификаты
  certificates: join(DATA_DIR, 'certificates.json')
};

// Каталог данных должен существовать до миграции (иначе writeFileSync в `<repo>/data` падает при первом запуске).
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[Storage] Created data directory: ${DATA_DIR}`);
}

// Миграция: ранее часть файлов писалась в `<repo>/server/data` из-за неверного относительного пути.
// Переносим важные JSON в единый `<repo>/data`, чтобы tokenStatusCache/runtimeNotifications совпадали с маркетплейсами.
try {
  const legacyDir = join(__dirname, '../../data'); // server/data (от server/src/utils)
  if (fs.existsSync(legacyDir)) {
    const migrateFile = (name) => {
      const from = join(legacyDir, name);
      const to = join(DATA_DIR, name);
      if (!fs.existsSync(from)) return;
      if (!fs.existsSync(to)) {
        fs.copyFileSync(from, to);
        console.log(`[Storage] Migrated ${name} from legacy dir to: ${to}`);
        return;
      }
      // merge token cache objects
      if (name === 'tokenStatusCache.json') {
        try {
          const a = JSON.parse(fs.readFileSync(from, 'utf8'));
          const b = JSON.parse(fs.readFileSync(to, 'utf8'));
          const merged = { ...(typeof b === 'object' && b ? b : {}), ...(typeof a === 'object' && a ? a : {}) };
          fs.writeFileSync(to, JSON.stringify(merged, null, 2), 'utf8');
          console.log(`[Storage] Merged tokenStatusCache.json (legacy + current)`);
        } catch (_) {}
        return;
      }
      // merge runtime notifications arrays by id
      if (name === 'runtimeNotifications.json') {
        try {
          const a = JSON.parse(fs.readFileSync(from, 'utf8'));
          const b = JSON.parse(fs.readFileSync(to, 'utf8'));
          const arrA = Array.isArray(a) ? a : [];
          const arrB = Array.isArray(b) ? b : [];
          const map = new Map();
          for (const it of [...arrB, ...arrA]) {
            if (it && it.id) map.set(it.id, it);
          }
          const merged = [...map.values()].sort((x, y) => {
            const ta = Date.parse(x?.created_at || '') || 0;
            const tb = Date.parse(y?.created_at || '') || 0;
            return tb - ta;
          });
          fs.writeFileSync(to, JSON.stringify(merged, null, 2), 'utf8');
          console.log(`[Storage] Merged runtimeNotifications.json (legacy + current)`);
        } catch (_) {}
      }
    };
    const mergeShipmentsObjects = (x, y) => {
      const a = x && typeof x === 'object' ? x : {};
      const b = y && typeof y === 'object' ? y : {};
      const ids = new Set([...(Array.isArray(a.orderIds) ? a.orderIds : []), ...(Array.isArray(b.orderIds) ? b.orderIds : [])]);
      const closed = !!(a.closed || b.closed);
      return {
        ...a,
        ...b,
        orderIds: [...ids],
        closed,
        closedAt: a.closedAt || b.closedAt || null,
        status: closed ? 'closed' : (b.status || a.status || 'draft')
      };
    };
    const migrateShipmentsJson = () => {
      const name = 'shipments.json';
      const from = join(legacyDir, name);
      const to = join(DATA_DIR, name);
      if (!fs.existsSync(from)) return;
      try {
        const legacy = JSON.parse(fs.readFileSync(from, 'utf8'));
        const legArr = Array.isArray(legacy?.shipments) ? legacy.shipments : [];
        let cur = { shipments: [] };
        if (fs.existsSync(to)) {
          try {
            cur = JSON.parse(fs.readFileSync(to, 'utf8'));
          } catch (_) {
            cur = { shipments: [] };
          }
        }
        const curArr = Array.isArray(cur?.shipments) ? cur.shipments : [];
        const map = new Map();
        for (const s of curArr) {
          if (s && s.id) map.set(s.id, s);
        }
        for (const s of legArr) {
          if (!s || !s.id) continue;
          const prev = map.get(s.id);
          map.set(s.id, prev ? mergeShipmentsObjects(prev, s) : s);
        }
        const merged = { shipments: [...map.values()], updatedAt: new Date().toISOString() };
        fs.writeFileSync(to, JSON.stringify(merged, null, 2), 'utf8');
        console.log(`[Storage] Merged shipments.json (legacy → ${to})`);
      } catch (e) {
        console.warn('[Storage] shipments.json migration failed:', e?.message || e);
      }
    };
    migrateShipmentsJson();

    // Стикеры QR вложений: пути в JSON вида shipment-stickers/....png относительно DATA_DIR
    try {
      const fromStick = join(legacyDir, 'shipment-stickers');
      const toStick = join(DATA_DIR, 'shipment-stickers');
      if (fs.existsSync(fromStick)) {
        if (!fs.existsSync(toStick)) fs.mkdirSync(toStick, { recursive: true });
        for (const name of fs.readdirSync(fromStick)) {
          const fp = join(fromStick, name);
          const tp = join(toStick, name);
          if (!fs.statSync(fp).isFile()) continue;
          if (!fs.existsSync(tp)) {
            fs.copyFileSync(fp, tp);
            console.log(`[Storage] Copied shipment sticker: ${name}`);
          }
        }
      }
    } catch (e) {
      console.warn('[Storage] shipment-stickers migration skipped:', e?.message || e);
    }

    migrateFile('tokenStatusCache.json');
    migrateFile('runtimeNotifications.json');
  }
} catch (e) {
  console.warn('[Storage] Legacy data migration skipped:', e?.message || e);
}

// На случай если каталог удалили после блока выше
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[Storage] Created data directory: ${DATA_DIR}`);
}

/**
 * Чтение данных из файла
 * @param {string} type - Тип данных (products, orders, etc.)
 * @returns {Promise<Object|Array>} Данные из файла
 */
export async function readData(type) {
  try {
    const filePath = DATA_FILES[type];
    if (!filePath) {
      throw new Error(`Unknown data type: ${type}`);
    }
    
    if (!fs.existsSync(filePath)) {
      const arrayTypes = ['categories', 'brands', 'products', 'orders', 'warehouses', 'warehouse_suppliers', 'certificates'];
      if (arrayTypes.includes(type)) return [];
      if (type === 'shipments') return { shipments: [] };
      return {};
    }
    
    const data = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`[Storage] Error reading ${type}:`, error.message);
    const arrayTypes = ['categories', 'brands', 'products', 'orders', 'warehouses', 'warehouse_suppliers', 'certificates', 'runtimeNotifications'];
    return arrayTypes.includes(type) ? [] : {};
  }
}

/**
 * Запись данных в файл
 * @param {string} type - Тип данных (products, orders, etc.)
 * @param {Object|Array} data - Данные для записи
 * @returns {Promise<boolean>} Успешность операции
 */
export async function writeData(type, data) {
  try {
    const filePath = DATA_FILES[type];
    if (!filePath) {
      throw new Error(`Unknown data type: ${type}`);
    }
    
    // Сериализуем данные с replacer, чтобы исключить функции и undefined
    const replacerFunc = function(key, value) {
      try {
        // Игнорируем функции
        if (typeof value === 'function') {
          return undefined;
        }
        // Игнорируем undefined
        if (value === undefined) {
          return null;
        }
        // Возвращаем все остальное
        return value;
      } catch (replacerError) {
        console.error('[Storage] Error in replacer function:', replacerError);
        return null;
      }
    };
    
    const jsonString = JSON.stringify(data, replacerFunc, 2);
    await fs.promises.writeFile(filePath, jsonString, 'utf8');
    return true;
  } catch (error) {
    console.error(`[Storage] Error writing ${type}:`, error.message);
    return false;
  }
}

// Обертка для совместимости с репозиториями
export const storage = {
  async read(key) {
    return await readData(key);
  },
  
  async write(key, data) {
    return await writeData(key, data);
  }
};

export { DATA_FILES, DATA_DIR };

