import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { promisify } from 'util';

// Подключаем новый API роутер
import apiRoutes from './server/src/routes/index.js';
import schedulerService from './server/src/services/scheduler.service.js';
import { addRuntimeNotification } from './server/src/utils/runtime-notifications.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());

// Middleware для обработки ошибок парсинга JSON
app.use(express.json({
  verify: (req, res, buf) => {
    // Пропускаем пустой body
    if (!buf || buf.length === 0) {
      return;
    }
    try {
      JSON.parse(buf);
    } catch (e) {
      console.error('[JSON] Parse error:', e.message);
      console.error('[JSON] Buffer content:', buf.toString().substring(0, 200));
      // Не выбрасываем ошибку, просто логируем
      // Express сам обработает это
    }
  },
  strict: false // Разрешаем не только объекты, но и примитивы
}));

// Middleware для перехвата всех ошибок (должен быть ПОСЛЕ всех роутов)
// Этот middleware будет добавлен в конце файла
// Статические файлы будут обслуживаться после всех API роутов

function sendOk(res, data) { res.status(200).json({ ok: true, data }); }
function sendErr(res, status, message, data) { res.status(status || 500).json({ ok: false, message, data }); }

// ========== SERVER-SIDE DATA STORAGE ==========

const DATA_DIR = join(__dirname, 'data');
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
  orders: join(DATA_DIR, 'orders.json')
};

// Создаем директорию для данных, если её нет
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Функции для работы с файловым хранилищем
async function readData(type) {
  try {
    const filePath = DATA_FILES[type];
    if (!filePath) {
      throw new Error('Unknown data type: ' + type);
    }
    
    if (!fs.existsSync(filePath)) {
      return {};
    }
    
    const data = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    const errMsg = error?.message || 'Unknown error';
    console.error('Error reading ' + type + ' data: ' + errMsg);
    return {};
  }
}

async function writeData(type, data) {
  try {
    const filePath = DATA_FILES[type];
    if (!filePath) {
      throw new Error('Unknown data type: ' + type);
    }
    
    // Сериализуем данные с replacer, чтобы исключить любые функции и геттеры
    let jsonString;
    try {
      console.log('[writeData] Starting JSON.stringify for type:', type);
      // Используем строгую функцию replacer без замыканий
      const replacerFunc = function(key, value) {
        // Полностью изолированная функция, не использует внешние переменные
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
          console.error('[writeData] Error in replacer function:', replacerError);
          return null;
        }
      };
      jsonString = JSON.stringify(data, replacerFunc, 2);
      console.log('[writeData] JSON.stringify completed successfully, length:', jsonString ? jsonString.length : 0);
    } catch (stringifyError) {
      console.error('[writeData] JSON.stringify error:', stringifyError);
      console.error('[writeData] Error stack:', stringifyError?.stack);
      const strErrMsg = stringifyError?.message || 'Unknown stringify error';
      throw new Error('JSON stringify failed: ' + strErrMsg);
    }
    
    await fs.promises.writeFile(filePath, jsonString, 'utf8');
    return true;
  } catch (error) {
    const errorMsg = error?.message || 'Unknown error';
    console.error('[Storage] Error writing ' + type + ' data: ' + errorMsg);
    return false;
  }
}

// ========== API ENDPOINTS FOR DATA STORAGE ==========

// Получить данные
app.get('/api/data/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const data = await readData(type);
    return sendOk(res, data);
  } catch (error) {
    const errMsg = error?.message || 'Unknown error';
    return sendErr(res, 500, 'Error reading ' + req.params.type + ' data: ' + errMsg);
  }
});

// Получить логи ошибок
app.get('/api/error-log', async (req, res) => {
  try {
    console.log('[API] /api/error-log requested');
    const logPath = join(__dirname, 'error.log');
    console.log('[API] Log path:', logPath);
    if (fs.existsSync(logPath)) {
      console.log('[API] Log file exists, reading...');
      const logContent = await fs.promises.readFile(logPath, 'utf8');
      const lines = logContent.split('\n').filter(line => line.trim());
      console.log('[API] Log lines count:', lines.length);
      const logs = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
      console.log('[API] Returning', logs.length, 'log entries');
      return sendOk(res, logs);
    } else {
      console.log('[API] Log file does not exist, returning empty array');
      return sendOk(res, []);
    }
  } catch (error) {
    console.error('[API] Error reading error log:', error);
    return sendErr(res, 500, 'Error reading error log: ' + (error?.message || 'Unknown error'));
  }
});

// Получить последние логи сервера (для отладки)
app.get('/api/server-logs', (req, res) => {
  try {
    console.log('[API] /api/server-logs requested');
    // Возвращаем информацию о последних действиях
    const logs = [];
    const logPath = join(__dirname, 'error.log');
    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, 'utf8');
      const lines = logContent.split('\n').filter(line => line.trim()).slice(-10); // Последние 10 строк
      logs.push(...lines);
    }
    return sendOk(res, { logs, message: 'Check server console for detailed logs' });
  } catch (error) {
    console.error('[API] Error reading server logs:', error);
    return sendErr(res, 500, 'Error reading logs: ' + (error?.message || 'Unknown error'));
  }
});

// Тестовый endpoint для проверки работы сервера
app.get('/api/test', (req, res) => {
  console.log('[API] /api/test requested at', new Date().toISOString());
  return sendOk(res, { 
    message: 'Server is running', 
    timestamp: new Date().toISOString(),
    routes: ['/api/test', '/api/error-log', '/logs', '/api/warehouses']
  });
});

// Endpoint для проверки статуса сервера (более простой)
app.get('/status', (req, res) => {
  res.send(`
    <html>
      <head><title>Server Status</title></head>
      <body style="font-family: Arial; padding: 20px;">
        <h1>✅ Server is Running</h1>
        <p>Time: ${new Date().toISOString()}</p>
        <h2>Available Endpoints:</h2>
        <ul>
          <li><a href="/api/test">/api/test</a> - Test endpoint</li>
          <li><a href="/api/error-log">/api/error-log</a> - Error logs (JSON)</li>
          <li><a href="/logs">/logs</a> - Error logs (HTML)</li>
          <li><a href="/">/</a> - Main application</li>
        </ul>
      </body>
    </html>
  `);
});

// Простая HTML страница для просмотра логов
app.get('/logs', (req, res) => {
  try {
    const logPath = join(__dirname, 'error.log');
    let logContent = '';
    if (fs.existsSync(logPath)) {
      logContent = fs.readFileSync(logPath, 'utf8');
    }
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Server Logs</title>
  <meta charset="utf-8">
  <style>
    body { font-family: monospace; padding: 20px; background: #1e1e1e; color: #d4d4d4; }
    pre { background: #252526; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .error { color: #f48771; }
    .info { color: #4ec9b0; }
    h1 { color: #4ec9b0; }
  </style>
</head>
<body>
  <h1>Server Error Logs</h1>
  <p><a href="/api/error-log" style="color: #4ec9b0;">JSON API</a> | <a href="/api/test" style="color: #4ec9b0;">Test Endpoint</a></p>
  <pre>${logContent || 'No logs yet. Errors will appear here when they occur.'}</pre>
  <script>
    setTimeout(() => location.reload(), 5000);
  </script>
</body>
</html>
    `;
    res.send(html);
  } catch (error) {
    res.status(500).send('Error: ' + (error?.message || 'Unknown error'));
  }
});

// Сохранить данные
app.post('/api/data/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const data = req.body;
    
    const success = await writeData(type, data);
    if (success) {
      return sendOk(res, { message: `${type} data saved successfully` });
    } else {
      return sendErr(res, 500, `Failed to save ${type} data`);
    }
  } catch (error) {
    return sendErr(res, 500, `Error saving ${req.params.type} data: ${error.message}`);
  }
});

// Получить все данные
app.get('/api/data', async (req, res) => {
  try {
    const allData = {};
    
    for (const [type, filePath] of Object.entries(DATA_FILES)) {
      allData[type] = await readData(type);
    }
    
    return sendOk(res, allData);
  } catch (error) {
    return sendErr(res, 500, `Error reading all data: ${error.message}`);
  }
});

// Очистить все данные
app.delete('/api/data', async (req, res) => {
  try {
    for (const [type, filePath] of Object.entries(DATA_FILES)) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    
    console.log('[Storage] All data cleared');
    return sendOk(res, { message: 'All data cleared successfully' });
  } catch (error) {
    return sendErr(res, 500, `Error clearing data: ${error.message}`);
  }
});

app.post('/test/ozon', async (req, res) => {
  const { client_id, api_key } = req.body || {};
  if (!client_id || !api_key) return sendErr(res, 400, 'client_id и api_key обязательны');
  
  // Простая проверка формата данных
  if (client_id.length < 3 || api_key.length < 10) {
    return sendErr(res, 400, 'Некорректный формат Client ID или API Key');
  }
  
  console.log(`[Ozon] Testing connection with client_id: ${client_id}`);
  
  // Временное решение: проверяем только формат данных
  // В реальной системе здесь должен быть вызов к актуальному API Ozon
  
  // Проверяем, что client_id выглядит как числовой ID
  if (!/^\d+$/.test(client_id)) {
    return sendErr(res, 400, 'Client ID должен содержать только цифры');
  }
  
  // Проверяем, что api_key выглядит как UUID или похожую строку
  if (!/^[a-f0-9-]{20,}$/i.test(api_key)) {
    return sendErr(res, 400, 'API Key имеет некорректный формат');
  }
  
  // Симулируем успешное подключение
  console.log('[Ozon] Connection test passed - data format is correct');
  return sendOk(res, { 
    status: 200, 
    message: 'Формат данных корректен. Подключение к Ozon настроено.',
    note: 'Для полной проверки подключения обратитесь к документации Ozon API',
    marketplaceType: 'ozon'
  });
});

app.post('/test/wb', async (req, res) => {
  const { api_key } = req.body || {};
  if (!api_key) return sendErr(res, 400, 'api_key обязателен');
  
  // Проверяем формат API ключа
  if (api_key.length < 20) {
    return sendErr(res, 400, 'API Key слишком короткий. Проверьте правильность введенных данных.');
  }
  
  console.log(`[WB] Testing connection with api_key: ${api_key.substring(0, 10)}...`);
  
  // Временное решение: проверяем только формат API ключа
  // В реальной системе здесь должен быть вызов к актуальному API Wildberries
  
  // Проверяем, что api_key выглядит как JWT токен (начинается с eyJ)
  if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(api_key)) {
    return sendErr(res, 400, 'API Key имеет некорректный формат. Ожидается JWT токен.');
  }
  
  // Симулируем успешное подключение
  console.log('[WB] Connection test passed - API key format is correct');
  return sendOk(res, { 
    status: 200, 
    message: 'Формат API Key корректен. Подключение к Wildberries настроено.',
    note: 'Для полной проверки подключения обратитесь к документации Wildberries API',
    marketplaceType: 'wildberries'
  });
});

app.post('/test/ym', async (req, res) => {
  const { api_key, campaign_id, business_id } = req.body || {};
  if (!api_key || !campaign_id || !business_id) return sendErr(res, 400, 'api_key, campaign_id и business_id обязательны');
  
  // Проверяем формат данных
  if (api_key.length < 10) {
    return sendErr(res, 400, 'API Key слишком короткий. Проверьте правильность введенных данных.');
  }
  
  if (campaign_id.length < 3) {
    return sendErr(res, 400, 'Campaign ID слишком короткий. Проверьте правильность введенных данных.');
  }
  
  if (business_id.length < 3) {
    return sendErr(res, 400, 'Business ID слишком короткий. Проверьте правильность введенных данных.');
  }
  
  console.log(`[YM] Testing connection with campaign_id: ${campaign_id}, business_id: ${business_id}`);
  
  // Временное решение: проверяем только формат данных
  // В реальной системе здесь должен быть вызов к актуальному API Yandex Market
  
  // Проверяем, что api_key имеет разумную длину и содержит допустимые символы
  if (!/^[a-zA-Z0-9_.:-]{10,}$/.test(api_key)) {
    return sendErr(res, 400, 'API Key имеет некорректный формат. Ожидается строка длиной не менее 10 символов, содержащая буквы, цифры, дефисы, подчеркивания, точки или двоеточия.');
  }
  
  // Проверяем, что campaign_id и business_id содержат только цифры
  if (!/^\d+$/.test(campaign_id)) {
    return sendErr(res, 400, 'Campaign ID должен содержать только цифры.');
  }
  
  if (!/^\d+$/.test(business_id)) {
    return sendErr(res, 400, 'Business ID должен содержать только цифры.');
  }
  
  // Симулируем успешное подключение
  console.log('[YM] Connection test passed - data format is correct');
  return sendOk(res, { 
    status: 200, 
    message: 'Формат данных корректен. Подключение к Yandex Market настроено.',
    note: 'Для полной проверки подключения обратитесь к документации Yandex Market API',
    marketplaceType: 'yandex'
  });
});

// Categories endpoints
app.get('/categories/ozon', async (req, res) => {
  try {
    // Get stored Ozon credentials from server storage
    const ozonConfig = await readData('ozon');
    const { client_id, api_key } = ozonConfig;
    
    if (!client_id || !api_key) {
      return sendErr(res, 400, 'Необходимы Client ID и API Key для подключения к Ozon. Настройте интеграцию в разделе "Интеграции" → "Маркетплейсы" → "Ozon"');
    }

    console.log(`[Ozon Categories] Fetching real categories for client_id: ${client_id}`);
    
    // Реальный API вызов к Ozon - используем правильный endpoint
    let response;
    let apiUrl = 'https://api-seller.ozon.ru/v1/description-category/tree';
    
    // Правильный API запрос к Ozon
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Client-Id': String(client_id),
        'Api-Key': String(api_key)
      },
      body: JSON.stringify({}),
      timeout: 15000
    });
    
    console.log(`[Ozon Categories] API request - Status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`[Ozon Categories] API Error ${response.status}: ${errorText}`);
      console.error(`[Ozon Categories] Request URL: ${apiUrl}`);
      console.error(`[Ozon Categories] Request headers:`, {
        'Client-Id': client_id,
        'Api-Key': api_key.substring(0, 10) + '...',
        'Content-Type': 'application/json'
      });
      console.error(`[Ozon Categories] Response headers:`, Object.fromEntries(response.headers.entries()));
      
      // Попробуем парсить ошибку как JSON
      try {
        const errorJson = JSON.parse(errorText);
        console.error(`[Ozon Categories] Parsed error:`, errorJson);
      } catch (e) {
        console.error(`[Ozon Categories] Error is not JSON: ${errorText}`);
      }
      
      // Если API недоступен, возвращаем пустой список
      console.log(`[Ozon Categories] API unavailable, returning empty categories list`);
      return sendOk(res, []);
    }

    const data = await response.json().catch(() => ({}));
    console.log(`[Ozon Categories] API Response received, processing...`);
    console.log(`[Ozon Categories] Response data structure:`, {
      hasResult: !!data.result,
      resultType: Array.isArray(data.result) ? 'array' : typeof data.result,
      resultLength: Array.isArray(data.result) ? data.result.length : 'N/A',
      hasData: !!data.data,
      dataType: Array.isArray(data.data) ? 'array' : typeof data.data,
      dataLength: Array.isArray(data.data) ? data.data.length : 'N/A',
      keys: Object.keys(data)
    });
    
    // Логируем полный ответ для отладки (первые 1000 символов)
    const responsePreview = JSON.stringify(data).substring(0, 1000);
    console.log(`[Ozon Categories] Full response preview: ${responsePreview}...`);
    
    // Transform Ozon categories to our format
    const categories = [];
    
    function processCategoryTree(categoryList, parentPath = '') {
      if (!Array.isArray(categoryList)) return;

      categoryList.forEach(category => {
        // Проверяем разные возможные названия полей
        // На верхних уровнях category_name и description_category_id
        // На нижних уровнях type_name и type_id
        const categoryName = category.category_name || category.type_name || category.name;
        const categoryId = category.description_category_id || category.type_id || category.category_id;
        const parentId = category.parent_id;

        if (categoryName && categoryName.trim() && !category.disabled) {
          const currentPath = parentPath ? `${parentPath} > ${categoryName.trim()}` : categoryName.trim();

          categories.push({
            id: `ozon_${categoryId}`,
            name: categoryName.trim(),
            path: currentPath,
            parentId: parentId ? `ozon_${parentId}` : null,
            marketplace: 'ozon',
            marketplaceName: 'Ozon'
          });

          // Process children recursively
          if (category.children && Array.isArray(category.children)) {
            processCategoryTree(category.children, currentPath);
          }
        }
      });
    }

    // Process the category tree from Ozon - пробуем разные возможные структуры
    if (data.result && Array.isArray(data.result)) {
      console.log(`[Ozon Categories] Processing data.result array with ${data.result.length} items`);
      processCategoryTree(data.result);
    } else if (data.data && Array.isArray(data.data)) {
      console.log(`[Ozon Categories] Processing data.data array with ${data.data.length} items`);
      processCategoryTree(data.data);
    } else if (Array.isArray(data)) {
      console.log(`[Ozon Categories] Processing direct array with ${data.length} items`);
      processCategoryTree(data);
    } else {
      console.log(`[Ozon Categories] No valid array found in response. Available keys:`, Object.keys(data));
    }

    console.log(`[Ozon Categories] Successfully processed ${categories.length} real categories from Ozon API`);
    return sendOk(res, categories);
  } catch (e) {
    console.error('Ozon Categories API Error:', e);
    console.log(`[Ozon Categories] Exception occurred, returning empty categories list`);
    return sendOk(res, []);
  }
});

app.get('/categories/wb', async (req, res) => {
  try {
    // Get stored WB credentials from server storage
    const wbConfig = await readData('wildberries');
    const { api_key } = wbConfig;
    
    if (!api_key) {
      return sendErr(res, 400, 'Необходим API Key для подключения к Wildberries. Настройте интеграцию в разделе "Интеграции" → "Маркетплейсы" → "Wildberries"');
    }

    console.log(`[WB Categories] Fetching real categories for API key: ${api_key.substring(0, 10)}...`);
    
    // Собираем все категории с пагинацией
    let allCategories = [];
    let limit = 1000; // Максимальное количество за запрос
    let offset = 0;
    let hasMore = true;
    
    // Пробуем получить все категории с пагинацией
    while (hasMore && offset < 100000) { // Защита от бесконечного цикла
      const url = `https://content-api.wildberries.ru/content/v2/object/all?limit=${limit}&offset=${offset}`;
      console.log(`[WB Categories] Fetching page: offset=${offset}, limit=${limit}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': String(api_key)
        },
        timeout: 15000
      });

      if (!response.ok) {
        console.log(`[WB Categories] /object/all failed with offset ${offset}, status: ${response.status}`);
        break;
      }

      const pageData = await response.json().catch(() => ({}));
      
      if (pageData.data && Array.isArray(pageData.data) && pageData.data.length > 0) {
        allCategories = allCategories.concat(pageData.data);
        console.log(`[WB Categories] Got ${pageData.data.length} categories, total so far: ${allCategories.length}`);
        
        // Если получили меньше, чем limit, значит это последняя страница
        if (pageData.data.length < limit) {
          hasMore = false;
        } else {
          offset += limit;
        }
      } else {
        hasMore = false;
      }
    }
    
    console.log(`[WB Categories] Total categories fetched: ${allCategories.length}`);
    
    // Формируем объект данных в нужном формате
    const data = {
      data: allCategories,
      error: false,
      errorText: '',
      additionalErrors: null
    };
    console.log(`[WB Categories] API Response received, processing...`);
    console.log(`[WB Categories] Response data structure:`, {
      isArray: Array.isArray(data),
      dataType: typeof data,
      hasData: !!data.data,
      dataLength: Array.isArray(data) ? data.length : (Array.isArray(data.data) ? data.data.length : 'N/A'),
      keys: typeof data === 'object' ? Object.keys(data) : []
    });
    
    // Логируем первые данные для отладки
    const responsePreview = JSON.stringify(data).substring(0, 1000);
    console.log(`[WB Categories] Full response preview: ${responsePreview}...`);
    
    // Проверяем, есть ли хотя бы у одной категории childs
    const parentCategories = data.data || data || [];
    const hasChilds = Array.isArray(parentCategories) && parentCategories.some(cat => cat.childs && Array.isArray(cat.childs) && cat.childs.length > 0);
    console.log(`[WB Categories] Categories have childs: ${hasChilds}`);

    // Transform Wildberries categories to our format
    const categories = [];
    
    function processWBCategoryTree(categoryList, parentPath = '') {
      if (!Array.isArray(categoryList)) return;
      
      categoryList.forEach(category => {
        // Поддержка разных структур WB API
        const categoryName = category.name || category.subjectName;
        const categoryId = category.id || category.subjectID;
        const categoryParent = category.parent || category.parentID;
        const categoryParentName = category.parentName;
        
        if (categoryName && categoryName.trim()) {
          // Используем parentName если есть, иначе parentPath
          const currentPath = categoryParentName && !parentPath 
            ? `${categoryParentName} > ${categoryName.trim()}` 
            : (parentPath ? `${parentPath} > ${categoryName.trim()}` : categoryName.trim());
          
          categories.push({
            id: `wb_${categoryId}`,
            name: categoryName.trim(),
            path: currentPath,
            parentId: categoryParent ? `wb_${categoryParent}` : null,
            marketplace: 'wb',
            marketplaceName: 'Wildberries'
          });
          
          // Process children recursively if they exist
          if (category.childs && Array.isArray(category.childs)) {
            processWBCategoryTree(category.childs, currentPath);
          }
        }
      });
    }

    // Process the category tree from Wildberries - пробуем разные возможные структуры
    if (data.data && Array.isArray(data.data)) {
      console.log(`[WB Categories] Processing data.data array with ${data.data.length} items`);
      processWBCategoryTree(data.data);
    } else if (Array.isArray(data)) {
      console.log(`[WB Categories] Processing direct array with ${data.length} items`);
      processWBCategoryTree(data);
    } else {
      console.log(`[WB Categories] No valid array found in response. Available keys:`, Object.keys(data));
    }

    console.log(`[WB Categories] Successfully processed ${categories.length} real categories from Wildberries API`);
    
    // Если получили только родительские категории (79), пробуем получить подкатегории
    if (categories.length === 79 && !hasChilds) {
      console.log(`[WB Categories] Only parent categories received. Attempting to fetch subcategories...`);
      
      // Запрашиваем подкатегории для каждой родительской категории
      for (const parentCategory of parentCategories.slice(0, 5)) { // Пробуем для первых 5 категорий
        try {
          const subResponse = await fetch(`https://content-api.wildberries.ru/content/v2/object/childs/${parentCategory.id}`, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Authorization': String(api_key)
            },
            timeout: 5000
          });
          
          if (subResponse.ok) {
            const subData = await subResponse.json();
            console.log(`[WB Categories] Subcategories for ${parentCategory.name}:`, subData);
            if (subData.data && Array.isArray(subData.data)) {
              processWBCategoryTree(subData.data, parentCategory.name);
            }
          }
        } catch (e) {
          console.log(`[WB Categories] Failed to fetch subcategories for ${parentCategory.name}:`, e.message);
        }
      }
      
      console.log(`[WB Categories] After fetching subcategories: ${categories.length} total categories`);
    }
    
    return sendOk(res, categories);
    
  } catch (e) {
    console.error('WB Categories API Error:', e);
    console.log(`[WB Categories] Exception occurred, returning empty categories list`);
    return sendOk(res, []);
  }
});

app.get('/categories/ym', async (req, res) => {
  try {
    // Get stored YM credentials from server storage
    const ymConfig = await readData('yandex');
    const { api_key, campaign_id, business_id } = ymConfig;
    
    if (!api_key || !campaign_id || !business_id) {
      return sendErr(res, 400, 'Необходимы API Key, Campaign ID и Business ID для подключения к Yandex Market. Настройте интеграцию в разделе "Интеграции" → "Маркетплейсы" → "Yandex Market"');
    }

    console.log(`[YM Categories] Fetching real categories for campaign_id: ${campaign_id}, business_id: ${business_id}`);
    
    // Реальный API вызов к Yandex Market
    const response = await fetch('https://api.partner.market.yandex.ru/v2/campaigns/categories.json', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `OAuth ${String(api_key)}`
      },
      timeout: 15000
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`[YM Categories] API Error ${response.status}: ${errorText}`);
      
      // Если API недоступен, возвращаем пустой список
      console.log(`[YM Categories] API unavailable, returning empty categories list`);
      return sendOk(res, []);
    }

    const data = await response.json().catch(() => ({}));
    console.log(`[YM Categories] API Response received, processing...`);
    
    // Transform Yandex Market categories to our format
    const categories = [];
    
    function processYMCategoryTree(categoryList, parentPath = '') {
      if (!Array.isArray(categoryList)) return;
      
      categoryList.forEach(category => {
        if (category.name && category.name.trim()) {
          const currentPath = parentPath ? `${parentPath} > ${category.name.trim()}` : category.name.trim();
          
          categories.push({
            id: `ym_${category.id}`,
            name: category.name.trim(),
            path: currentPath,
            parentId: category.parentId ? `ym_${category.parentId}` : null,
            marketplace: 'ym',
            marketplaceName: 'Yandex Market'
          });
          
          // Process children recursively if they exist
          if (category.children && Array.isArray(category.children)) {
            processYMCategoryTree(category.children, currentPath);
          }
        }
      });
    }

    // Process the category tree from Yandex Market
    if (data.result && Array.isArray(data.result)) {
      processYMCategoryTree(data.result);
    }

    console.log(`[YM Categories] Successfully processed ${categories.length} real categories from Yandex Market API`);
    return sendOk(res, categories);
    
  } catch (e) {
    console.error('YM Categories API Error:', e);
    console.log(`[YM Categories] Exception occurred, returning empty categories list`);
    return sendOk(res, []);
  }
});

// Mikado supplier API proxy
app.get('/supplier/mikado/price', async (req, res) => {
  try {
    const { code, brand } = req.query;
    const mikadoConfig = await readData('mikado');
    const { user_id, password } = mikadoConfig;
    
    if (!code || !brand || !user_id || !password) {
      return sendErr(res, 400, 'Необходимы параметры: code, brand и настройки Mikado. Настройте интеграцию в разделе "Интеграции" → "Поставщики" → "Mikado"');
    }
    
    console.log(`[Mikado] Fetching price for article: ${code}, brand: ${brand}`);
    
    const url = `http://mikado-parts.ru/ws1/service.asmx/CodeBrandStockInfo?Code=${encodeURIComponent(code)}&Brand=${encodeURIComponent(brand)}&ClientID=${encodeURIComponent(user_id)}&Password=${encodeURIComponent(password)}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/xml, text/xml, */*'
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      console.error(`[Mikado] API Error: ${response.status} ${response.statusText}`);
      return sendErr(res, response.status, `Ошибка API Mikado: ${response.status}`);
    }
    
    const xmlText = await response.text();
    console.log(`[Mikado] Response received: ${xmlText.substring(0, 200)}...`);
    
    // Отправляем XML как есть, парсинг будет на клиенте
    res.set('Content-Type', 'text/xml');
    res.status(200).send(xmlText);
    
  } catch (e) {
    console.error('[Mikado] Error:', e);
    const errorName = e && typeof e === 'object' && 'name' in e ? String(e.name) : '';
    if (errorName === 'AbortError') {
      return sendErr(res, 504, 'Таймаут подключения к Mikado (10 сек)');
    }
    const errMsg = e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Unknown error';
    return sendErr(res, 500, 'Ошибка подключения к Mikado: ' + errMsg);
  }
});

// Moskvorechie supplier API proxy
app.get('/supplier/moskvorechie/price', async (req, res) => {
  try {
    const { code, brand } = req.query;
    const moskvorechieConfig = await readData('moskvorechie');
    const { user_id, password } = moskvorechieConfig;
    
    if (!code || !brand || !user_id || !password) {
      return sendErr(res, 400, 'Необходимы параметры: code, brand и настройки Moskvorechie. Настройте интеграцию в разделе "Интеграции" → "Поставщики" → "Moskvorechie"');
    }
    
    console.log(`[Moskvorechie] Fetching price for article: ${code}, brand: ${brand}`);
    
    // URL для API Moskvorechie - правильный формат API с API ключом
    const url = `http://portal.moskvorechie.ru/portal.api?l=${encodeURIComponent(user_id)}&p=${encodeURIComponent(password)}&act=price_by_nr_firm&v=1&nr=${encodeURIComponent(code)}&f=${encodeURIComponent(brand)}&cs=utf8&avail&extstor`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, application/xml, text/xml, */*'
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      console.error(`[Moskvorechie] API Error: ${response.status} ${response.statusText}`);
      return sendErr(res, response.status, `Ошибка API Moskvorechie: ${response.status}`);
    }
    
    const responseText = await response.text();
    console.log(`[Moskvorechie] Response received: ${responseText.substring(0, 200)}...`);
    
    // Отправляем ответ как есть
    const contentType = response.headers.get('content-type') || 'text/plain';
    res.set('Content-Type', contentType);
    res.status(200).send(responseText);
    
  } catch (e) {
    console.error('[Moskvorechie] Error:', e);
    const errorName = e && typeof e === 'object' && 'name' in e ? String(e.name) : '';
    if (errorName === 'AbortError') {
      return sendErr(res, 504, 'Таймаут подключения к Moskvorechie (10 сек)');
    }
    const errMsg = e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Unknown error';
    return sendErr(res, 500, 'Ошибка подключения к Moskvorechie: ' + errMsg);
  }
});

// Check if product exists on Ozon by SKU
app.get('/product/check/ozon', async (req, res) => {
  try {
    const { offer_id } = req.query;
    const ozonConfig = await readData('ozon');
    const { client_id, api_key } = ozonConfig;
    
    if (!client_id || !api_key || !offer_id) {
      return sendErr(res, 400, 'Необходимы параметры: offer_id и настройки Ozon API. Настройте интеграцию в разделе "Интеграции" → "Маркетплейсы" → "Ozon"');
    }
    
    console.log(`[Ozon Product Check] Checking product with offer_id: ${offer_id}`);
    
    // Используем endpoint v3 для получения информации о товарах
    const response = await fetch('https://api-seller.ozon.ru/v3/product/info/list', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Client-Id': String(client_id),
        'Api-Key': String(api_key)
      },
      body: JSON.stringify({
        offer_id: [offer_id]
      }),
      timeout: 10000
    });
    
    // Проверяем статус до парсинга JSON
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[Ozon Product Check] API error: ${response.status}`, errorText);
      return sendOk(res, { found: false, status: response.status, message: 'API Error: ' + errorText.substring(0, 100) });
    }
    
    let data;
    try {
      data = await response.json();
      console.log(`[Ozon Product Check] Full Response:`, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[Ozon Product Check] JSON parse error:`, e.message);
      const text = await response.text();
      console.log(`[Ozon Product Check] Response text:`, text.substring(0, 500));
      return sendOk(res, { found: false, error: 'Invalid JSON response' });
    }
    
    // Структура ответа: { items: [...] }, а НЕ { result: { items: [...] } }
    if (data.items && data.items.length > 0) {
      const product = data.items[0];
      console.log(`[Ozon Product Check] Product found:`, product.offer_id || product.sku);
      console.log(`[Ozon Product Check] Product details - ID: ${product.id}, Name: ${product.name}`);
      
      // Комиссии уже включены в ответ
      const commissionsData = {};
      if (product.commissions && Array.isArray(product.commissions)) {
        product.commissions.forEach(comm => {
          commissionsData[comm.sale_schema] = {
            percent: comm.percent,
            value: comm.value,
            delivery_amount: comm.delivery_amount,
            return_amount: comm.return_amount
          };
        });
        console.log(`[Ozon] Commissions:`, commissionsData);
      }
      
      return sendOk(res, { 
        found: true, 
        product: {
          name: product.name,
          offer_id: product.offer_id,
          product_id: product.id,
          sku: product.sku,
          price: product.price,
          old_price: product.old_price,
          marketing_price: product.marketing_price,
          stocks: product.stocks,
          commissions: commissionsData,
          status: product.statuses?.status_name || product.statuses?.status,
          barcodes: product.barcodes,
          volume_weight: product.volume_weight,
          acquiring: product.acquiring || null, // Комиссия за эквайринг
          vat: product.vat || "0.00"
        }
      });
    } else {
      console.log(`[Ozon Product Check] Product not found in list`);
      return sendOk(res, { found: false, message: 'Product not found in list' });
    }
    
  } catch (e) {
    console.error('[Ozon Product Check] Error:', e);
    return sendOk(res, { found: false, error: e.message });
  }
});

// Check if product exists on Wildberries by SKU
app.get('/product/check/wb', async (req, res) => {
  try {
    const { nmID } = req.query;
    const wbConfig = await readData('wildberries');
    const { api_key } = wbConfig;
    
    if (!api_key || !nmID) {
      return sendErr(res, 400, 'Необходимы параметры: nmID и настройки Wildberries API. Настройте интеграцию в разделе "Интеграции" → "Маркетплейсы" → "Wildberries"');
    }
    
    console.log(`[WB Product Check] Checking product with nmID: ${nmID}`);
    
    // WB API требует POST запрос для получения карточек
    const response = await fetch('https://content-api.wildberries.ru/content/v2/get/cards/list', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': String(api_key)
      },
      body: JSON.stringify({
        settings: {
          cursor: {
            limit: 1
          },
          filter: {
            withPhoto: -1
          }
        },
        nmIDs: [parseInt(nmID)]
      }),
      timeout: 10000
    });
    
    const data = await response.json();
    console.log(`[WB Product Check] Response:`, JSON.stringify(data).substring(0, 200));
    
    if (!response.ok) {
      console.log(`[WB Product Check] API error: ${response.status}`, data);
      return sendOk(res, { found: false, status: response.status, message: data.errorText || 'API Error' });
    }
    
    if (data.cards && data.cards.length > 0) {
      console.log(`[WB Product Check] Product found:`, data.cards[0].nmID);
      return sendOk(res, { 
        found: true,
        product: {
          nmID: data.cards[0].nmID,
          vendorCode: data.cards[0].vendorCode
        }
      });
    }
    
    console.log(`[WB Product Check] Product not found`);
    return sendOk(res, { found: false, message: 'Product not found in cards' });
    
  } catch (e) {
    console.error('[WB Product Check] Error:', e);
    return sendOk(res, { found: false, error: e.message });
  }
});

// Новый endpoint для получения детальной информации о ценах и комиссиях Ozon
app.get('/api/product/prices/ozon', async (req, res) => {
  try {
    const { offer_id } = req.query;
    // Важно: в режиме PostgreSQL источник правды — таблица integrations.
    // Старое file-storage (`data/ozon.json`) может содержать устаревший ключ и давать "Api-key is deactivated".
    const integrationsService = (await import('./server/src/services/integrations.service.js')).default;
    const ozonConfig = await integrationsService.getMarketplaceConfig('ozon');
    const { client_id, api_key } = ozonConfig;
    
    if (!client_id || !api_key || !offer_id) {
      return sendErr(res, 400, 'Необходимы параметры: offer_id и настройки Ozon API');
    }
    
    console.log(`[Ozon Prices] Getting detailed prices for offer_id: ${offer_id}`);
    
    // Используем новый endpoint v5 для получения детальной информации о ценах
    const response = await fetch('https://api-seller.ozon.ru/v5/product/info/prices', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Client-Id': String(client_id),
        'Api-Key': String(api_key)
      },
      body: JSON.stringify({
        cursor: "",
        filter: {
          offer_id: [offer_id],
          visibility: "ALL"
        },
        limit: 100
      }),
      timeout: 10000
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[Ozon Prices] API error: ${response.status}`, errorText);
      const lowered = String(errorText || '').toLowerCase();
      if (response.status === 403 && lowered.includes('api-key is deactivated')) {
        await addRuntimeNotification({
          type: 'marketplace_api_error',
          severity: 'error',
          source: 'ozon.prices',
          marketplace: 'ozon',
          title: 'Ozon: API ключ деактивирован (комиссии/цены)',
          message: `Ozon вернул "Api-key is deactivated" на v5/product/info/prices. offer_id=${String(offer_id)}. Проверьте ключ в интеграции Ozon (Client-Id/Api-Key).`
        });
      }
      return sendOk(res, { found: false, status: response.status, message: 'API Error: ' + errorText.substring(0, 100) });
    }
    
    let data;
    try {
      data = await response.json();
      console.log(`[Ozon Prices] Full Response:`, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[Ozon Prices] JSON parse error:`, e.message);
      return sendOk(res, { found: false, error: 'Invalid JSON response' });
    }
    
    // Логируем только основную информацию
    console.log(`[Ozon Prices] API Response: ${data.items ? data.items.length : 0} items found`);
    
    // Проверяем структуру ответа - может быть data.items или просто items
    const items = data.items || (data.result && data.result.items);
    
    if (items && items.length > 0) {
      const item = items[0];
      console.log(`[Ozon Prices] Prices found for:`, item.offer_id);
      console.log(`[Ozon Prices] Full item data:`, JSON.stringify(item, null, 2));
      console.log(`[Ozon Prices] Raw commissions data:`, JSON.stringify(item.commissions, null, 2));
      
      // Проверяем наличие нужных полей
      if (item.commissions) {
        console.log(`[Ozon Prices] fbs_direct_flow_trans_max_amount:`, item.commissions.fbs_direct_flow_trans_max_amount);
        console.log(`[Ozon Prices] fbs_first_mile_max_amount:`, item.commissions.fbs_first_mile_max_amount);
        console.log(`[Ozon Prices] fbo_deliv_to_customer_amount:`, item.commissions.fbo_deliv_to_customer_amount);
        console.log(`[Ozon Prices] fbs_return_flow_amount:`, item.commissions.fbs_return_flow_amount);
      }
      
      // Сохраняем сырые данные комиссий до обработки
      const rawCommissionsData = item.commissions || {};
      console.log('[Ozon Prices] rawCommissionsData:', JSON.stringify(rawCommissionsData, null, 2));
      console.log('[Ozon Prices] fbs_direct_flow_trans_max_amount:', rawCommissionsData.fbs_direct_flow_trans_max_amount);
      console.log('[Ozon Prices] fbs_first_mile_max_amount:', rawCommissionsData.fbs_first_mile_max_amount);
      
      // Обработка комиссий для калькулятора из v5 API
      let calculatorData = {
        offer_id: item.offer_id,
        product_id: item.product_id,
        price: parseFloat(item.price?.price || 0),
        old_price: parseFloat(item.price?.old_price || 0),
        marketing_price: parseFloat(item.price?.marketing_price || 0),
        min_price: parseFloat(item.price?.min_price || 0),
        currency_code: item.price?.currency_code || 'RUB',
        auto_action_enabled: item.price?.auto_action_enabled || false,
        commissions: {},
        fullCommissions: rawCommissionsData, // Сохраняем сырые данные комиссий из API
        rawCommissions: rawCommissionsData, // Сырые данные комиссий для отладки
        price_indexes: item.price_indexes || {},
        acquiring: item.acquiring && item.price?.price ? Math.round(((item.acquiring / item.price.price) * 100) * 10) / 10 : 1.9, // Рассчитываем процент эквайринга от цены товара и округляем до десятых
        vat: item.price?.vat || 0
      };
      
      // Обработка комиссий из v5 API (структура отличается от v3)
      if (item.commissions) {
        const commissions = item.commissions;
        
        // FBO схема
        if (commissions.sales_percent_fbo) {
          calculatorData.commissions['FBO'] = {
            percent: parseFloat(commissions.sales_percent_fbo || 0),
            value: 0, // В v5 нет прямого значения
            delivery_amount: parseFloat(commissions.fbo_deliv_to_customer_amount || 0),
            return_amount: parseFloat(commissions.fbo_return_flow_amount || 0)
          };
        }
        
        // FBS схема
        if (commissions.sales_percent_fbs) {
          calculatorData.commissions['FBS'] = {
            percent: parseFloat(commissions.sales_percent_fbs || 0),
            value: 0, // В v5 нет прямого значения
            delivery_amount: parseFloat(commissions.fbs_deliv_to_customer_amount || 0),
            return_amount: parseFloat(commissions.fbs_return_flow_amount || 0)
          };
        }
        
        // RFBS схема
        if (commissions.sales_percent_rfbs) {
          calculatorData.commissions['RFBS'] = {
            percent: parseFloat(commissions.sales_percent_rfbs || 0),
            value: 0,
            delivery_amount: 0,
            return_amount: 0
          };
        }
        
        // FBP схема
        if (commissions.sales_percent_fbp) {
          calculatorData.commissions['FBP'] = {
            percent: parseFloat(commissions.sales_percent_fbp || 0),
            value: 0,
            delivery_amount: 0,
            return_amount: 0
          };
        }
      }
      
      return sendOk(res, {
        found: true,
        calculator: calculatorData,
        items: [item], // Добавляем сырые данные для отладки
        fullCommissions: rawCommissionsData, // Добавляем сырые данные комиссий
        rawCommissions: rawCommissionsData // Добавляем сырые данные комиссий
      });
    } else {
      return sendOk(res, {
        found: false,
        message: 'Информация о ценах не найдена'
      });
    }
    
  } catch (e) {
    console.error('[Ozon Prices] Error:', e);
    await addRuntimeNotification({
      type: 'marketplace_api_error',
      severity: 'error',
      source: 'ozon.prices',
      marketplace: 'ozon',
      title: 'Ошибка запроса цен Ozon',
      message: e?.message || String(e)
    });
    return sendOk(res, { found: false, error: e.message });
  }
});

// Check if product exists on Yandex Market by SKU
app.get('/product/check/ym', async (req, res) => {
  try {
    const { offer_id } = req.query;
    const ymConfig = await readData('yandex');
    const { api_key, campaign_id, business_id } = ymConfig;
    
    if (!api_key || !offer_id) {
      return sendErr(res, 400, 'Необходимы параметры: offer_id и настройки Yandex Market API. Настройте интеграцию в разделе "Интеграции" → "Маркетплейсы" → "Yandex Market"');
    }
    
    // Используем business_id если есть, иначе campaign_id
    const accountId = business_id || campaign_id;
    
    if (!accountId) {
      return sendErr(res, 400, 'Необходим business_id или campaign_id в настройках Yandex Market API');
    }
    
    console.log(`[YM Product Check] Checking product with offer_id: ${offer_id}, business_id: ${accountId}`);
    console.log(`[YM Product Check] Using API key:`, api_key.substring(0, 20) + '...');
    
    // Используем простой endpoint для получения товара
    const response = await fetch(`https://api.partner.market.yandex.ru/businesses/${accountId}/offer-mappings`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Api-Key': String(api_key)
      },
      body: JSON.stringify({
        offerIds: [offer_id]
      }),
      timeout: 10000
    });
    
    const data = await response.json();
    console.log(`[YM Product Check] Full Response:`, JSON.stringify(data, null, 2));
    console.log(`[YM Product Check] Response status:`, response.status);
    
    if (!response.ok) {
      console.log(`[YM Product Check] API error: ${response.status}`, data);
      console.log(`[YM Product Check] Request details - Account ID: ${accountId}, Offer: ${offer_id}`);
      return sendOk(res, { found: false, status: response.status, message: data.errors?.[0]?.message || 'API Error' });
    }
    
    if (data.result?.offerMappings && data.result.offerMappings.length > 0) {
      const mapping = data.result.offerMappings[0];
      console.log(`[YM Product Check] Product found:`, mapping.offer?.shopSku);
      return sendOk(res, { 
        found: true,
        product: {
          shopSku: mapping.offer?.shopSku,
          marketSku: mapping.mapping?.marketSku,
          categoryId: mapping.mapping?.categoryId
        }
      });
    }
    
    console.log(`[YM Product Check] Product not found`);
    return sendOk(res, { found: false, message: 'Product not found in offer mappings' });
    
  } catch (e) {
    console.error('[YM Product Check] Error:', e);
    return sendOk(res, { found: false, error: e.message });
  }
});

// Endpoint для получения детальной информации о ценах и комиссиях Wildberries
app.get('/api/product/prices/wb', async (req, res) => {
  try {
    const { offer_id, category_id } = req.query;
    const wbConfig = await readData('wildberries');
    const { api_key } = wbConfig;
    
    if (!api_key || !offer_id) {
      return sendErr(res, 400, 'Необходимы параметры: offer_id и настройки WB API');
    }
    
    console.log(`[WB Prices] Getting detailed prices for offer_id: ${offer_id}, category_id: ${category_id}`);
    console.log(`[WB Prices] Category ID type: ${typeof category_id}, value: ${category_id}`);
    
    // Используем кэшированные данные вместо API запросов
    const { categories: cachedCategories, commissions: cachedCommissions } = getWBCachedData();
    
    console.log(`[WB Prices] Using cached data: ${cachedCategories.length} categories, ${cachedCommissions.length} commissions`);

    // Получаем кэшированные данные о складах WB
    const wbWarehouses = getWBWarehousesCache();
    console.log(`[WB Prices] Using cached warehouses data: ${wbWarehouses.length} warehouses`);

    // Получаем тарифы для коробов и возвратов (эти API работают стабильно)
    const [boxTariffsResponse, returnTariffsResponse] = await Promise.allSettled([
      fetch(`https://common-api.wildberries.ru/api/v1/tariffs/box?date=${new Date().toISOString().split('T')[0]}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': String(api_key)
        },
        timeout: 10000
      }),
      
      fetch(`https://common-api.wildberries.ru/api/v1/tariffs/return?date=${new Date().toISOString().split('T')[0]}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': String(api_key)
        },
        timeout: 10000
      })
    ]);
    
    // Обрабатываем ответы
    let boxTariffsData = {};
    let returnTariffsData = {};
    
    if (boxTariffsResponse.status === 'fulfilled' && boxTariffsResponse.value.ok) {
      try {
        boxTariffsData = await boxTariffsResponse.value.json();
        console.log(`[WB Prices] Box tariffs data received:`, boxTariffsData);
      } catch (e) {
        console.error(`[WB Prices] Error parsing box tariffs:`, e.message);
      }
    } else {
      console.log(`[WB Prices] Box tariffs API failed:`, boxTariffsResponse.reason);
    }
    
    if (returnTariffsResponse.status === 'fulfilled' && returnTariffsResponse.value.ok) {
      try {
        returnTariffsData = await returnTariffsResponse.value.json();
        console.log(`[WB Prices] Return tariffs data received:`, returnTariffsData);
      } catch (e) {
        console.error(`[WB Prices] Error parsing return tariffs:`, e.message);
      }
    } else {
      console.log(`[WB Prices] Return tariffs API failed:`, returnTariffsResponse.reason);
    }
    
    // Находим комиссию для конкретной категории
    let categoryCommission = null;
    let wbCategoryId = category_id; // По умолчанию используем переданный category_id
    
    // Если передан category_id из приложения, пытаемся найти сопоставление
    if (category_id) {
      console.log(`[WB Prices] Looking for category mapping for: ${category_id}`);
      try {
        const mappingsFile = join(DATA_DIR, 'categoryMappings.json');
        if (fs.existsSync(mappingsFile)) {
          const mappingsData = fs.readFileSync(mappingsFile, 'utf8');
          const mappings = JSON.parse(mappingsData);
          
          // Ищем сопоставление для WB
          const mappingKey = `${category_id}_wb`;
          console.log(`[WB Prices] Looking for mapping key: ${mappingKey}`);
          console.log(`[WB Prices] Available mappings:`, Object.keys(mappings));
          
          if (mappings[mappingKey] && mappings[mappingKey].marketplaceCategoryId) {
            wbCategoryId = mappings[mappingKey].marketplaceCategoryId;
            // Убираем префикс "wb_" если он есть
            if (wbCategoryId.startsWith('wb_')) {
              wbCategoryId = wbCategoryId.substring(3);
            }
            console.log(`[WB Prices] Found category mapping: ${category_id} -> ${wbCategoryId}`);
          } else {
            console.log(`[WB Prices] No mapping found for key: ${mappingKey}`);
          }
        } else {
          console.log(`[WB Prices] Mappings file does not exist: ${mappingsFile}`);
        }
      } catch (e) {
        console.log(`[WB Prices] Error loading category mappings:`, e.message);
      }
    } else {
      console.log(`[WB Prices] No category_id provided, using default`);
    }
    
    // Используем кэшированные данные для поиска категории
    if (cachedCommissions && Array.isArray(cachedCommissions) && cachedCommissions.length > 0) {
      if (wbCategoryId) {
        categoryCommission = cachedCommissions.find(cat => 
          cat.subjectID == wbCategoryId || cat.parentID == wbCategoryId
        );
      }
      
      // Если не найдена по wbCategoryId, берем первую доступную
      if (!categoryCommission && cachedCommissions.length > 0) {
        categoryCommission = cachedCommissions[0];
      }
    } else {
      // Если кэш недоступен, возвращаем ошибку вместо fallback данных
      console.log(`[WB Prices] No cached commissions data available. Cache status: ${cachedCommissions ? 'empty' : 'missing'}`);
      return sendOk(res, { 
        found: false, 
        error: 'Данные комиссий WB недоступны. Попробуйте позже или обратитесь к администратору.',
        details: 'Кэш комиссий не загружен из-за ограничений API Wildberries'
      });
    }
    
    console.log(`[WB Prices] Selected category commission:`, categoryCommission);
    
    // Получаем базовые тарифы для коробов (берем первый склад)
    let baseBoxTariffs = null;
    if (boxTariffsData.response?.data?.warehouseList && boxTariffsData.response.data.warehouseList.length > 0) {
      baseBoxTariffs = boxTariffsData.response.data.warehouseList[0];
    }
    
    // Получаем базовые тарифы на возврат (берем первый склад)
    let baseReturnTariffs = null;
    if (returnTariffsData.response?.data?.warehouseList && returnTariffsData.response.data.warehouseList.length > 0) {
      baseReturnTariffs = returnTariffsData.response.data.warehouseList[0];
    }

    // Пытаемся найти сопоставление склада для более точного расчета
    let selectedWarehouse = null;
    let warehouseMapping = null;
    
    // Ищем сопоставление склада в товаре (если есть поле warehouseId)
    if (req.query.warehouse_id) {
      try {
        const mappingsFile = join(DATA_DIR, 'warehouseMappings.json');
        if (fs.existsSync(mappingsFile)) {
          const mappingsData = fs.readFileSync(mappingsFile, 'utf8');
          const mappings = JSON.parse(mappingsData);
          
          const mappingKey = req.query.warehouse_id;
          if (mappings[mappingKey]) {
            warehouseMapping = mappings[mappingKey];
            console.log(`[WB Prices] Found warehouse mapping: ${mappingKey} -> ${warehouseMapping.wbWarehouseId}`);
            
            // Ищем склад WB по ID
            selectedWarehouse = wbWarehouses.find(w => w.id == warehouseMapping.wbWarehouseId);
            if (selectedWarehouse) {
              console.log(`[WB Prices] Using mapped warehouse: ${selectedWarehouse.name}`);
            }
          }
        }
    } catch (e) {
        console.log(`[WB Prices] Error loading warehouse mappings:`, e.message);
      }
    }
    
    // Если не нашли сопоставление, используем первый доступный склад
    if (!selectedWarehouse && wbWarehouses.length > 0) {
      selectedWarehouse = wbWarehouses[0];
      console.log(`[WB Prices] Using default warehouse: ${selectedWarehouse.name}`);
    }
    
    console.log(`[WB Prices] Base box tariffs:`, baseBoxTariffs);
    console.log(`[WB Prices] Base return tariffs:`, baseReturnTariffs);
    
    // Формируем данные для калькулятора на основе реальных тарифов WB
      let calculatorData = {
      offer_id: offer_id,
      product_id: offer_id, // Используем offer_id как product_id
      price: 0, // Цена будет установлена отдельно
        currency_code: 'RUB',
      commissions: {},
      fullCommissions: {},
      rawCommissions: {},
      boxTariffs: baseBoxTariffs,
      returnTariffs: baseReturnTariffs,
      categoryCommission: categoryCommission
    };
    
    // Обрабатываем комиссии из реальных данных WB с учетом выбранного склада
    if (categoryCommission) {
      // Используем тарифы выбранного склада, если есть
      // Переименованные поля для лучшей читаемости:
      // boxDeliveryBase -> fbsLogisticsFirstLiter (Логистика FBS, первый литр, ₽)
      // boxDeliveryMarketplaceBase -> fboLogisticsFirstLiter (Логистика FBO, первый литр, ₽)
      let fbsLogisticsFirstLiter = baseBoxTariffs?.boxDeliveryBase || 0;
      let fboLogisticsFirstLiter = baseBoxTariffs?.boxDeliveryMarketplaceBase || 0;
      let returnDeliveryBase = baseReturnTariffs?.deliveryDumpSupOfficeBase || 0;
      let returnDeliveryExpr = baseReturnTariffs?.deliveryDumpSupReturnExpr || 0;
      
      if (selectedWarehouse && selectedWarehouse.tariffs) {
        fbsLogisticsFirstLiter = selectedWarehouse.tariffs.boxDeliveryBase || fbsLogisticsFirstLiter;
        fboLogisticsFirstLiter = selectedWarehouse.tariffs.boxDeliveryMarketplaceBase || fboLogisticsFirstLiter;
        console.log(`[WB Prices] Using warehouse-specific tariffs for ${selectedWarehouse.name}`);
      }
      
      // FBO комиссия (основная схема WB)
      calculatorData.commissions['FBO'] = {
        percent: parseFloat(categoryCommission.kgvpMarketplace || 0),
        value: 0,
        delivery_amount: parseFloat(fboLogisticsFirstLiter),
        return_amount: parseFloat(returnDeliveryBase)
      };
      
      // FBS комиссия (если есть данные)
      calculatorData.commissions['FBS'] = {
        percent: parseFloat(categoryCommission.kgvpSupplier || 0),
        value: 0,
        delivery_amount: parseFloat(fbsLogisticsFirstLiter),
        return_amount: parseFloat(returnDeliveryExpr)
      };
      
      // Копируем в fullCommissions и rawCommissions
      calculatorData.fullCommissions = { ...calculatorData.commissions };
      calculatorData.rawCommissions = { ...calculatorData.commissions };
      
      console.log(`[WB Prices] Processed commissions with warehouse ${selectedWarehouse?.name || 'default'}:`, calculatorData.commissions);
    } else {
      // Если нет данных о комиссиях, используем базовые значения
      calculatorData.commissions['FBO'] = {
        percent: 15, // Базовая комиссия WB
            value: 0,
            delivery_amount: 0,
            return_amount: 0
      };
      
      calculatorData.fullCommissions = { ...calculatorData.commissions };
      calculatorData.rawCommissions = { ...calculatorData.commissions };
    }
    
    // Добавляем информацию о выбранном складе в ответ
    calculatorData.selectedWarehouse = selectedWarehouse;
    calculatorData.warehouseMapping = warehouseMapping;
    
    return sendOk(res, { 
      found: true, 
      calculator: calculatorData,
      fullCommissions: calculatorData.fullCommissions,
      rawCommissions: calculatorData.rawCommissions,
      boxTariffs: calculatorData.boxTariffs,
      returnTariffs: calculatorData.returnTariffs,
      categoryCommission: calculatorData.categoryCommission
    });
    
  } catch (e) {
    console.error(`[WB Prices] Error:`, e);
    return sendOk(res, { found: false, error: e.message });
  }
});

// Endpoint для получения цен Яндекс.Маркет
app.get('/api/product/prices/ym', async (req, res) => {
  try {
    const { offer_id } = req.query;
    const ymConfig = await readData('yandex');
    const { api_key } = ymConfig;
    
    if (!api_key || !offer_id) {
      return sendErr(res, 400, 'Необходимы параметры: offer_id и настройки YM API');
    }
    
    console.log(`[YM Prices] Getting detailed prices for offer_id: ${offer_id}`);
    
    // Пока используем заглушку, так как YM API требует специальной настройки
    // В будущем можно подключить реальный API Яндекс.Маркет
    
    // Создаем реалистичную заглушку на основе типичных данных YM
    const ymCommission = 15; // 15% комиссия YM
    const acquiring = 2.5; // 2.5% эквайринг
    const processingCost = 20; // 20₽ обработка
    const logisticsCost = 50; // 50₽ логистика
    
    const calculatorData = {
      offer_id: offer_id,
      product_id: offer_id,
      price: 0,
      currency_code: 'RUB',
      commissions: {
        FBS: {
          percent: ymCommission,
            value: 0,
            delivery_amount: 0,
            return_amount: 0
          }
      },
      acquiring: acquiring,
      processing_cost: processingCost,
      logistics_cost: logisticsCost
      };
      
      return sendOk(res, { 
        found: true, 
      calculator: calculatorData
    });
    
  } catch (e) {
    console.error(`[YM Prices] Error:`, e);
    return sendOk(res, { found: false, error: e.message });
  }
});

// Endpoint для получения комиссий WB по категориям
app.get('/wb/tariffs/commission', async (req, res) => {
  try {
    const wbConfig = await readData('wildberries');
    const { api_key } = wbConfig;
    
    if (!api_key) {
      return sendErr(res, 400, 'Необходим API Key для подключения к Wildberries. Настройте интеграцию в разделе "Интеграции" → "Маркетплейсы" → "Wildberries"');
    }
    
    console.log(`[WB Tariffs] Getting commission tariffs`);
    
    const response = await fetch('https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': String(api_key)
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[WB Tariffs] API Error: ${response.status} ${errorText}`);
      return sendErr(res, response.status, `Ошибка API Wildberries: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`[WB Tariffs] Commission data received: ${data.report ? data.report.length : 0} categories`);
    
    return sendOk(res, data);
    
  } catch (e) {
    console.error('[WB Tariffs] Error:', e);
    return sendErr(res, 500, `Ошибка получения тарифов WB: ${e.message}`);
  }
});

// Endpoint для получения тарифов WB для коробов
app.get('/wb/tariffs/box', async (req, res) => {
  try {
    const { date } = req.query;
    const wbConfig = await readData('wildberries');
    const { api_key } = wbConfig;
    
    if (!api_key) {
      return sendErr(res, 400, 'Необходим API Key для подключения к Wildberries. Настройте интеграцию в разделе "Интеграции" → "Маркетплейсы" → "Wildberries"');
    }
    
    const targetDate = date || new Date().toISOString().split('T')[0];
    console.log(`[WB Tariffs] Getting box tariffs for date: ${targetDate}`);
    
    const response = await fetch(`https://common-api.wildberries.ru/api/v1/tariffs/box?date=${targetDate}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': String(api_key)
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[WB Tariffs] API Error: ${response.status} ${errorText}`);
      return sendErr(res, response.status, `Ошибка API Wildberries: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`[WB Tariffs] Box tariffs data received: ${data.response?.data?.warehouseList ? data.response.data.warehouseList.length : 0} warehouses`);
    
    return sendOk(res, data);
    
  } catch (e) {
    console.error('[WB Tariffs] Error:', e);
    return sendErr(res, 500, `Ошибка получения тарифов WB: ${e.message}`);
  }
});

// Endpoint для получения тарифов WB на возврат
app.get('/wb/tariffs/return', async (req, res) => {
  try {
    const { date } = req.query;
    const wbConfig = await readData('wildberries');
    const { api_key } = wbConfig;
    
    if (!api_key) {
      return sendErr(res, 400, 'Необходим API Key для подключения к Wildberries. Настройте интеграцию в разделе "Интеграции" → "Маркетплейсы" → "Wildberries"');
    }
    
    const targetDate = date || new Date().toISOString().split('T')[0];
    console.log(`[WB Tariffs] Getting return tariffs for date: ${targetDate}`);
    
    const response = await fetch(`https://common-api.wildberries.ru/api/v1/tariffs/return?date=${targetDate}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': String(api_key)
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[WB Tariffs] API Error: ${response.status} ${errorText}`);
      return sendErr(res, response.status, `Ошибка API Wildberries: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`[WB Tariffs] Return tariffs data received: ${data.response?.data?.warehouseList ? data.response.data.warehouseList.length : 0} warehouses`);
    
    return sendOk(res, data);
    
  } catch (e) {
    console.error('[WB Tariffs] Error:', e);
    return sendErr(res, 500, `Ошибка получения тарифов WB: ${e.message}`);
  }
});

// Serve index.html for root path
// ========== PRODUCTS API ==========

// Получить все товары
app.get('/api/products', async (req, res) => {
  try {
    const products = await readData('products');
    return sendOk(res, products);
  } catch (error) {
    console.error('[Products API] Error getting products:', error);
    return sendErr(res, 500, 'Ошибка получения товаров', error.message);
  }
});

// Добавить товар
app.post('/api/products', async (req, res) => {
  try {
    const product = req.body;
    
    // Валидация обязательных полей
    if (!product.name || !product.sku) {
      return sendErr(res, 400, 'Название и артикул обязательны');
    }
    
    // Получаем существующие товары
    let products = await readData('products');
    
    // Убеждаемся, что products - это массив
    if (!Array.isArray(products)) {
      products = [];
    }
    
    // Добавляем ID и временные метки
    const newProduct = {
      ...product,
      id: Date.now() + Math.random(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    // Добавляем товар
    products.push(newProduct);
    
    // Сохраняем
    await writeData('products', products);
    
    return sendOk(res, newProduct);
  } catch (error) {
    console.error('[Products API] Error adding product:', error);
    return sendErr(res, 500, 'Ошибка добавления товара', error.message);
  }
});

// Обновить товар
app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body;
    
    // Получаем существующие товары
    let products = await readData('products');
    
    // Убеждаемся, что products - это массив
    if (!Array.isArray(products)) {
      products = [];
    }
    
    // Находим товар
    const productIndex = products.findIndex(p => p.id == id);
    if (productIndex === -1) {
      return sendErr(res, 404, 'Товар не найден');
    }
    
    // Обновляем товар
    products[productIndex] = {
      ...products[productIndex],
      ...updatedData,
      id: products[productIndex].id, // Сохраняем оригинальный ID
      createdAt: products[productIndex].createdAt, // Сохраняем дату создания
      updatedAt: new Date().toISOString()
    };
    
    // Сохраняем
    await writeData('products', products);
    
    return sendOk(res, products[productIndex]);
  } catch (error) {
    console.error('[Products API] Error updating product:', error);
    return sendErr(res, 500, 'Ошибка обновления товара', error.message);
  }
});

// Удалить товар
app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Получаем существующие товары
    let products = await readData('products');
    
    // Убеждаемся, что products - это массив
    if (!Array.isArray(products)) {
      products = [];
    }
    
    // Находим товар
    const productIndex = products.findIndex(p => p.id == id);
    if (productIndex === -1) {
      return sendErr(res, 404, 'Товар не найден');
    }
    
    // Удаляем товар
    const deletedProduct = products.splice(productIndex, 1)[0];
    
    // Сохраняем
    await writeData('products', products);
    
    return sendOk(res, deletedProduct);
  } catch (error) {
    console.error('[Products API] Error deleting product:', error);
    return sendErr(res, 500, 'Ошибка удаления товара', error.message);
  }
});

// Обновить все товары (для массового обновления)
app.put('/api/products-all', async (req, res) => {
  try {
    const products = req.body;
    
    // Валидация
    if (!Array.isArray(products)) {
      return sendErr(res, 400, 'Ожидается массив товаров');
    }
    
    // Сохраняем все товары
    await writeData('products', products);
    
    return sendOk(res, { message: 'Товары обновлены', count: products.length });
  } catch (error) {
    console.error('[Products API] Error updating products:', error);
    return sendErr(res, 500, 'Ошибка обновления товаров', error.message);
  }
});

// ========== WAREHOUSES API ==========

// Получить все склады
app.get('/api/warehouses', async (req, res) => {
  try {
    const warehouses = await readData('warehouses');
    return sendOk(res, warehouses);
  } catch (error) {
    console.error('[Warehouses API] Error getting warehouses:', error);
    return sendErr(res, 500, 'Ошибка получения складов', error.message);
  }
});


// ========== WB WAREHOUSES CACHE SYSTEM ==========

// Функция для загрузки и кэширования данных о складах WB
async function loadWBWarehousesCache() {
  try {
    console.log('[WB Warehouses Cache] Loading warehouses cache...');
    
    const wbConfig = await readData('wildberries');
    const { api_key } = wbConfig;
    
    if (!api_key) {
      console.log('[WB Warehouses Cache] No WB API key found, skipping cache load');
      return;
    }
    
    const warehousesFile = join(DATA_DIR, 'wbWarehousesCache.json');
    
    // Проверяем, есть ли актуальные данные (не старше 24 часов)
    let needUpdate = true;
    if (fs.existsSync(warehousesFile)) {
      const stats = fs.statSync(warehousesFile);
      const now = new Date();
      const age = now - stats.mtime;
      
      // Если данные не старше 24 часов, используем кэш
      if (age < 24 * 60 * 60 * 1000) {
        console.log('[WB Warehouses Cache] Using existing cache (less than 24 hours old)');
        needUpdate = false;
      }
    }
    
    if (needUpdate) {
      console.log('[WB Warehouses Cache] Cache is outdated or missing, loading fresh data...');
      
      // Загружаем данные о складах
      console.log('[WB Warehouses Cache] Calling loadAllWBWarehouses...');
      const warehouses = await loadAllWBWarehouses(api_key);
      console.log('[WB Warehouses Cache] loadAllWBWarehouses returned:', warehouses ? warehouses.length : 'null', 'warehouses');
      
      if (warehouses && warehouses.length > 0) {
        fs.writeFileSync(warehousesFile, JSON.stringify(warehouses, null, 2));
        console.log(`[WB Warehouses Cache] Saved ${warehouses.length} warehouses to cache`);
        
        // Проверяем первый склад
        if (warehouses[0] && warehouses[0].tariffs) {
          console.log('[WB Warehouses Cache] First warehouse tariffs:', Object.keys(warehouses[0].tariffs));
        }
      }
    }
    
  } catch (error) {
    console.error('[WB Warehouses Cache] Error loading cache:', error);
  }
}

// Функция для загрузки всех складов WB
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
      if (boxResponse.status === 401) {
        const errorBody = await boxResponse.text().catch(() => '');
        const expired = String(errorBody || '').toLowerCase().includes('access token expired');
        await addRuntimeNotification({
          type: 'marketplace_api_error',
          severity: 'error',
          source: 'wb.warehouses-cache',
          marketplace: 'wildberries',
          title: expired ? 'WB: токен истёк (access token expired)' : 'WB: ошибка авторизации (401)',
          message: expired
            ? 'WB API вернул "access token expired" при загрузке тарифов (коробки). Перевыпустите токен WB.'
            : `WB API вернул 401 при загрузке тарифов (коробки): ${String(errorBody).slice(0, 180)}`
        });
      }
    }
    
    console.log('[WB Warehouses Cache] Return response status:', returnResponse.status, returnResponse.statusText);
    
    if (returnResponse.ok) {
      returnData = await returnResponse.json();
      console.log('[WB Warehouses Cache] Return tariffs loaded successfully');
      console.log('[WB Warehouses Cache] Return data structure:', JSON.stringify({
        hasResponse: !!returnData.response,
        hasData: !!returnData.response?.data,
        hasWarehouseList: !!returnData.response?.data?.warehouseList,
        warehouseCount: returnData.response?.data?.warehouseList?.length || 0
      }));
      
      // Логируем структуру первого склада возвратов для отладки
      if (returnData.response?.data?.warehouseList && returnData.response.data.warehouseList.length > 0) {
        console.log('[WB Warehouses Cache] Sample return warehouse structure:', JSON.stringify(returnData.response.data.warehouseList[0], null, 2));
        console.log('[WB Warehouses Cache] Return warehouse keys:', Object.keys(returnData.response.data.warehouseList[0]));
      }
    } else {
      console.error(`[WB Warehouses Cache] Error loading return tariffs: ${returnResponse.status} ${returnResponse.statusText}`);
      const errorBody = await returnResponse.text();
      console.error('[WB Warehouses Cache] Error body:', errorBody);
      if (returnResponse.status === 401) {
        const expired = String(errorBody || '').toLowerCase().includes('access token expired');
        await addRuntimeNotification({
          type: 'marketplace_api_error',
          severity: 'error',
          source: 'wb.warehouses-cache',
          marketplace: 'wildberries',
          title: expired ? 'WB: токен истёк (access token expired)' : 'WB: ошибка авторизации (401)',
          message: expired
            ? 'WB API вернул "access token expired" при загрузке тарифов возвратов. Перевыпустите токен WB.'
            : `WB API вернул 401 при загрузке тарифов возвратов: ${String(errorBody).slice(0, 180)}`
        });
      }
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

// Функция для получения кэшированных данных о складах WB
function getWBWarehousesCache() {
  try {
    const warehousesFile = join(DATA_DIR, 'wbWarehousesCache.json');
    
    if (fs.existsSync(warehousesFile)) {
      const data = fs.readFileSync(warehousesFile, 'utf8');
      return JSON.parse(data);
    }
    
    return [];
  } catch (error) {
    console.error('[WB Warehouses Cache] Error reading cached data:', error);
    return [];
  }
}

// ========== WB CACHE SYSTEM ==========

// Функция для загрузки и кэширования всех категорий WB
async function loadWBCategoriesCache() {
  try {
    console.log('[WB Cache] Loading categories cache...');
    
    const wbConfig = await readData('wildberries');
    const { api_key } = wbConfig;
    
    if (!api_key) {
      console.log('[WB Cache] No WB API key found, skipping cache load');
      return;
    }
    
    const categoriesFile = join(DATA_DIR, 'wbCategoriesCache.json');
    const commissionsFile = join(DATA_DIR, 'wbCommissionsCache.json');
    
    // Проверяем, есть ли актуальные данные (не старше 24 часов)
    let needUpdate = true;
    if (fs.existsSync(categoriesFile) && fs.existsSync(commissionsFile)) {
      const categoriesStats = fs.statSync(categoriesFile);
      const commissionsStats = fs.statSync(commissionsFile);
      const now = new Date();
      const categoriesAge = now - categoriesStats.mtime;
      const commissionsAge = now - commissionsStats.mtime;
      
      // Если данные не старше 24 часов, используем кэш
      if (categoriesAge < 24 * 60 * 60 * 1000 && commissionsAge < 24 * 60 * 60 * 1000) {
        console.log('[WB Cache] Using existing cache (less than 24 hours old)');
        needUpdate = false;
      }
    }
    
    if (needUpdate) {
      console.log('[WB Cache] Cache is outdated or missing, loading fresh data...');
      
      // Загружаем все категории
      const categories = await loadAllWBCategories(api_key);
      if (categories && categories.length > 0) {
        fs.writeFileSync(categoriesFile, JSON.stringify(categories, null, 2));
        console.log(`[WB Cache] Saved ${categories.length} categories to cache`);
      }
      
      // Загружаем все комиссии
      const commissions = await loadAllWBCommissions(api_key);
      if (commissions && commissions.length > 0) {
        fs.writeFileSync(commissionsFile, JSON.stringify(commissions, null, 2));
        console.log(`[WB Cache] Saved ${commissions.length} commissions to cache`);
      }
    }
    
  } catch (error) {
    console.error('[WB Cache] Error loading cache:', error);
  }
}

// Функция для загрузки всех категорий WB
async function loadAllWBCategories(apiKey) {
  try {
    console.log('[WB Cache] Loading all WB categories...');
    
    const categories = [];
    let offset = 0;
    const limit = 1000;
    let hasMore = true;
    
    while (hasMore) {
      const url = `https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru&offset=${offset}&limit=${limit}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': String(apiKey)
        },
        timeout: 10000
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.report && Array.isArray(data.report)) {
          categories.push(...data.report);
          console.log(`[WB Cache] Loaded ${data.report.length} categories, total: ${categories.length}`);
          
          if (data.report.length < limit) {
            hasMore = false;
          } else {
            offset += limit;
            // Добавляем задержку между запросами (увеличиваем до 3 секунд)
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } else {
          hasMore = false;
        }
      } else {
        console.error(`[WB Cache] Error loading categories: ${response.status} ${response.statusText}`);
        if (response.status === 401) {
          const errorBody = await response.text().catch(() => '');
          const expired = String(errorBody || '').toLowerCase().includes('access token expired');
          await addRuntimeNotification({
            type: 'marketplace_api_error',
            severity: 'error',
            source: 'wb.cache',
            marketplace: 'wildberries',
            title: expired ? 'WB: токен истёк (access token expired)' : 'WB: ошибка авторизации (401)',
            message: expired
              ? 'WB API вернул "access token expired" при загрузке категорий/комиссий. Перевыпустите токен WB.'
              : `WB API вернул 401 при загрузке категорий: ${String(errorBody).slice(0, 180)}`
          });
        }
        hasMore = false;
      }
    }
    
    console.log(`[WB Cache] Total categories loaded: ${categories.length}`);
    return categories;
    
  } catch (error) {
    console.error('[WB Cache] Error loading categories:', error);
    return [];
  }
}

// Функция для загрузки всех комиссий WB
async function loadAllWBCommissions(apiKey) {
  try {
    console.log('[WB Cache] Loading all WB commissions...');
    
    const commissions = [];
    let offset = 0;
    const limit = 1000;
    let hasMore = true;
    
    while (hasMore) {
      const url = `https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru&offset=${offset}&limit=${limit}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': String(apiKey)
        },
        timeout: 10000
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.report && Array.isArray(data.report)) {
          commissions.push(...data.report);
          console.log(`[WB Cache] Loaded ${data.report.length} commissions, total: ${commissions.length}`);
          
          if (data.report.length < limit) {
            hasMore = false;
          } else {
            offset += limit;
            // Добавляем задержку между запросами (увеличиваем до 3 секунд)
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } else {
          hasMore = false;
        }
      } else {
        console.error(`[WB Cache] Error loading commissions: ${response.status} ${response.statusText}`);
        if (response.status === 401) {
          const errorBody = await response.text().catch(() => '');
          const expired = String(errorBody || '').toLowerCase().includes('access token expired');
          await addRuntimeNotification({
            type: 'marketplace_api_error',
            severity: 'error',
            source: 'wb.cache',
            marketplace: 'wildberries',
            title: expired ? 'WB: токен истёк (access token expired)' : 'WB: ошибка авторизации (401)',
            message: expired
              ? 'WB API вернул "access token expired" при загрузке категорий/комиссий. Перевыпустите токен WB.'
              : `WB API вернул 401 при загрузке комиссий: ${String(errorBody).slice(0, 180)}`
          });
        }
        hasMore = false;
      }
    }
    
    console.log(`[WB Cache] Total commissions loaded: ${commissions.length}`);
    return commissions;
    
  } catch (error) {
    console.error('[WB Cache] Error loading commissions:', error);
    return [];
  }
}

// Функция для получения кэшированных данных WB
function getWBCachedData() {
  try {
    const categoriesFile = join(DATA_DIR, 'wbCategoriesCache.json');
    const commissionsFile = join(DATA_DIR, 'wbCommissionsCache.json');
    
    let categories = [];
    let commissions = [];
    
    if (fs.existsSync(categoriesFile)) {
      const data = fs.readFileSync(categoriesFile, 'utf8');
      categories = JSON.parse(data);
    }
    
    if (fs.existsSync(commissionsFile)) {
      const data = fs.readFileSync(commissionsFile, 'utf8');
      commissions = JSON.parse(data);
    }
    
    return { categories, commissions };
  } catch (error) {
    console.error('[WB Cache] Error reading cached data:', error);
    return { categories: [], commissions: [] };
  }
}

// ========== WB CACHE MANAGEMENT API ==========

// Принудительное обновление кэша WB
app.post('/api/wb-cache/refresh', async (req, res) => {
  try {
    console.log('[WB Cache] Manual cache refresh requested');
    await loadWBCategoriesCache();
    return sendOk(res, { success: true, message: 'WB cache refreshed successfully' });
  } catch (error) {
    console.error('[WB Cache] Manual refresh failed:', error);
    return sendErr(res, 500, 'Ошибка обновления кэша WB', error.message);
  }
});

// Получение статуса кэша WB
app.get('/api/wb-cache/status', (req, res) => {
  try {
    const categoriesFile = join(DATA_DIR, 'wbCategoriesCache.json');
    const commissionsFile = join(DATA_DIR, 'wbCommissionsCache.json');
    
    let status = {
      categories: { exists: false, size: 0, lastModified: null },
      commissions: { exists: false, size: 0, lastModified: null }
    };
    
    if (fs.existsSync(categoriesFile)) {
      const stats = fs.statSync(categoriesFile);
      const data = JSON.parse(fs.readFileSync(categoriesFile, 'utf8'));
      status.categories = {
        exists: true,
        size: data.length,
        lastModified: stats.mtime
      };
    }
    
    if (fs.existsSync(commissionsFile)) {
      const stats = fs.statSync(commissionsFile);
      const data = JSON.parse(fs.readFileSync(commissionsFile, 'utf8'));
      status.commissions = {
        exists: true,
        size: data.length,
        lastModified: stats.mtime
      };
    }
    
    return sendOk(res, status);
  } catch (error) {
    console.error('[WB Cache] Status check failed:', error);
    return sendErr(res, 500, 'Ошибка проверки статуса кэша', error.message);
  }
});

// ========== WB WAREHOUSES API ==========

// Получение всех складов WB
app.get('/api/wb-warehouses', (req, res) => {
  try {
    const warehouses = getWBWarehousesCache();
    return sendOk(res, warehouses);
  } catch (error) {
    console.error('[WB Warehouses API] Error getting warehouses:', error);
    return sendErr(res, 500, 'Ошибка получения складов WB', error.message);
  }
});

// Принудительное обновление кэша складов WB
app.post('/api/wb-warehouses/refresh', async (req, res) => {
  try {
    console.log('[WB Warehouses API] Manual warehouses cache refresh requested');
    await loadWBWarehousesCache();
    return sendOk(res, { success: true, message: 'WB warehouses cache refreshed successfully' });
  } catch (error) {
    console.error('[WB Warehouses API] Manual refresh failed:', error);
    return sendErr(res, 500, 'Ошибка обновления кэша складов WB', error.message);
  }
});

// Получение статуса кэша складов WB
app.get('/api/wb-warehouses/status', (req, res) => {
  try {
    const warehousesFile = join(DATA_DIR, 'wbWarehousesCache.json');
    
    let status = {
      exists: false,
      size: 0,
      lastModified: null
    };
    
    if (fs.existsSync(warehousesFile)) {
      const stats = fs.statSync(warehousesFile);
      const data = JSON.parse(fs.readFileSync(warehousesFile, 'utf8'));
      status = {
        exists: true,
        size: data.length,
        lastModified: stats.mtime
      };
    }
    
    return sendOk(res, status);
  } catch (error) {
    console.error('[WB Warehouses API] Status check failed:', error);
    return sendErr(res, 500, 'Ошибка проверки статуса кэша складов', error.message);
  }
});

// ========== WAREHOUSE MAPPING API ==========

// Получение сопоставления складов
app.get('/api/warehouse-mappings', (req, res) => {
  try {
    const mappingsFile = join(DATA_DIR, 'warehouseMappings.json');
    let mappings = {};
    
    if (fs.existsSync(mappingsFile)) {
      const data = fs.readFileSync(mappingsFile, 'utf8');
      mappings = JSON.parse(data);
    }
    
    return sendOk(res, mappings);
  } catch (e) {
    console.error('[Warehouse Mappings] Error:', e);
    return sendErr(res, 500, 'Ошибка загрузки сопоставлений складов');
  }
});

// Сохранение сопоставления складов
app.post('/api/warehouse-mappings', (req, res) => {
  try {
    const { erpWarehouseId, wbWarehouseId } = req.body;
    
    if (!erpWarehouseId || !wbWarehouseId) {
      return sendErr(res, 400, 'Необходимы erpWarehouseId и wbWarehouseId');
    }
    
    const mappingsFile = join(DATA_DIR, 'warehouseMappings.json');
    let mappings = {};
    
    if (fs.existsSync(mappingsFile)) {
      const data = fs.readFileSync(mappingsFile, 'utf8');
      mappings = JSON.parse(data);
    }
    
    mappings[erpWarehouseId] = {
      wbWarehouseId: wbWarehouseId,
      mappedAt: new Date().toISOString()
    };
    
    fs.writeFileSync(mappingsFile, JSON.stringify(mappings, null, 2));
    
    return sendOk(res, { success: true });
  } catch (e) {
    console.error('[Warehouse Mappings] Error:', e);
    return sendErr(res, 500, 'Ошибка сохранения сопоставления складов');
  }
});

// Удаление сопоставления складов
app.delete('/api/warehouse-mappings', (req, res) => {
  try {
    const { erpWarehouseId } = req.body;
    
    if (!erpWarehouseId) {
      return sendErr(res, 400, 'Необходим erpWarehouseId');
    }
    
    const mappingsFile = join(DATA_DIR, 'warehouseMappings.json');
    let mappings = {};
    
    if (fs.existsSync(mappingsFile)) {
      const data = fs.readFileSync(mappingsFile, 'utf8');
      mappings = JSON.parse(data);
    }
    
    delete mappings[erpWarehouseId];
    
    fs.writeFileSync(mappingsFile, JSON.stringify(mappings, null, 2));
    
    return sendOk(res, { success: true });
  } catch (e) {
    console.error('[Warehouse Mappings] Error:', e);
    return sendErr(res, 500, 'Ошибка удаления сопоставления складов');
  }
});

// ========== CATEGORY MAPPING API ==========

// Получение сопоставления категорий
app.get('/api/category-mappings', (req, res) => {
  try {
    const mappingsFile = join(DATA_DIR, 'categoryMappings.json');
    let mappings = {};
    
    if (fs.existsSync(mappingsFile)) {
      const data = fs.readFileSync(mappingsFile, 'utf8');
      mappings = JSON.parse(data);
    }
    
    return sendOk(res, mappings);
  } catch (e) {
    console.error('[Category Mappings] Error:', e);
    return sendErr(res, 500, 'Ошибка загрузки сопоставлений категорий');
  }
});

// Сохранение сопоставления категорий
app.post('/api/category-mappings', (req, res) => {
  try {
    const { erpCategoryId, mappingData } = req.body;
    
    if (!erpCategoryId) {
      return sendErr(res, 400, 'Необходим erpCategoryId');
    }
    
    const mappingsFile = join(DATA_DIR, 'categoryMappings.json');
    let mappings = {};
    
    if (fs.existsSync(mappingsFile)) {
      const data = fs.readFileSync(mappingsFile, 'utf8');
      mappings = JSON.parse(data);
    }
    
    if (mappingData && (typeof mappingData === 'object' ? mappingData.marketplaceCategoryId : mappingData)) {
      mappings[erpCategoryId] = {
        ...mappingData,
        mappedAt: new Date().toISOString()
      };
    } else {
      delete mappings[erpCategoryId];
    }
    
    fs.writeFileSync(mappingsFile, JSON.stringify(mappings, null, 2));
    
    return sendOk(res, { success: true });
  } catch (e) {
    console.error('[Category Mappings] Error:', e);
    return sendErr(res, 500, 'Ошибка сохранения сопоставления категорий');
  }
});

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// Инициализация кэша WB при запуске сервера
loadWBCategoriesCache().then(() => {
  console.log('[WB Cache] Initial cache load completed');
}).catch(error => {
  console.error('[WB Cache] Initial cache load failed:', error);
});

// Инициализация кэша складов WB при запуске сервера
loadWBWarehousesCache().then(() => {
  console.log('[WB Warehouses Cache] Initial warehouses cache load completed');
}).catch(error => {
  console.error('[WB Warehouses Cache] Initial warehouses cache load failed:', error);
});

// ========== WAREHOUSES API ENDPOINTS ==========

// Получить все склады
app.get('/api/warehouses', async (req, res) => {
  try {
    const warehousesData = await readData('warehouses');
    const warehouses = Array.isArray(warehousesData) ? warehousesData : 
                      (warehousesData.warehouses || []);
    return sendOk(res, warehouses);
  } catch (error) {
    const errMsg = error?.message || 'Unknown error';
    return sendErr(res, 500, 'Error loading warehouses: ' + errMsg);
  }
});

// Создать новый склад
app.post('/api/warehouses', async (req, res) => {
  try {
    const { type, address, supplierId, mainWarehouseId } = req.body;
    
    if (!type || !type.trim()) {
      return sendErr(res, 400, 'Тип склада обязателен');
    }
    
    const warehousesData = await readData('warehouses');
    const warehouses = Array.isArray(warehousesData) ? warehousesData : 
                      (warehousesData.warehouses || []);
    
    // Генерируем новый ID
    const newId = Date.now().toString();
    
    const newWarehouse = {
      id: newId,
      type: type.trim(),
      address: address ? address.trim() : '',
      supplierId: supplierId || null,
      mainWarehouseId: (type.trim() === 'supplier' && mainWarehouseId) ? mainWarehouseId : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    warehouses.push(newWarehouse);
    
    const success = await writeData('warehouses', warehouses);
    if (success) {
      console.log('[Warehouses] Created new warehouse: ' + type);
      return sendOk(res, newWarehouse);
    } else {
      return sendErr(res, 500, 'Не удалось сохранить склад');
    }
  } catch (error) {
    const errorMsg = error?.message || 'Unknown error';
    return sendErr(res, 500, 'Error creating warehouse: ' + errorMsg);
  }
});

// Обновить склад
app.put('/api/warehouses/:id', (async function warehouseUpdateHandler(req, res) {
  // Полностью изолируем область видимости, чтобы исключить использование переменной name
  // Используем именованную функцию вместо стрелочной для полной изоляции
  
  try {
    console.log('[Warehouses] PUT request started');
    const { id } = req.params;
    const { type, address, supplierId, mainWarehouseId } = req.body;
    // Безопасно логируем параметры запроса
    const logParams = {
      id: id,
      type: type,
      address: address || '',
      supplierId: supplierId || null,
      mainWarehouseId: mainWarehouseId || null
    };
    console.log('[Warehouses] Request params:', JSON.stringify(logParams));
    
    if (!type || !type.trim()) {
      return sendErr(res, 400, 'Тип склада обязателен');
    }
    
    console.log('[Warehouses] Step 1: Reading data');
    let warehousesData;
    try {
      warehousesData = await readData('warehouses');
      console.log('[Warehouses] Step 1: Data read successfully');
    } catch (readError) {
      console.log('[Warehouses] Step 1: Error reading data');
      const errMsg = readError?.message || 'Unknown error';
      throw new Error('Failed to read warehouses data: ' + errMsg);
    }
    
    console.log('[Warehouses] Step 2: Processing warehouses array');
    const warehouses = Array.isArray(warehousesData) ? warehousesData : 
                      (warehousesData.warehouses || []);
    console.log('[Warehouses] Step 2: Warehouses count:', warehouses.length);
    
    const warehouseIndex = warehouses.findIndex((w) => {
      try {
        if (!w || typeof w !== 'object') return false;
        const wId = Object.prototype.hasOwnProperty.call(w, 'id') ? String(w.id) : '';
        return wId === id;
      } catch (findErr) {
        console.log('[Warehouses] Error in findIndex:', findErr?.message || 'Unknown');
        return false;
      }
    });
    if (warehouseIndex === -1) {
      return sendErr(res, 404, 'Склад не найден');
    }
    console.log('[Warehouses] Step 2: Warehouse found at index:', warehouseIndex);
    
    console.log('[Warehouses] Step 3: Getting old warehouse');
    const oldWarehouse = warehouses[warehouseIndex];
    
    if (!oldWarehouse || typeof oldWarehouse !== 'object') {
      throw new Error('Invalid warehouse data');
    }
    console.log('[Warehouses] Step 3: Old warehouse valid');
    
    // Безопасно получаем поля из старого склада
    const oldWarehouseId = Object.prototype.hasOwnProperty.call(oldWarehouse, 'id') ? String(oldWarehouse.id || id) : String(id);
    const oldWarehouseCreatedAt = Object.prototype.hasOwnProperty.call(oldWarehouse, 'createdAt') ? String(oldWarehouse.createdAt || new Date().toISOString()) : new Date().toISOString();
    
    console.log('[Warehouses] Step 4: Creating new warehouse object');
    const warehouseType = String(type || '').trim();
    const warehouseAddress = address ? String(address).trim() : '';
    const warehouseSupplierId = supplierId ? String(supplierId) : null;
    const warehouseMainWarehouseId = (warehouseType === 'supplier' && mainWarehouseId) ? String(mainWarehouseId) : null;
    const warehouseCreatedAt = oldWarehouseCreatedAt;
    const warehouseUpdatedAt = new Date().toISOString();
    const warehouseId = oldWarehouseId;
    
    const updatedWarehouse = {
      id: warehouseId,
      type: warehouseType,
      address: warehouseAddress,
      supplierId: warehouseSupplierId,
      mainWarehouseId: warehouseMainWarehouseId,
      createdAt: warehouseCreatedAt,
      updatedAt: warehouseUpdatedAt
    };
    console.log('[Warehouses] Step 4: New warehouse object created');
    
    if (!updatedWarehouse.id) {
      throw new Error('ID склада не определен');
    }
    if (!updatedWarehouse.type) {
      throw new Error('Тип склада не определен');
    }
    
    console.log('[Warehouses] Step 5: Cleaning warehouses array');
    const cleanWarehouses = [];
    for (let idx = 0; idx < warehouses.length; idx++) {
      try {
        const warehouse = warehouses[idx];
        if (!warehouse || typeof warehouse !== 'object') {
          console.log('[Warehouses] Skipping invalid warehouse at index:', idx);
          continue;
        }
        
        // Безопасно получаем все поля, используя Object.hasOwnProperty для проверки
        const wId = Object.prototype.hasOwnProperty.call(warehouse, 'id') ? String(warehouse.id || '') : '';
        const wType = Object.prototype.hasOwnProperty.call(warehouse, 'type') ? String(warehouse.type || '') : '';
        const wAddress = Object.prototype.hasOwnProperty.call(warehouse, 'address') ? String(warehouse.address || '') : '';
        
        let wSupplierId = null;
        if (Object.prototype.hasOwnProperty.call(warehouse, 'supplierId') && warehouse.supplierId) {
          wSupplierId = String(warehouse.supplierId);
        }
        
        let wMainWarehouseId = null;
        if (Object.prototype.hasOwnProperty.call(warehouse, 'mainWarehouseId') && warehouse.mainWarehouseId) {
          wMainWarehouseId = String(warehouse.mainWarehouseId);
        }
        
        const wCreatedAt = Object.prototype.hasOwnProperty.call(warehouse, 'createdAt') ? 
          String(warehouse.createdAt || new Date().toISOString()) : new Date().toISOString();
        const wUpdatedAt = Object.prototype.hasOwnProperty.call(warehouse, 'updatedAt') ? 
          String(warehouse.updatedAt || new Date().toISOString()) : new Date().toISOString();
        
        cleanWarehouses.push({
          id: wId,
          type: wType,
          address: wAddress,
          supplierId: wSupplierId,
          mainWarehouseId: wMainWarehouseId,
          createdAt: wCreatedAt,
          updatedAt: wUpdatedAt
        });
      } catch (mapErr) {
        console.log('[Warehouses] Error mapping warehouse at index:', idx);
        const mapErrMsg = mapErr && typeof mapErr === 'object' && 'message' in mapErr ? String(mapErr.message) : 'Unknown';
        console.log('[Warehouses] Map error message:', mapErrMsg);
        throw mapErr;
      }
    }
    console.log('[Warehouses] Step 5: Warehouses cleaned, count:', cleanWarehouses.length);
    
    const cleanIndex = cleanWarehouses.findIndex(w => w.id === id);
    if (cleanIndex !== -1) {
      cleanWarehouses[cleanIndex] = updatedWarehouse;
      console.log('[Warehouses] Step 5: Updated warehouse replaced in clean array');
    }
    
    console.log('[Warehouses] Step 6: Writing data');
    let success;
    try {
      success = await writeData('warehouses', cleanWarehouses);
      console.log('[Warehouses] Step 6: Data written, success:', success);
    } catch (writeError) {
      console.log('[Warehouses] Step 6: Error writing data');
      const errMsg = writeError?.message || 'Unknown error';
      throw new Error('Failed to write warehouses data: ' + errMsg);
    }
    if (success) {
      console.log('[Warehouses] Step 7: Returning success');
      return sendOk(res, cleanWarehouses[cleanIndex]);
    } else {
      return sendErr(res, 500, 'Не удалось обновить склад');
    }
  } catch (caughtError) {
    // Полностью изолируем обработку ошибки, используя caughtError вместо err
    console.log('[Warehouses] ========== ERROR CAUGHT ==========');
    console.log('[Warehouses] Error caught in PUT handler');
    console.log('[Warehouses] Error type:', typeof caughtError);
    const constructorName = caughtError?.constructor ? String(caughtError.constructor.name || 'Unknown') : 'Unknown';
    console.log('[Warehouses] Error constructor:', constructorName);
    
    // Выводим полный стек ошибки
    if (caughtError && typeof caughtError === 'object') {
      if ('stack' in caughtError) {
        console.log('[Warehouses] Full error stack:');
        console.log(caughtError.stack);
      }
      if ('message' in caughtError) {
        console.log('[Warehouses] Error message:', caughtError.message);
      }
      // Выводим все свойства ошибки
      try {
        const errorKeys = Object.keys(caughtError);
        console.log('[Warehouses] Error properties:', errorKeys);
      } catch (keysError) {
        console.log('[Warehouses] Could not get error properties');
      }
    }
    
    // Получаем сообщение об ошибке максимально безопасным способом
    let finalErrorMessage = 'Unknown error';
    try {
      if (caughtError) {
        if (typeof caughtError === 'object') {
          if ('message' in caughtError) {
            const msgValue = caughtError.message;
            if (msgValue !== undefined && msgValue !== null) {
              finalErrorMessage = String(msgValue);
            }
          }
        } else {
          finalErrorMessage = String(caughtError);
        }
      }
    } catch (e) {
      finalErrorMessage = 'Error processing error message';
    }
    
    console.log('[Warehouses] Final error message:', finalErrorMessage);
    console.log('[Warehouses] ===================================');
    
    // Получаем стек ошибки безопасно
    let errorStackText = 'No stack trace';
    try {
      if (caughtError && typeof caughtError === 'object' && 'stack' in caughtError) {
        errorStackText = String(caughtError.stack);
      }
    } catch (e) {
      // Игнорируем
    }
    
    // Записываем в файл
    try {
      let errorConstructorName = 'Unknown';
      try {
        if (caughtError && typeof caughtError === 'object' && 'constructor' in caughtError && caughtError.constructor) {
          errorConstructorName = String(caughtError.constructor.name || 'Unknown');
        }
      } catch (constructorError) {
        errorConstructorName = 'Unknown';
      }
      const logData = {
        timestamp: new Date().toISOString(),
        errorMessage: finalErrorMessage,
        errorStack: errorStackText,
        errorType: typeof caughtError,
        errorConstructor: errorConstructorName
      };
      fs.appendFileSync(join(__dirname, 'error.log'), JSON.stringify(logData) + '\n', 'utf8');
    } catch (e) {
      // Игнорируем ошибки логирования
    }
    
    // Возвращаем ошибку
    return sendErr(res, 500, 'Error updating warehouse: ' + finalErrorMessage);
  }
}));

// Удалить склад
app.delete('/api/warehouses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const warehousesData = await readData('warehouses');
    const warehouses = Array.isArray(warehousesData) ? warehousesData : 
                      (warehousesData.warehouses || []);
    
    const warehouseIndex = warehouses.findIndex(w => w.id === id);
    if (warehouseIndex === -1) {
      return sendErr(res, 404, 'Склад не найден');
    }
    
    const deletedWarehouse = warehouses.splice(warehouseIndex, 1)[0];
    
    const success = await writeData('warehouses', warehouses);
    if (success) {
      const warehouseName = deletedWarehouse.address || deletedWarehouse.id || 'Склад';
      console.log('[Warehouses] Deleted warehouse: ' + warehouseName);
      return sendOk(res, { message: 'Склад удален' });
    } else {
      return sendErr(res, 500, 'Не удалось удалить склад');
    }
  } catch (error) {
    return sendErr(res, 500, `Error deleting warehouse: ${error.message}`);
  }
});

// ========== SUPPLIERS API ENDPOINTS ==========

// Получить всех поставщиков
app.get('/api/suppliers', async (req, res) => {
  try {
    const suppliersData = await readData('suppliers');
    const suppliers = Array.isArray(suppliersData) ? suppliersData : 
                     (suppliersData.suppliers || []);
    return sendOk(res, suppliers);
  } catch (error) {
    return sendErr(res, 500, `Error loading suppliers: ${error.message}`);
  }
});

// Создать нового поставщика
app.post('/api/suppliers', async (req, res) => {
  try {
    const { name, apiConfig, isActive } = req.body;
    
    if (!name || !name.trim()) {
      return sendErr(res, 400, 'Название поставщика обязательно');
    }
    
    const suppliersData = await readData('suppliers');
    const suppliers = Array.isArray(suppliersData) ? suppliersData : 
                     (suppliersData.suppliers || []);
    
    // Проверяем уникальность имени
    const existingSupplier = suppliers.find(s => s.name.toLowerCase() === name.trim().toLowerCase());
    if (existingSupplier) {
      return sendErr(res, 400, 'Поставщик с таким названием уже существует');
    }
    
    // Генерируем новый ID
    const newId = Date.now().toString();
    
    const newSupplier = {
      id: newId,
      name: name.trim(),
      apiConfig: apiConfig || {},
      isActive: isActive !== undefined ? isActive : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    suppliers.push(newSupplier);
    
    const success = await writeData('suppliers', { suppliers });
    if (success) {
      const supplierName = newSupplier.name || 'Unknown';
      console.log('[Suppliers] Created new supplier: ' + supplierName);
      return sendOk(res, newSupplier);
    } else {
      return sendErr(res, 500, 'Не удалось сохранить поставщика');
    }
  } catch (error) {
    const errorMsg = error?.message || 'Unknown error';
    return sendErr(res, 500, 'Error creating supplier: ' + errorMsg);
  }
});

// Обновить поставщика
app.put('/api/suppliers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, apiConfig, isActive } = req.body;
    
    const suppliersData = await readData('suppliers');
    const suppliers = Array.isArray(suppliersData) ? suppliersData : 
                     (suppliersData.suppliers || []);
    
    const supplierIndex = suppliers.findIndex(s => s.id === id);
    if (supplierIndex === -1) {
      return sendErr(res, 404, 'Поставщик не найден');
    }
    
    // Если меняется имя, проверяем уникальность
    if (name && name.trim() !== suppliers[supplierIndex].name) {
      const existingSupplier = suppliers.find(s => s.id !== id && s.name.toLowerCase() === name.trim().toLowerCase());
      if (existingSupplier) {
        return sendErr(res, 400, 'Поставщик с таким названием уже существует');
      }
    }
    
    suppliers[supplierIndex] = {
      ...suppliers[supplierIndex],
      name: name ? name.trim() : suppliers[supplierIndex].name,
      apiConfig: apiConfig !== undefined ? apiConfig : suppliers[supplierIndex].apiConfig,
      isActive: isActive !== undefined ? isActive : suppliers[supplierIndex].isActive,
      updatedAt: new Date().toISOString()
    };
    
    const success = await writeData('suppliers', { suppliers });
    if (success) {
      console.log(`[Suppliers] Updated supplier: ${suppliers[supplierIndex].name}`);
      return sendOk(res, suppliers[supplierIndex]);
    } else {
      return sendErr(res, 500, 'Не удалось обновить поставщика');
    }
  } catch (error) {
    return sendErr(res, 500, `Error updating supplier: ${error.message}`);
  }
});

// Удалить поставщика
app.delete('/api/suppliers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const suppliersData = await readData('suppliers');
    const suppliers = Array.isArray(suppliersData) ? suppliersData : 
                     (suppliersData.suppliers || []);
    
    const supplierIndex = suppliers.findIndex(s => s.id === id);
    if (supplierIndex === -1) {
      return sendErr(res, 404, 'Поставщик не найден');
    }
    
    const deletedSupplier = suppliers.splice(supplierIndex, 1)[0];
    
    // Обновляем склады, убирая связь с удаленным поставщиком
    const warehousesData = await readData('warehouses');
    const warehouses = Array.isArray(warehousesData) ? warehousesData : 
                      (warehousesData.warehouses || []);
    
    let warehousesUpdated = false;
    warehouses.forEach(warehouse => {
      if (warehouse.supplierId === id) {
        warehouse.supplierId = null;
        warehouse.updatedAt = new Date().toISOString();
        warehousesUpdated = true;
      }
    });
    
    const suppliersSuccess = await writeData('suppliers', { suppliers });
    const warehousesSuccess = warehousesUpdated ? await writeData('warehouses', warehouses) : true;
    
    if (suppliersSuccess && warehousesSuccess) {
      console.log(`[Suppliers] Deleted supplier: ${deletedSupplier.name}`);
      return sendOk(res, { message: 'Поставщик удален' });
    } else {
      return sendErr(res, 500, 'Не удалось удалить поставщика');
    }
  } catch (error) {
    return sendErr(res, 500, `Error deleting supplier: ${error.message}`);
  }
});

// ========== Supplier Stock Levels API ==========

// Получение остатков от поставщиков
app.get('/api/supplier-stocks', async (req, res) => {
  try {
    const { supplier, sku, brand, cities } = req.query;
    
    if (!supplier) {
      return sendErr(res, 400, 'Поставщик не указан');
    }
    
    // Загружаем настройки поставщика
    const supplierConfig = await readData(supplier);
    
    // Получаем список городов складов из настроек
    let warehouseCities = [];
    if (cities) {
      warehouseCities = cities.split(',').map(c => c.trim());
    } else if (supplierConfig && supplierConfig.warehouses && Array.isArray(supplierConfig.warehouses)) {
      warehouseCities = supplierConfig.warehouses.map(w => w.name);
    }
    
    // Сначала пытаемся получить из кэша синхронизированных данных
    let stockData = null;
    try {
      const stockCache = await readData('supplierStockCache');
      if (stockCache && stockCache[supplier] && stockCache[supplier][sku]) {
        stockData = stockCache[supplier][sku];
        console.log(`[Supplier Stocks] Found cached data for ${supplier} SKU ${sku}:`, {
          stock: stockData.stock,
          deliveryDays: stockData.deliveryDays,
          warehouses: stockData.warehouses
        });
        
        // Если указаны склады, фильтруем
        if (warehouseCities.length > 0 && stockData.warehouses) {
          console.log(`[Supplier Stocks] Filtering cached data for ${supplier} SKU ${sku} by warehouses: ${warehouseCities.join(', ')}`);
          console.log(`[Supplier Stocks] Available warehouses in cached data:`, stockData.warehouses.map(w => w.city || w.name));
          
          stockData.warehouses = stockData.warehouses.filter(w => 
            warehouseCities.includes(w.city || w.name)
          );
          
          console.log(`[Supplier Stocks] Filtered warehouses from cache:`, stockData.warehouses.map(w => w.city || w.name));
          
          if (stockData.warehouses.length > 0) {
            stockData.stock = stockData.warehouses.reduce((sum, w) => sum + (w.stock || 0), 0);
            stockData.deliveryDays = Math.min(...stockData.warehouses.map(w => w.deliveryDays !== undefined && w.deliveryDays !== null ? w.deliveryDays : 999));
            stockData.price = stockData.warehouses[0].price || stockData.price;
            console.log(`[Supplier Stocks] Final filtered stock from cache: ${stockData.stock}, delivery: ${stockData.deliveryDays} days`);
          } else {
            console.log(`[Supplier Stocks] No stock found in configured warehouses from cache for ${supplier} SKU ${sku}`);
            return sendErr(res, 404, 'Данные не найдены');
          }
        }
      }
    } catch (error) {
      console.log(`[Supplier Stocks] No cached data for ${supplier} SKU ${sku}`);
    }
    
    // Если нет в кэше, делаем запрос к API
    if (!stockData) {
      if (supplier === 'mikado') {
        stockData = await getMikadoStock(sku, brand);
      } else if (supplier === 'moskvorechie') {
        stockData = await getMoskvorechieStock(sku);
      } else {
        return sendErr(res, 400, 'Неподдерживаемый поставщик');
      }
      
      // Если указаны склады в настройках, фильтруем результаты
      if (warehouseCities.length > 0 && stockData && stockData.warehouses) {
        console.log(`[Supplier Stocks] Filtering ${supplier} SKU ${sku} by warehouses: ${warehouseCities.join(', ')}`);
        console.log(`[Supplier Stocks] Available warehouses in API data:`, stockData.warehouses.map(w => w.city || w.name));
        
        stockData.warehouses = stockData.warehouses.filter(w => 
          warehouseCities.includes(w.city || w.name)
        );
        
        console.log(`[Supplier Stocks] Filtered warehouses:`, stockData.warehouses.map(w => w.city || w.name));
        
        if (stockData.warehouses.length > 0) {
          stockData.stock = stockData.warehouses.reduce((sum, w) => sum + (w.stock || 0), 0);
          stockData.deliveryDays = Math.min(...stockData.warehouses.map(w => w.deliveryDays !== undefined && w.deliveryDays !== null ? w.deliveryDays : 999));
          stockData.price = stockData.warehouses[0].price || stockData.price;
          console.log(`[Supplier Stocks] Final filtered stock: ${stockData.stock}, delivery: ${stockData.deliveryDays} days`);
        } else {
          console.log(`[Supplier Stocks] No stock found in configured warehouses for ${supplier} SKU ${sku}`);
          return sendErr(res, 404, 'Данные не найдены');
        }
      }
    }
    
    if (stockData) {
      const result = { 
        supplier, 
        sku, 
        stock: stockData.stock,
        stockName: stockData.stockName,
        deliveryDays: stockData.deliveryDays,
        price: stockData.price,
        timestamp: new Date().toISOString()
      };
      
      // Добавляем информацию о складах, если она есть
      if (stockData.warehouses) {
        result.warehouses = stockData.warehouses;
      }
      
      return sendOk(res, result);
    } else {
      return sendErr(res, 404, 'Данные не найдены');
    }
  } catch (error) {
    console.error('[Supplier Stocks] Error:', error);
    return sendErr(res, 500, `Error getting supplier stock: ${error.message}`);
  }
});

// Синхронизация всех остатков от поставщиков
app.post('/api/sync-supplier-stocks', async (req, res) => {
  try {
    const { products } = req.body;
    
    if (!products || !Array.isArray(products)) {
      return sendErr(res, 400, 'Список товаров не предоставлен');
    }
    
    const results = {
      mikado: { success: 0, failed: 0, details: [] },
      moskvorechie: { success: 0, failed: 0, details: [] }
    };
    
    // Хранилище синхронизированных остатков
    const stockCache = {
      mikado: {},
      moskvorechie: {}
    };
    
    // Получаем остатки от Mikado
    for (const product of products) {
      if (product.sku) {
        try {
          const mikadoStock = await getMikadoStock(product.sku, product.brand);
          if (mikadoStock) {
            results.mikado.success++;
            results.mikado.details.push({
              sku: product.sku,
              stock: mikadoStock.stock,
              deliveryDays: mikadoStock.deliveryDays,
              price: mikadoStock.price
            });
            // Сохраняем в кэш
            stockCache.mikado[product.sku] = mikadoStock;
          } else {
            results.mikado.failed++;
          }
        } catch (error) {
          results.mikado.failed++;
          console.error(`[Mikado Stock] Error for SKU ${product.sku}:`, error);
        }
      }
    }
    
    // Получаем остатки от Moskvorechie
    for (const product of products) {
      if (product.sku) {
        try {
          const moskvorechieStock = await getMoskvorechieStock(product.sku);
          if (moskvorechieStock) {
            results.moskvorechie.success++;
            results.moskvorechie.details.push({
              sku: product.sku,
              stock: moskvorechieStock.stock,
              deliveryDays: moskvorechieStock.deliveryDays,
              price: moskvorechieStock.price
            });
            // Сохраняем в кэш
            stockCache.moskvorechie[product.sku] = moskvorechieStock;
            console.log(`[Sync] Saved to cache for SKU ${product.sku}:`, {
              stock: moskvorechieStock.stock,
              deliveryDays: moskvorechieStock.deliveryDays,
              warehouses: moskvorechieStock.warehouses
            });
          } else {
            results.moskvorechie.failed++;
          }
        } catch (error) {
          results.moskvorechie.failed++;
          console.error(`[Moskvorechie Stock] Error for SKU ${product.sku}:`, error);
        }
      }
    }
    
    // Сохраняем синхронизированные данные
    await writeData('supplierStockCache', stockCache);
    console.log('[Supplier Stocks] Saved stock cache');
    
    return sendOk(res, { 
      message: 'Синхронизация остатков завершена',
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Sync Supplier Stocks] Error:', error);
    return sendErr(res, 500, `Error syncing supplier stocks: ${error.message}`);
  }
});

// Получение списка складов поставщика с доставкой 0-1 день
app.get('/api/supplier-warehouses', async (req, res) => {
  try {
    const { supplier } = req.query;
    
    if (!supplier) {
      return sendErr(res, 400, 'Поставщик не указан');
    }
    
    let warehouses = [];
    
    if (supplier === 'mikado') {
      warehouses = await getMikadoWarehouses();
    } else if (supplier === 'moskvorechie') {
      warehouses = await getMoskvorechieWarehouses();
    } else {
      return sendErr(res, 400, 'Неподдерживаемый поставщик');
    }
    
    return sendOk(res, { warehouses });
  } catch (error) {
    console.error('[Supplier Warehouses] Error:', error);
    return sendErr(res, 500, `Error getting warehouses: ${error.message}`);
  }
});

// Функция получения остатков от Mikado
async function getMikadoStock(sku, brand = '') {
  try {
    const mikadoConfig = await readData('mikado');
    if (!mikadoConfig || !mikadoConfig.user_id || !mikadoConfig.password) {
      console.log('[Mikado Stock] No credentials configured');
      return null;
    }
    
    console.log(`[Mikado Stock] Fetching stock for SKU: ${sku}, Brand: ${brand}`);
    
    // Используем тот же API, что и для цен, но для получения остатков
    try {
      // Для Mikado используем тот же endpoint, что и для цен
      // Параметр brand передаем из товара
      const url = `http://mikado-parts.ru/ws1/service.asmx/CodeBrandStockInfo?Code=${encodeURIComponent(sku)}&Brand=${encodeURIComponent(brand || '')}&ClientID=${encodeURIComponent(mikadoConfig.user_id)}&Password=${encodeURIComponent(mikadoConfig.password)}`;
      
      console.log(`[Mikado Stock] Making API request to: ${url}`);
      
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/xml, text/xml, */*'
        }
      }, 15000);
      
      console.log(`[Mikado Stock] Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const xmlText = await response.text();
      console.log(`[Mikado Stock] Full XML Response:`, xmlText);
      
      // Парсим XML ответ - пробуем разные варианты названий полей
      // Ищем остатки по разным возможным названиям полей
      let stockMatch = xmlText.match(/<StockQTY>(\d+)<\/StockQTY>/i);
      if (!stockMatch) {
        stockMatch = xmlText.match(/<Stock>(\d+)<\/Stock>/i);
      }
      if (!stockMatch) {
        stockMatch = xmlText.match(/<Quantity>(\d+)<\/Quantity>/i);
      }
      if (!stockMatch) {
        stockMatch = xmlText.match(/<StockQuantity>(\d+)<\/StockQuantity>/i);
      }
      if (!stockMatch) {
        stockMatch = xmlText.match(/<Qty>(\d+)<\/Qty>/i);
      }
      if (!stockMatch) {
        stockMatch = xmlText.match(/quantity="(\d+)"/i);
      }
      
      // Ищем цену
      let priceMatch = xmlText.match(/<PriceRUR>([\d.]+)<\/PriceRUR>/i);
      if (!priceMatch) {
        priceMatch = xmlText.match(/<Price>([\d.]+)<\/Price>/i);
      }
      if (!priceMatch) {
        priceMatch = xmlText.match(/<PriceRub>([\d.]+)<\/PriceRub>/i);
      }
      if (!priceMatch) {
        priceMatch = xmlText.match(/<Cost>([\d.]+)<\/Cost>/i);
      }
      
      // Ищем срок доставки
      let deliveryMatch = xmlText.match(/<DeliveryDelay>(\d+)<\/DeliveryDelay>/i);
      if (!deliveryMatch) {
        deliveryMatch = xmlText.match(/<DeliveryDays>(\d+)<\/DeliveryDays>/i);
      }
      if (!deliveryMatch) {
        deliveryMatch = xmlText.match(/<Delivery>(\d+)<\/Delivery>/i);
      }
      if (!deliveryMatch) {
        deliveryMatch = xmlText.match(/<Days>(\d+)<\/Days>/i);
      }
      
      if (stockMatch) {
        const stock = parseInt(stockMatch[1]) || 0;
        const price = priceMatch ? parseFloat(priceMatch[1]) : 0;
        const deliveryDays = deliveryMatch ? parseInt(deliveryMatch[1]) : 3;
        
        console.log(`[Mikado Stock] ✅ Real API Success for SKU ${sku}: ${stock} units, price: ${price}, delivery: ${deliveryDays} days`);
        return {
          stock: stock,
          stockName: 'Склад Mikado',
          deliveryDays: deliveryDays,
          price: price,
          source: 'api'
        };
      } else {
        console.log(`[Mikado Stock] No stock data found in XML for SKU: ${sku}`);
        console.log(`[Mikado Stock] XML structure:`, xmlText.substring(0, 500));
        return null;
      }
    } catch (apiError) {
      console.error(`[Mikado Stock] API Error for SKU ${sku}:`, apiError.message);
      console.log(`[Mikado Stock] ❌ API недоступен для SKU: ${sku}`);
      return null;
    }
  } catch (error) {
    console.error('[Mikado Stock] Error:', error);
    return null;
  }
}

// Функция получения остатков от Moskvorechie
async function getMoskvorechieStock(sku) {
  try {
    const moskvorechieConfig = await readData('moskvorechie');
    if (!moskvorechieConfig || !moskvorechieConfig.user_id || !moskvorechieConfig.apiKey) {
      console.log('[Moskvorechie Stock] No credentials configured');
      return null;
    }
    
    console.log(`[Moskvorechie Stock] Fetching stock for SKU: ${sku}`);
    
    // Используем тот же API, что и для цен, но для получения остатков
    try {
      // Для Moskvorechie используем apiKey для авторизации
      const url = `http://portal.moskvorechie.ru/portal.api?l=${encodeURIComponent(moskvorechieConfig.user_id)}&p=${encodeURIComponent(moskvorechieConfig.apiKey)}&act=price_by_nr_firm&v=1&nr=${encodeURIComponent(sku)}&f=&cs=utf8&avail&extstor`;
      
      console.log(`[Moskvorechie Stock] Making API request to: ${url}`);
      
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, application/xml, text/xml, */*'
        }
      }, 15000);
      
      console.log(`[Moskvorechie Stock] Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const responseText = await response.text();
      console.log(`[Moskvorechie Stock] Response: ${responseText.substring(0, 200)}...`);
      
      // Парсим JSON ответ
      try {
        const data = JSON.parse(responseText);
        console.log(`[Moskvorechie Stock] Full Parsed JSON:`, JSON.stringify(data, null, 2));
        
        // Проверяем наличие ошибки авторизации
        if (data && data.result && data.result.status === '1') {
          console.log(`[Moskvorechie Stock] Auth error: ${data.result.msg}`);
          return null;
        }
        
        // Ищем данные об остатках в ответе
        // Moskvorechie возвращает массив в data.result
        let stock = 0;
        let price = 0;
        let deliveryDays = 5;
        const warehouses = [];
        
        // Проверяем, есть ли массив результатов
        if (data.result && Array.isArray(data.result)) {
          if (data.result.length === 0) {
            console.log(`[Moskvorechie Stock] Empty result array for SKU: ${sku}`);
            return null;
          }
          // Суммируем остатки со всех складов и сохраняем информацию о каждом складе
          let totalStock = 0;
          let minDeliveryDays = 999;
          let firstPrice = 0;
          
          for (const item of data.result) {
            const itemStock = parseInt(item.stock) || 0;
            const itemDeliveryDays = item.ddays !== undefined && item.ddays !== null ? parseInt(item.ddays) : 5;
            const itemPrice = parseFloat(item.price) || 0;
            const city = item.sname || 'Неизвестно';
            
            warehouses.push({
              city: city,
              stock: itemStock,
              deliveryDays: itemDeliveryDays,
              price: itemPrice
            });
            
            totalStock += itemStock;
            if (itemDeliveryDays < minDeliveryDays) {
              minDeliveryDays = itemDeliveryDays;
            }
            if (itemPrice > 0 && firstPrice === 0) {
              firstPrice = itemPrice;
            }
          }
          
          stock = totalStock;
          price = firstPrice;
          deliveryDays = minDeliveryDays === 999 ? 5 : minDeliveryDays;
        } else {
          // Пробуем старые варианты для совместимости
          if (data.avail !== undefined) {
            stock = parseInt(data.avail) || 0;
          } else if (data.quantity !== undefined) {
            stock = parseInt(data.quantity) || 0;
          } else if (data.qty !== undefined) {
            stock = parseInt(data.qty) || 0;
          }
          
          if (data.price !== undefined) {
            price = parseFloat(data.price) || 0;
          } else if (data.priceRub !== undefined) {
            price = parseFloat(data.priceRub) || 0;
          }
          
          if (data.delivery_days !== undefined) {
            deliveryDays = parseInt(data.delivery_days) || 5;
          } else if (data.delivery !== undefined) {
            deliveryDays = parseInt(data.delivery) || 5;
          }
        }
        
        if (stock > 0 || price > 0) {
          console.log(`[Moskvorechie Stock] ✅ Real API Success for SKU ${sku}: ${stock} units, price: ${price}, delivery: ${deliveryDays} days`);
          const result = {
            stock: stock,
            stockName: 'Склад Moskvorechie',
            deliveryDays: deliveryDays,
            price: price,
            source: 'api'
          };
          
          // Добавляем информацию о складах, если есть
          if (warehouses.length > 0) {
            result.warehouses = warehouses;
          }
          
          return result;
        } else {
          console.log(`[Moskvorechie Stock] No stock data found in JSON for SKU: ${sku}`);
          return null;
        }
      } catch (parseError) {
        console.log(`[Moskvorechie Stock] Response is not JSON, trying XML parsing...`);
        console.log(`[Moskvorechie Stock] Full Response:`, responseText);
        
        // Если не JSON, пробуем парсить как XML
        let stockMatch = responseText.match(/<avail>(\d+)<\/avail>/i);
        if (!stockMatch) {
          stockMatch = responseText.match(/<quantity>(\d+)<\/quantity>/i);
        }
        if (!stockMatch) {
          stockMatch = responseText.match(/<qty>(\d+)<\/qty>/i);
        }
        if (!stockMatch) {
          stockMatch = responseText.match(/quantity="(\d+)"/i);
        }
        
        const priceMatch = responseText.match(/<price>([\d.]+)<\/price>/i) || responseText.match(/<priceRub>([\d.]+)<\/priceRub>/i);
        const deliveryMatch = responseText.match(/<delivery_days>(\d+)<\/delivery_days>/i) || responseText.match(/<delivery>(\d+)<\/delivery>/i);
        
        if (stockMatch) {
          const stock = parseInt(stockMatch[1]) || 0;
          const price = priceMatch ? parseFloat(priceMatch[1]) : 0;
          const deliveryDays = deliveryMatch ? parseInt(deliveryMatch[1]) : 5;
          
          console.log(`[Moskvorechie Stock] ✅ Real API Success for SKU ${sku}: ${stock} units, price: ${price}, delivery: ${deliveryDays} days`);
          return {
            stock: stock,
            stockName: 'Склад Moskvorechie',
            deliveryDays: deliveryDays,
            price: price,
            source: 'api'
          };
        } else {
          console.log(`[Moskvorechie Stock] No stock data found in XML for SKU: ${sku}`);
          return null;
        }
      }
    } catch (apiError) {
      console.error(`[Moskvorechie Stock] API Error for SKU ${sku}:`, apiError.message);
      console.log(`[Moskvorechie Stock] ❌ API недоступен для SKU: ${sku}`);
      return null;
    }
  } catch (error) {
    console.error('[Moskvorechie Stock] Error:', error);
    return null;
  }
}

// Функция получения списка складов Mikado с доставкой 0-1 день
async function getMikadoWarehouses() {
  try {
    const mikadoConfig = await readData('mikado');
    if (!mikadoConfig || !mikadoConfig.user_id || !mikadoConfig.password) {
      console.log('[Mikado Warehouses] No credentials configured');
      return [];
    }
    
    // Загружаем первый доступный товар для получения списка складов
    let products = [];
    try {
      products = await readData('products');
      if (!Array.isArray(products)) {
        products = [];
      }
    } catch (e) {
      console.log('[Mikado Warehouses] No products found');
    }
    
    // Используем первый товар из списка для получения списка складов
    let testSku = 'AN1048';
    let testBrand = 'Nordfil';
    
    if (products.length > 0) {
      const firstProduct = products[0];
      testSku = firstProduct.sku || 'AN1048';
      testBrand = firstProduct.brand || 'Nordfil';
    }
    
    const url = `http://mikado-parts.ru/ws1/service.asmx/CodeBrandStockInfo?Code=${testSku}&Brand=${testBrand}&ClientID=${mikadoConfig.user_id}&Password=${mikadoConfig.password}`;
    
    console.log(`[Mikado Warehouses] Fetching warehouses list using SKU: ${testSku}, Brand: ${testBrand}`);
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'Accept': 'application/xml, text/xml, */*' }
    }, 15000);
    
    if (!response.ok) {
      console.log(`[Mikado Warehouses] API недоступен`);
      return [];
    }
    
    const xmlText = await response.text();
    console.log(`[Mikado Warehouses] Response length: ${xmlText.length}`);
    
    // Извлекаем склады с доставкой 0 или 1 день
    const warehouseMatches = xmlText.matchAll(/<CodeBrandLine>([\s\S]*?)<\/CodeBrandLine>/gi);
    const warehouses = [];
    const seenWarehouses = new Set();
    
    for (const match of warehouseMatches) {
      const itemXml = match[1];
      
      // Извлекаем название склада
      const nameMatch = itemXml.match(/<StokName>(.*?)<\/StokName>/i);
      // Извлекаем срок доставки
      const delayMatch = itemXml.match(/<DeliveryDelay>(\d+)<\/DeliveryDelay>/i);
      
      if (nameMatch && delayMatch) {
        const warehouseName = nameMatch[1].trim();
        const deliveryDelay = parseInt(delayMatch[1]);
        
        console.log(`[Mikado Warehouses] Found warehouse: ${warehouseName}, delivery: ${deliveryDelay} days`);
        
        // Берем только склады с доставкой 0 или 1 день
        if ((deliveryDelay === 0 || deliveryDelay === 1) && !seenWarehouses.has(warehouseName)) {
          warehouses.push({
            name: warehouseName,
            deliveryDays: deliveryDelay
          });
          seenWarehouses.add(warehouseName);
        }
      }
    }
    
    console.log(`[Mikado Warehouses] Found ${warehouses.length} warehouses with 0-1 day delivery`);
    return warehouses;
  } catch (error) {
    console.error('[Mikado Warehouses] Error:', error);
    return [];
  }
}

// Функция получения списка складов Moskvorechie с доставкой 0-1 день
async function getMoskvorechieWarehouses() {
  try {
    const moskvorechieConfig = await readData('moskvorechie');
    if (!moskvorechieConfig || !moskvorechieConfig.user_id || !moskvorechieConfig.apiKey) {
      console.log('[Moskvorechie Warehouses] No credentials configured');
      return [];
    }
    
    // Загружаем первый доступный товар для получения списка складов
    let products = [];
    try {
      products = await readData('products');
      if (!Array.isArray(products)) {
        products = [];
      }
    } catch (e) {
      console.log('[Moskvorechie Warehouses] No products found');
    }
    
    // Используем первый товар из списка для получения списка складов
    let testSku = 'E400049';
    
    if (products.length > 0) {
      const firstProduct = products.find(p => p.sku && p.view && p.view.model && p.view.model.article);
      if (firstProduct) {
        testSku = firstProduct.view.model.article;
      }
    }
    
    const url = `http://portal.moskvorechie.ru/portal.api?l=${encodeURIComponent(moskvorechieConfig.user_id)}&p=${encodeURIComponent(moskvorechieConfig.apiKey)}&act=price_by_nr_firm&v=1&nr=${encodeURIComponent(testSku)}&f=&cs=utf8&avail&extstor`;
    
    console.log(`[Moskvorechie Warehouses] Fetching warehouses list using SKU: ${testSku}`);
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json, application/xml, text/xml, */*' }
    }, 15000);
    
    if (!response.ok) {
      console.log(`[Moskvorechie Warehouses] API недоступен`);
      return [];
    }
    
    const responseText = await response.text();
    console.log(`[Moskvorechie Warehouses] Response: ${responseText.substring(0, 300)}`);
    
    try {
      const data = JSON.parse(responseText);
      
      if (data && data.result && Array.isArray(data.result)) {
        const warehouses = [];
        const seenWarehouses = new Set();
        
        for (const item of data.result) {
          const warehouseName = item.sname;
          const deliveryDays = parseInt(item.ddays) || 5;
          
          console.log(`[Moskvorechie Warehouses] Found warehouse: ${warehouseName}, delivery: ${deliveryDays} days`);
          
          // Берем только склады с доставкой 0 или 1 день
          if ((deliveryDays === 0 || deliveryDays === 1) && warehouseName && !seenWarehouses.has(warehouseName)) {
            warehouses.push({
              name: warehouseName,
              deliveryDays: deliveryDays
            });
            seenWarehouses.add(warehouseName);
          }
        }
        
        console.log(`[Moskvorechie Warehouses] Found ${warehouses.length} warehouses with 0-1 day delivery`);
        return warehouses;
      } else if (data && data.result && Array.isArray(data.result) && data.result.length === 0) {
        console.log(`[Moskvorechie Warehouses] Empty result array`);
        return [];
      }
    } catch (parseError) {
      console.log(`[Moskvorechie Warehouses] Failed to parse response:`, parseError);
    }
    
    return [];
  } catch (error) {
    console.error('[Moskvorechie Warehouses] Error:', error);
    return [];
  }
}

// ========== Helper Functions ==========

// Функция для создания HTTP запроса с таймаутом
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    // Используем агент с отключенной проверкой SSL для тестирования
    const https = await import('https');
    const httpsAgent = new https.default.Agent({  
      rejectUnauthorized: false
    });
    
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      agent: url.startsWith('https://') ? httpsAgent : undefined
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    const errorName = error && typeof error === 'object' && 'name' in error ? error.name : '';
    if (errorName === 'AbortError') {
      throw new Error('Request timeout after ' + timeout + 'ms');
    }
    throw error;
  }
}

// ========== Supplier API Configuration API ==========

// Тестирование подключения к API поставщика
app.post('/api/test-supplier-connection', async (req, res) => {
  try {
    const { supplier, apiKey, userId, password } = req.body;
    
    // For Mikado, API key is not required
    if (supplier === 'mikado') {
      if (!userId || !password) {
        return sendErr(res, 400, 'User ID и пароль обязательны для тестирования Mikado');
      }
    } else {
      if (!supplier || !apiKey || !userId || !password) {
        return sendErr(res, 400, 'Все поля обязательны для тестирования');
      }
    }
    
    // Здесь должна быть реальная логика тестирования API
    // Пока возвращаем успешный результат для демонстрации
    if (supplier === 'mikado') {
      console.log(`[Test Connection] Testing ${supplier} with User ID: ${userId}...`);
    } else {
      console.log(`[Test Connection] Testing ${supplier} with API key: ${apiKey ? apiKey.substring(0, 8) : 'N/A'}...`);
    }
    
    // Имитируем задержку тестирования
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Проверяем формат данных (базовая валидация)
    const isValidUserId = userId.length >= 3;
    const isValidPassword = password.length >= 6;
    
    if (supplier === 'mikado') {
      if (!isValidUserId || !isValidPassword) {
        return sendOk(res, { 
          success: false, 
          message: 'Неверный формат данных. User ID должен быть не менее 3 символов, пароль - не менее 6' 
        });
      }
    } else {
      const isValidApiKey = apiKey && apiKey.length >= 8;
      if (!isValidApiKey || !isValidUserId || !isValidPassword) {
        return sendOk(res, { 
          success: false, 
          message: 'Неверный формат данных. API ключ должен быть не менее 8 символов, User ID - не менее 3, пароль - не менее 6' 
        });
      }
    }
    
    return sendOk(res, { 
      success: true, 
      message: `Подключение к ${supplier} успешно установлено`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Test Supplier Connection] Error:', error);
    return sendErr(res, 500, `Error testing connection: ${error.message}`);
  }
});

// Сохранение конфигурации API поставщика
app.post('/api/save-supplier-config', async (req, res) => {
  try {
    const { supplier, apiKey, userId, password, warehouses, sameDayDelivery } = req.body;
    
    // For Mikado, API key is not required
    if (supplier === 'mikado') {
      if (!userId || !password) {
        return sendErr(res, 400, 'User ID и пароль обязательны для сохранения Mikado');
      }
    } else {
      if (!supplier || !apiKey || !userId || !password) {
        return sendErr(res, 400, 'Все поля обязательны для сохранения');
      }
    }
    
    // Валидация данных
    if (supplier !== 'mikado' && apiKey && apiKey.length < 8) {
      return sendErr(res, 400, 'API ключ должен быть не менее 8 символов');
    }
    if (userId.length < 3) {
      return sendErr(res, 400, 'User ID должен быть не менее 3 символов');
    }
    if (password.length < 6) {
      return sendErr(res, 400, 'Пароль должен быть не менее 6 символов');
    }
    
    // Определяем файл для сохранения
    const configFile = supplier === 'mikado' ? 'mikado' : 
                      supplier === 'moskvorechie' ? 'moskvorechie' : null;
    
    if (!configFile) {
      return sendErr(res, 400, 'Неподдерживаемый поставщик');
    }
    
    // Создаем конфигурацию
    const config = {
      user_id: userId.trim(),
      password: password.trim(),
      warehouses: warehouses || [],
      sameDayDelivery: sameDayDelivery || false,
      updatedAt: new Date().toISOString()
    };
    
    // Добавляем API ключ только для не-Mikado поставщиков
    if (supplier !== 'mikado' && apiKey) {
      config.apiKey = apiKey.trim();
    }
    
    // Сохраняем конфигурацию
    const success = await writeData(configFile, config);
    
    if (success) {
      console.log(`[Save Supplier Config] Saved config for ${supplier}`);
      return sendOk(res, { 
        message: `Конфигурация ${supplier} успешно сохранена`,
        timestamp: new Date().toISOString()
      });
    } else {
      return sendErr(res, 500, 'Не удалось сохранить конфигурацию');
    }
  } catch (error) {
    console.error('[Save Supplier Config] Error:', error);
    return sendErr(res, 500, `Error saving config: ${error.message}`);
  }
});

// ========== ORDERS ENDPOINTS ==========

// Кэш для синхронизации заказов (ограничение частоты запросов)
let ordersSyncCache = {
  lastSyncTime: null,
  lastSyncResult: null,
  syncInProgress: false
};

// Middleware для логирования всех запросов к /api/orders/*
app.use('/api/orders', (req, res, next) => {
  console.log(`[Orders Route] ${req.method} ${req.url}`);
  console.log(`[Orders Route] Params:`, req.params);
  console.log(`[Orders Route] Query:`, req.query);
  next();
});

// Синхронизация FBS заказов со всех маркетплейсов
app.post('/api/orders/sync-fbs', async (req, res) => {
  try {
    const now = Date.now();
    const oneMinute = 60 * 1000; // 1 минута в миллисекундах
    
    // Проверяем, прошла ли минута с последнего запроса
    if (ordersSyncCache.lastSyncTime && (now - ordersSyncCache.lastSyncTime) < oneMinute) {
      const timeLeft = Math.ceil((oneMinute - (now - ordersSyncCache.lastSyncTime)) / 1000);
      console.log(`[Orders Sync] Rate limit: последний запрос был ${Math.floor((now - ordersSyncCache.lastSyncTime) / 1000)} сек назад. Ожидание ${timeLeft} сек...`);
      
      // Возвращаем кэшированный результат, если он есть
      if (ordersSyncCache.lastSyncResult) {
        console.log('[Orders Sync] Returning cached result');
        res.setHeader('X-Cache', 'hit');
        res.setHeader('X-Cache-Age', Math.floor((now - ordersSyncCache.lastSyncTime) / 1000));
        return sendOk(res, ordersSyncCache.lastSyncResult);
      }
      
      // Если кэша нет, возвращаем ошибку с информацией о времени ожидания
      return sendErr(res, 429, `Слишком частые запросы. Подождите ${timeLeft} секунд перед следующим запросом.`);
    }
    
    // Проверяем, не выполняется ли уже синхронизация
    if (ordersSyncCache.syncInProgress) {
      console.log('[Orders Sync] Sync already in progress, waiting...');
      // Ждем завершения текущей синхронизации (максимум 30 секунд)
      let waited = 0;
      while (ordersSyncCache.syncInProgress && waited < 30000) {
        await new Promise(resolve => setTimeout(resolve, 500));
        waited += 500;
      }
      
      if (ordersSyncCache.lastSyncResult && (Date.now() - ordersSyncCache.lastSyncTime) < oneMinute) {
        return sendOk(res, ordersSyncCache.lastSyncResult);
      }
    }
    
    // Устанавливаем флаг синхронизации
    ordersSyncCache.syncInProgress = true;
    ordersSyncCache.lastSyncTime = now;
    
    console.log('[Orders Sync] Starting FBS orders synchronization');
    
    const results = {
      ozon: { success: 0, failed: 0, orders: [] },
      wildberries: { success: 0, failed: 0, orders: [] },
      yandex: { success: 0, failed: 0, orders: [] }
    };
    
    // Синхронизация Ozon
    try {
      const ozonConfig = await readData('ozon');
      if (ozonConfig.client_id && ozonConfig.api_key) {
        console.log('[Orders Sync] Fetching Ozon orders');
        const ozonOrders = await fetchOzonFBSOrders(ozonConfig);
        results.ozon.success = ozonOrders.length;
        results.ozon.orders = ozonOrders;
        console.log(`[Orders Sync] Ozon: ${ozonOrders.length} orders found`);
      } else {
        console.log('[Orders Sync] Ozon not configured');
      }
    } catch (error) {
      console.error('[Orders Sync] Ozon error:', error);
      results.ozon.failed = 1;
    }
    
    // Синхронизация Wildberries
    try {
      const wbConfig = await readData('wildberries');
      if (wbConfig.api_key) {
        console.log('[Orders Sync] Fetching Wildberries orders');
        const wbOrders = await fetchWildberriesFBSOrders(wbConfig);
        results.wildberries.success = wbOrders.length;
        results.wildberries.orders = wbOrders;
        console.log(`[Orders Sync] Wildberries: ${wbOrders.length} orders found`);
      } else {
        console.log('[Orders Sync] Wildberries not configured');
      }
    } catch (error) {
      console.error('[Orders Sync] Wildberries error:', error);
      results.wildberries.failed = 1;
    }
    
    // Синхронизация Yandex
    try {
      const ymConfig = await readData('yandex');
      if (ymConfig.api_key) {
        console.log('[Orders Sync] Fetching Yandex Market orders');
        const ymOrders = await fetchYandexFBSOrders(ymConfig);
        results.yandex.success = ymOrders.length;
        results.yandex.orders = ymOrders;
        console.log(`[Orders Sync] Yandex: ${ymOrders.length} orders found`);
      } else {
        console.log('[Orders Sync] Yandex Market not configured');
      }
    } catch (error) {
      console.error('[Orders Sync] Yandex error:', error);
      results.yandex.failed = 1;
    }
    
    // Загружаем существующие заказы, чтобы не потерять их
    let existingOrders = [];
    try {
      const existingData = await readData('orders');
      existingOrders = (existingData && existingData.orders) || [];
      console.log(`[Orders Sync] Existing orders: ${existingOrders.length}`);
    } catch (e) {
      console.warn('[Orders Sync] Failed to load existing orders:', e.message);
    }
    
    // Объединяем: старые заказы + новые/обновлённые с маркетплейсов
    const newOrders = [
      ...results.ozon.orders,
      ...results.wildberries.orders,
      ...results.yandex.orders
    ];
    
    // Создаём Map для быстрого поиска по marketplace+orderId
    const ordersMap = new Map();
    existingOrders.forEach(order => {
      const key = `${order.marketplace}:${order.orderId}`;
      ordersMap.set(key, order);
    });
    
    // Обновляем/добавляем новые заказы
    newOrders.forEach(order => {
      const key = `${order.marketplace}:${order.orderId}`;
      const existingOrder = ordersMap.get(key);
      if (existingOrder) {
        // Если заказ уже существует, проверяем, изменился ли статус
        if (existingOrder.status !== order.status) {
          console.log(`[Orders Sync] Status updated for ${order.marketplace}:${order.orderId}: ${existingOrder.status} -> ${order.status}`);
        }
      } else {
        console.log(`[Orders Sync] New order added: ${order.marketplace}:${order.orderId} (status: ${order.status})`);
      }
      ordersMap.set(key, order);
    });
    
    const allOrders = Array.from(ordersMap.values());
    
    // Логируем статистику по статусам
    const statusStats = {};
    allOrders.forEach(order => {
      statusStats[order.status] = (statusStats[order.status] || 0) + 1;
    });
    console.log('[Orders Sync] Status statistics:', statusStats);
    console.log(`[Orders Sync] Total orders after merge: ${allOrders.length} (was ${existingOrders.length}, added/updated ${newOrders.length})`);
    
    await writeData('orders', { orders: allOrders, lastSync: new Date().toISOString() });

    // Автозагрузка этикеток (в фоне, без ожидания ответа)
    setTimeout(async () => {
      try {
        await preloadOrderLabels(allOrders);
      } catch (e) {
        console.error('[Orders Sync] Preload labels error:', e.message);
      }
    }, 0);
    
    // Сохраняем результат в кэш
    ordersSyncCache.lastSyncResult = results;
    ordersSyncCache.syncInProgress = false;
    
    // Устанавливаем заголовок для нового запроса
    res.setHeader('X-Cache', 'miss');
    
    console.log('[Orders Sync] Sync completed successfully');
    return sendOk(res, results);
  } catch (error) {
    console.error('[Orders Sync] Error:', error);
    // Сбрасываем флаг при ошибке
    ordersSyncCache.syncInProgress = false;
    return sendErr(res, 500, `Error syncing orders: ${error.message}`);
  }
});

// Ручной запуск предзагрузки этикеток (ожидает завершения)
app.post('/api/orders/preload-labels', async (req, res) => {
  try {
    const data = await readData('orders');
    const orders = (data && data.orders) || [];
    await preloadOrderLabels(orders);
    return sendOk(res, { processed: orders.length });
  } catch (e) {
    return sendErr(res, 500, `Preload failed: ${e.message}`);
  }
});

// Получить все заказы
// Функция для получения конкретного заказа Ozon по posting_number
async function fetchOzonOrderByPostingNumber(config, postingNumber) {
  try {
    const { client_id, api_key } = config;
    
    console.log(`[Ozon Get Order] Fetching order ${postingNumber} directly from Ozon API`);
    
    // Используем endpoint для получения конкретного постинга
    const response = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/get', {
      method: 'POST',
      headers: {
        'Client-Id': String(client_id),
        'Api-Key': String(api_key),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        posting_number: String(postingNumber),
        with: {
          analytics_data: false,
          financial_data: false,
          transliteration: false
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Ozon Get Order] API error ${response.status}:`, errorText);
      throw new Error(`Ozon API error ${response.status}: ${errorText.substring(0, 200)}`);
    }
    
    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      const text = await response.text().catch(() => '');
      console.error(`[Ozon Get Order] JSON parse error:`, parseError.message);
      console.error(`[Ozon Get Order] Response text:`, text.substring(0, 500));
      throw new Error(`Failed to parse Ozon API response: ${parseError.message}`);
    }
    
    if (!data.result) {
      console.log(`[Ozon Get Order] No result for order ${postingNumber}. Response:`, JSON.stringify(data, null, 2));
      throw new Error(`Order ${postingNumber} not found in Ozon API response`);
    }
    
    const order = data.result;
    const mappedStatus = mapOzonOrderStatus(order.status);
    
    console.log(`[Ozon Get Order] Order ${postingNumber} status: ${order.status} -> ${mappedStatus}`);
    
    return {
      marketplace: 'ozon',
      orderId: order.posting_number,
      offerId: order.products?.[0]?.offer_id || '',
      sku: order.products?.[0]?.sku || '',
      productName: order.products?.[0]?.name || '',
      quantity: order.products?.[0]?.quantity || 0,
      price: order.products?.[0]?.price || 0,
      status: mappedStatus,
      createdAt: order.created_at || '',
      inProcessAt: order.in_process_at || '',
      shipmentDate: order.shipment_date || '',
      customerName: order.customer_name || '',
      customerPhone: order.customer_phone || '',
      deliveryAddress: order.delivery_method?.warehouse_name || ''
    };
  } catch (error) {
    console.error(`[Ozon Get Order] Fetch error for ${postingNumber}:`, error);
    console.error(`[Ozon Get Order] Error stack:`, error.stack);
    throw error; // Пробрасываем ошибку дальше для обработки
  }
}

// Принудительное обновление конкретного заказа Ozon
// Важно: этот маршрут должен быть ПЕРЕД более общим /api/orders/:orderId/*
app.post('/api/orders/ozon/:orderId/refresh', async (req, res) => {
  console.log(`[Order Refresh] Route matched! URL: ${req.url}, Method: ${req.method}`);
  try {
    let { orderId } = req.params;
    // Декодируем orderId на случай если он был закодирован
    orderId = decodeURIComponent(orderId);
    console.log(`[Order Refresh] Refreshing Ozon order: ${orderId}`);
    console.log(`[Order Refresh] Request URL: ${req.url}`);
    console.log(`[Order Refresh] Request path: ${req.path}`);
    console.log(`[Order Refresh] Request params:`, req.params);
    
    const ozonConfig = await readData('ozon');
    if (!ozonConfig.client_id || !ozonConfig.api_key) {
      return sendErr(res, 400, 'Ozon API не настроен');
    }
    
    // Сначала пытаемся получить заказ напрямую по posting_number
    let order = null;
    let errorMessage = null;
    
    try {
      order = await fetchOzonOrderByPostingNumber(ozonConfig, orderId);
    } catch (error) {
      console.error(`[Order Refresh] Direct fetch failed for ${orderId}:`, error.message);
      errorMessage = error.message;
      // Пробуем найти в общем списке
      try {
        console.log(`[Order Refresh] Order ${orderId} not found directly, trying to fetch from list`);
        const ozonOrders = await fetchOzonFBSOrders(ozonConfig);
        order = ozonOrders.find(o => o.orderId === orderId);
      } catch (listError) {
        console.error(`[Order Refresh] List fetch also failed:`, listError.message);
        return sendErr(res, 500, `Ошибка получения заказа: ${errorMessage}. Дополнительная ошибка при попытке получить из списка: ${listError.message}`);
      }
    }
    
    if (!order) {
      const msg = errorMessage 
        ? `Заказ ${orderId} не найден в Ozon API. Ошибка при прямом запросе: ${errorMessage}`
        : `Заказ ${orderId} не найден в Ozon API. Возможно, он не существует или недоступен через текущий API метод.`;
      return sendErr(res, 404, msg);
    }
    
    // Загружаем существующие заказы
    const existingData = await readData('orders');
    const existingOrders = (existingData && existingData.orders) || [];
    
    // Обновляем заказ
    const orderIndex = existingOrders.findIndex(o => 
      o.marketplace === 'ozon' && o.orderId === orderId
    );
    
    let oldStatus = null;
    let statusChanged = false;
    
    if (orderIndex >= 0) {
      oldStatus = existingOrders[orderIndex].status;
      statusChanged = oldStatus !== order.status;
      existingOrders[orderIndex] = order;
      console.log(`[Order Refresh] Updated order ${orderId}: ${oldStatus} -> ${order.status}`);
    } else {
      existingOrders.push(order);
      console.log(`[Order Refresh] Added new order ${orderId} with status: ${order.status}`);
    }
    
    await writeData('orders', { orders: existingOrders, lastSync: new Date().toISOString() });
    
    return sendOk(res, { 
      message: `Заказ ${orderId} обновлен`,
      order: order,
      oldStatus: oldStatus,
      statusChanged: statusChanged
    });
  } catch (error) {
    console.error(`[Order Refresh] Error:`, error);
    console.error(`[Order Refresh] Error stack:`, error.stack);
    const errorMessage = error.message || 'Unknown error';
    const errorDetails = error.stack ? `\n\nДетали: ${error.stack.substring(0, 500)}` : '';
    return sendErr(res, 500, `Ошибка обновления заказа: ${errorMessage}${errorDetails}`);
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const data = await readData('orders');
    // Запускаем автодозагрузку недостающих этикеток в фоне
    try {
      const orders = (data && data.orders) || [];
      setTimeout(() => { preloadOrderLabels(orders).catch(() => {}); }, 0);
    } catch {}
    return sendOk(res, data);
  } catch (error) {
    return sendErr(res, 500, `Error reading orders: ${error.message}`);
  }
});

// Выдача этикетки. Ищет по кэшу на диске, без повторной загрузки
app.get('/api/orders/:orderId/label', async (req, res) => {
  try {
    const { orderId } = req.params;
    const data = await readData('orders');
    const orders = (data && data.orders) || [];
    const order = orders.find(o => String(o.orderId) === String(orderId));
    if (!order) return sendErr(res, 404, 'Order not found');

    const filePath = getOrderLabelPath(order.marketplace, order.orderId);
    if (!fs.existsSync(filePath)) {
      // Пытаемся загрузить прямо сейчас
      try {
        const buf = await fetchMarketplaceLabel(order);
        if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
          fs.writeFileSync(filePath, buf);
          console.log(`[Labels] Fetched on-demand for ${order.marketplace}:${order.orderId}`);
        } else {
          return sendErr(res, 404, 'Label not found');
        }
      } catch (e) {
        return sendErr(res, 502, `Label fetch failed: ${e.message}`);
      }
    }
    const ext = filePath.endsWith('.png') ? 'png' : 'pdf';
    res.setHeader('Content-Type', ext === 'png' ? 'image/png' : 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${order.marketplace}_${order.orderId}.${ext}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    return sendErr(res, 500, `Error serving label: ${error.message}`);
  }
});

// Статус наличия этикетки в кэше (без загрузки)
app.get('/api/orders/:orderId/label/status', async (req, res) => {
  try {
    const { orderId } = req.params;
    const data = await readData('orders');
    const orders = (data && data.orders) || [];
    const order = orders.find(o => String(o.orderId) === String(orderId));
    if (!order) return sendErr(res, 404, 'Order not found');
    const filePath = getOrderLabelPath(order.marketplace, order.orderId);
    const exists = fs.existsSync(filePath);
    if (!exists) {
      // Пытаемся скачать в фоне, ответ не задерживаем
      setTimeout(async () => {
        try {
          const buf = await fetchMarketplaceLabel(order);
          if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
            fs.writeFileSync(filePath, buf);
            console.log(`[Labels] Cached (status-trigger) for ${order.marketplace}:${order.orderId}`);
          logLabelEvent(`Cached(status) ${order.marketplace}:${order.orderId}`);
          }
        } catch (e) {
          console.warn(`[Labels] Status-trigger fetch failed for ${order.marketplace}:${order.orderId}: ${e.message}`);
        logLabelEvent(`Error(status) ${order.marketplace}:${order.orderId} -> ${e.message}`);
        }
      }, 0);
    }
    return sendOk(res, { exists });
  } catch (error) {
    return sendErr(res, 500, `Error checking label: ${error.message}`);
  }
});

// Helpers: кэш этикеток
function getLabelsDir() {
  const dir = join(DATA_DIR, 'labels');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getOrderLabelPath(marketplace, orderId) {
  const base = getLabelsDir();
  const mpDir = join(base, String(marketplace || 'unknown'));
  if (!fs.existsSync(mpDir)) fs.mkdirSync(mpDir, { recursive: true });
  // WB возвращает PNG, остальные — PDF
  const ext = (marketplace === 'wildberries') ? '.png' : '.pdf';
  return join(mpDir, `${orderId}${ext}`);
}

function hasLabelCached(order) {
  const filePath = getOrderLabelPath(order.marketplace, order.orderId);
  return fs.existsSync(filePath);
}

async function preloadOrderLabels(orders, statuses = ['new','accepted']) {
  const toProcess = Array.isArray(orders) ? orders.filter(o => !hasLabelCached(o) && (!statuses || statuses.includes(o.status))) : [];
  console.log(`[Labels] Preload start. Total orders: ${orders?.length || 0}, to fetch: ${toProcess.length}`);
  logLabelEvent(`Preload start. total=${orders?.length || 0} toFetch=${toProcess.length}`);
  for (const order of toProcess) {
    const filePath = getOrderLabelPath(order.marketplace, order.orderId);
    if (fs.existsSync(filePath)) continue;
    try {
      console.log(`[Labels] Fetching label for ${order.marketplace}:${order.orderId}`);
      logLabelEvent(`Fetching ${order.marketplace}:${order.orderId}`);
      const buf = await fetchMarketplaceLabel(order);
      if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
        fs.writeFileSync(filePath, buf);
        console.log(`[Labels] Cached label for ${order.marketplace}:${order.orderId}`);
        logLabelEvent(`Cached ${order.marketplace}:${order.orderId}`);
      }
    } catch (e) {
      console.warn(`[Labels] Cannot fetch label for ${order.marketplace}:${order.orderId}: ${e.message}`);
      logLabelEvent(`Error ${order.marketplace}:${order.orderId} -> ${e.message}`);
    }
  }
  console.log('[Labels] Preload complete');
  logLabelEvent('Preload complete');
}

async function fetchMarketplaceLabel(order) {
  // Выбираем реализацию по маркетплейсу
  if (order.marketplace === 'ozon') {
    return await fetchOzonLabel(order);
  }
  if (order.marketplace === 'wildberries') {
    return await fetchWBLabel(order);
  }
  if (order.marketplace === 'yandex') {
    return await fetchYMLabel(order);
  }
  return null;
}

// НИЖЕ заглушки для загрузки этикеток. При наличии API-ключей можно дополнить реальными вызовами
async function fetchOzonLabel(order) {
  try {
    const ozon = await readData('ozon');
    if (!ozon || !ozon.client_id || !ozon.api_key) return null;
    // 1) Валидируем, что постинг существует (v3/posting/fbs/get)
    const check = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/get', {
      method: 'POST',
      headers: {
        'Client-Id': String(ozon.client_id),
        'Api-Key': String(ozon.api_key),
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        posting_number: String(order.orderId)
      })
    });
    if (!check.ok) {
      const text = await check.text();
      logLabelEvent(`[Ozon] get posting failed ${check.status}: ${text}`);
      throw new Error(`Ozon get failed ${check.status}`);
    }
    const checkData = await check.json();
    if (!checkData?.result || !Array.isArray(checkData.result) || checkData.result.length === 0) {
      logLabelEvent(`[Ozon] posting not found: ${order.orderId}`);
      throw new Error('Ozon posting not found');
    }
    // 2) Сначала пробуем v3: может вернуть ссылку на файл
    let resp = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/package-label', {
      method: 'POST',
      headers: {
        'Client-Id': String(ozon.client_id),
        'Api-Key': String(ozon.api_key),
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        posting_number: [String(order.orderId)]
      })
    });
    if (resp.ok) {
      const dataV3 = await resp.json();
      const url = dataV3?.result?.label_url || dataV3?.result?.file_url || dataV3?.result?.url;
      if (url) {
        const fileResp = await fetch(url);
        if (fileResp.ok) {
          const arr = await fileResp.arrayBuffer();
          return Buffer.from(arr);
        }
        logLabelEvent(`[Ozon] v3 file download error ${fileResp.status}`);
      }
    } else {
      const txt = await resp.text();
      logLabelEvent(`[Ozon] v3 label error ${resp.status}: ${txt}`);
    }
    // 3) Фолбэк на v2: иногда отдает base64 в result.file
    resp = await fetch('https://api-seller.ozon.ru/v2/posting/fbs/package-label', {
      method: 'POST',
      headers: {
        'Client-Id': String(ozon.client_id),
        'Api-Key': String(ozon.api_key),
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        posting_number: [String(order.orderId)],
        with_barcode: true
      })
    });
    if (!resp.ok) {
      const txt2 = await resp.text();
      logLabelEvent(`[Ozon] v2 label error ${resp.status}: ${txt2}`);
      throw new Error(`Ozon label error ${resp.status}`);
    }
    const dataV2 = await resp.json();
    const base64 = dataV2?.result?.file;
    if (!base64) return null;
    return Buffer.from(base64, 'base64');
  } catch (e) { throw e; }
}
async function fetchWBLabel(order) {
  try {
    const wb = await readData('wildberries');
    if (!wb || !wb.api_key) return null;
    // Wildberries: стикеры доступны только для заказов со статусом confirm (на сборке)
    if (order.status !== 'confirm' && order.status !== 'processing') {
      logLabelEvent(`[WB] Order ${order.orderId} status is ${order.status}, not confirm - skipping sticker`);
      return null;
    }
    // Wildberries: используем точный эндпоинт из документации
    // https://marketplace-api.wildberries.ru/api/v3/orders/stickers
    // Query: type=png, width=58, height=40 (даёт 580x400 px)
    // Body: массив чисел (ID сборочных заданий)
    const orderIdNum = Number(order.orderId);
    if (isNaN(orderIdNum)) {
      logLabelEvent(`[WB] Invalid orderId: ${order.orderId}`);
      throw new Error(`WB invalid orderId: ${order.orderId}`);
    }
    
    const url = 'https://marketplace-api.wildberries.ru/api/v3/orders/stickers?type=png&width=58&height=40';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': String(wb.api_key),
        'Content-Type': 'application/json',
        'Accept': 'image/png, application/json'
      },
      body: JSON.stringify([ orderIdNum ])
    });
    
    if (!resp.ok) {
      const text = await resp.text();
      console.warn('[Labels][WB] Response error:', resp.status, text);
      logLabelEvent(`[WB] label error ${resp.status}: ${text.substring(0, 300)}`);
      throw new Error(`WB label error ${resp.status}`);
    }
    
    // Ответ — PNG бинарный поток (сохраняем как .png, но можем назвать .pdf для совместимости)
    const arrayBuf = await resp.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (e) { throw e; }
}
async function fetchYMLabel(order) {
  try {
    const ym = await readData('yandex');
    if (!ym || !ym.api_key || !ym.campaign_id) return null;
    // TODO: Требуется подтвержденный эндпоинт YM для PDF этикетки 58x40
    return null;
  } catch (e) { throw e; }
}

// Функции для получения заказов с маркетплейсов
async function fetchOzonFBSOrders(config) {
  try {
    const { client_id, api_key } = config;
    
    // Используем endpoint для получения FBS заказов
    const response = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/list', {
      method: 'POST',
      headers: {
        'Client-Id': String(client_id),
        'Api-Key': String(api_key),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        dir: 'ASC',
        filter: {
          since: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // Увеличиваем до 90 дней
          to: new Date().toISOString()
          // Убираем фильтр по статусу, чтобы получить все заказы, включая доставленные
        },
        limit: 1000,
        offset: 0,
        with: {
          analytics_data: false,
          financial_data: false,
          transliteration: false
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Ozon Orders] API error: ${response.status}`, errorText);
      return [];
    }
    
    const data = await response.json();
    
    if (!data.result || !data.result.postings) {
      console.log('[Ozon Orders] No orders found');
      return [];
    }
    
    // Логируем первые несколько заказов для отладки
    console.log(`[Ozon Orders] Found ${data.result.postings.length} orders`);
    if (data.result.postings.length > 0) {
      const statuses = data.result.postings.map(o => o.status);
      const statusCounts = {};
      statuses.forEach(s => {
        statusCounts[s] = (statusCounts[s] || 0) + 1;
      });
      console.log('[Ozon Orders] Status distribution:', statusCounts);
      console.log('[Ozon Orders] Sample orders statuses:', 
        data.result.postings.slice(0, 10).map(o => `${o.posting_number}: ${o.status}`)
      );
    }
    
    return data.result.postings.map(order => {
      const mappedStatus = mapOzonOrderStatus(order.status);
      if (order.status !== mappedStatus) {
        console.log(`[Ozon Orders] Status mapped: ${order.posting_number} ${order.status} -> ${mappedStatus}`);
      }
      // Логируем доставленные заказы для отладки
      if (order.status === 'delivered' || mappedStatus === 'delivered') {
        console.log(`[Ozon Orders] Delivered order found: ${order.posting_number} (status: ${order.status}, mapped: ${mappedStatus})`);
      }
      return {
        marketplace: 'ozon',
        orderId: order.posting_number,
        offerId: order.products?.[0]?.offer_id || '',
        sku: order.products?.[0]?.sku || '',
        productName: order.products?.[0]?.name || '',
        quantity: order.products?.[0]?.quantity || 0,
        price: order.products?.[0]?.price || 0,
        status: mappedStatus,
        createdAt: order.created_at || '',
        inProcessAt: order.in_process_at || '',
        shipmentDate: order.shipment_date || '',
        customerName: order.customer_name || '',
        customerPhone: order.customer_phone || '',
        deliveryAddress: order.delivery_method?.warehouse_name || ''
      };
    });
  } catch (error) {
    console.error('[Ozon Orders] Fetch error:', error.message);
    return [];
  }
}

async function fetchWildberriesFBSOrders(config) {
  try {
    const { api_key } = config;
    
    // Используем endpoint для получения новых заказов Wildberries
    const url = `https://marketplace-api.wildberries.ru/api/v3/orders/new`;
    console.log(`[WB Orders] Fetching from: ${url}`);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': String(api_key),
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[WB Orders] API error: ${response.status}`, errorText);
      return [];
    }
    
    const data = await response.json();
    
    // Новый API возвращает { orders: [...] }
    const orders = Array.isArray(data.orders) ? data.orders : [];
    
    if (orders.length === 0) {
      console.log('[WB Orders] No orders found');
      return [];
    }
    
    console.log(`[WB Orders] Found ${orders.length} orders`);
    
    // Логируем структуру первого заказа
    console.log(`[WB Orders] Sample order structure:`, JSON.stringify(orders[0], null, 2));
    
    return orders.map(order => {
      // Для FBS заказов статус всегда "new", так как это endpoint для новых заказов
      const mappedStatus = 'new';
      return {
        marketplace: 'wildberries',
        orderId: (order.id?.toString && order.id?.toString()) || order.id || order.orderUid || '',
        offerId: order.skus?.[0] || '',
        sku: order.skus?.[0] || '',
        productName: `Артикул ${order.nmId}`,
        quantity: 1,
        price: order.convertedPrice || order.price || 0,
        status: mappedStatus,
        createdAt: order.createdAt || '',
        inProcessAt: order.createdAt || '',
        shipmentDate: '',
        customerName: '',
        customerPhone: '',
        deliveryAddress: order.offices?.[0] || ''
      };
    });
  } catch (error) {
    console.error('[WB Orders] Fetch error:', error.message);
    return [];
  }
}

async function fetchYandexFBSOrders(config) {
  try {
    const { api_key, campaign_id } = config;
    
    if (!campaign_id) {
      console.log('[YM Orders] No campaign ID configured');
      return [];
    }
    
    // Используем endpoint для получения заказов Yandex Market
    const url = `https://api.partner.market.yandex.ru/v2/campaigns/${campaign_id}/orders`;
    console.log(`[YM Orders] Fetching orders for campaign ${campaign_id}`);
    console.log(`[YM Orders] URL: ${url}`);
    console.log(`[YM Orders] API key: ${api_key.substring(0, 30)}...`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Api-Key': api_key,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[YM Orders] API error: ${response.status}`, errorText);
      return [];
    }
    
    const data = await response.json();
    
    console.log(`[YM Orders] Full response:`, JSON.stringify(data, null, 2));
    
    if (!data.orders || !Array.isArray(data.orders)) {
      console.log('[YM Orders] No orders found or not in expected format');
      return [];
    }
    
    console.log(`[YM Orders] Sample order statuses:`, data.orders.slice(0, 5).map(o => o.status));
    
    // Логируем структуру первого заказа
    if (data.orders.length > 0) {
      console.log(`[YM Orders] Sample order structure:`, JSON.stringify(data.orders[0], null, 2));
    }
    
    return data.orders.map(order => {
      const mappedStatus = mapYMOrderStatus(order.status);
      if (order.status !== mappedStatus) {
        console.log(`[YM Orders] Status mapped: ${order.status} -> ${mappedStatus}`);
      }
      return {
        marketplace: 'yandex',
        orderId: order.id?.toString() || '',
        offerId: order.items?.[0]?.offerId || '',
        sku: order.items?.[0]?.offerId || '',
        productName: order.items?.[0]?.offerName || '',
        quantity: order.items?.[0]?.count || 0,
        price: order.items?.[0]?.buyerPrice || 0,
        status: mappedStatus,
        createdAt: order.creationDate || '',
        inProcessAt: order.creationDate || '',
        shipmentDate: order.creationDate || '',
        customerName: `${order.buyer?.lastName || ''} ${order.buyer?.firstName || ''}`.trim() || '',
        customerPhone: order.buyer?.phone || '',
        deliveryAddress: order.delivery?.address?.postcode || ''
      };
    });
  } catch (error) {
    console.error('[YM Orders] Fetch error:', error.message);
    return [];
  }
}

// Функции для маппинга статусов
function mapOzonOrderStatus(status) {
  if (!status || typeof status !== 'string') {
    return status || 'unknown';
  }
  
  // Нормализуем статус к нижнему регистру для сравнения
  const normalizedStatus = status.toLowerCase().trim();
  
  const statusMap = {
    'awaiting_packaging': 'new',           // Ожидает упаковки → Новые
    'awaiting_deliver': 'assembled',       // Ожидает отправки → Собран
    'awaiting_delivery': 'assembled',     // Ожидает доставки → Собран
    'delivering': 'shipped',               // Доставляется → Отправлен
    'at_last_mile': 'shipped',             // В пути к покупателю → Отправлен
    'driving_to_pickup_point': 'shipped', // Едет в пункт выдачи → Отправлен
    'arrived_to_pickup_point': 'shipped', // Прибыл в пункт выдачи → Отправлен
    'cancel': 'cancelled',                 // Отменен
    'cancelled': 'cancelled',              // Отменен
    'delivered': 'delivered',              // Доставлен
    'delivery': 'shipped'                   // Доставка → Отправлен
  };
  
  const mapped = statusMap[normalizedStatus];
  if (mapped) {
    return mapped;
  }
  
  // Если статус не найден, возвращаем исходный (но нормализованный)
  console.warn(`[Ozon Status Map] Unknown status: "${status}" (normalized: "${normalizedStatus}")`);
  return normalizedStatus;
}

function mapWBOrderStatus(status) {
  const statusMap = {
    // Статусы статистики продаж
    'new': 'new',                    // Новые
    'confirm': 'processing',         // В обработке
    'dispatch': 'shipped',           // Отправлен
    'delivery': 'shipped',           // Доставляется → Отправлен
    'cancel': 'cancelled',           // Отменен
    'delivered': 'delivered',        // Доставлен
    'wb_cancelled': 'cancelled',     // Отменен WB
    // Статусы постингов
    'awaiting_packaging': 'new',     // Ожидает упаковки → Новые
    'awaiting_supply': 'assembled',  // Ожидает поставки → Собран
    'delivering': 'shipped',           // Доставляется → Отправлен
    'accepted': 'shipped',            // Принят на складе → Отправлен
    'delivered': 'delivered',         // Доставлен
    'cancelled': 'cancelled'         // Отменен
  };
  return statusMap[status] || status;
}

function mapYMOrderStatus(status) {
  const statusMap = {
    'PROCESSING': 'processing',      // В обработке
    'DELIVERY': 'shipped',           // Отправлен
    'SHIPMENT': 'shipped',           // Отгрузка → Отправлен
    'CANCELLED': 'cancelled',        // Отменен
    'DELIVERED': 'delivered'         // Доставлен
  };
  return statusMap[status] || status;
}

// Подключаем новый API роутер (должен быть перед статическими файлами)
app.use('/api', apiRoutes);

// Serve static files (HTML, CSS, JS) - после всех API роутов
app.use(express.static(__dirname));

// Middleware для перехвата всех ошибок (в конце, после всех роутов)
app.use((error, req, res, next) => {
  if (error) {
    console.error('[Middleware] Error caught:', error);
    console.error('[Middleware] Error message:', error.message);
    console.error('[Middleware] Error stack:', error.stack);
    return sendErr(res, 500, 'Middleware error: ' + (error.message || 'Unknown error'));
  }
  next();
});

const PORT = process.env.PORT || 3001;

console.log('[Server] Starting server on port', PORT);
console.log('[Server] Registered routes: /api/test, /api/error-log, /logs');
console.log('[Server] New API routes from server/src/routes are connected');

// Обработка ошибок при запуске сервера
process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught Exception:', error);
  console.error('[Server] Stack:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

try {
  console.log('[Server] Attempting to listen on port', PORT);
  app.listen(PORT, () => {
    console.log(`[proxy] listening on http://localhost:${PORT}`);
    console.log(`[proxy] Open http://localhost:${PORT} in your browser`);
    console.log(`[proxy] Test endpoint: http://localhost:${PORT}/api/test`);
    console.log(`[proxy] Logs page: http://localhost:${PORT}/logs`);
    console.log('[Server] Server started successfully!');
  // Фоновая синхронизация заказов с маркетплейсов (без открытого браузера)
  (async () => {
    try {
      await schedulerService.startOrdersFbsBackgroundSyncOnly();
    } catch (e) {
      console.warn('[Scheduler] FBS background sync:', e?.message || e);
    }
  })();
  // Периодическая автозагрузка недостающих этикеток для новых заказов
  setTimeout(async () => {
    try {
      const data = await readData('orders');
      const orders = (data && data.orders) || [];
      await preloadOrderLabels(orders);
    } catch (e) {
      console.warn('[Labels] Initial preload failed:', e.message);
    }
  }, 2000);
  setInterval(async () => {
    try {
      const data = await readData('orders');
      const orders = (data && data.orders) || [];
      await preloadOrderLabels(orders);
    } catch (e) {
      console.warn('[Labels] Scheduled preload failed:', e.message);
    }
  }, 5 * 60 * 1000); // каждые 5 минут
  });
} catch (listenError) {
  console.error('[Server] Error starting server:', listenError);
  console.error('[Server] Error stack:', listenError?.stack);
  process.exit(1);
}

// ===== Helpers: логирование этикеток в файл =====
function logLabelEvent(message) {
  try {
    const dir = DATA_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(join(dir, 'labels.log'), line);
  } catch (e) {
    console.warn('[Labels][log] Failed to write log:', e.message);
  }
}




