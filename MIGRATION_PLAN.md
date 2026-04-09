# План миграции монолитного приложения на раздельную архитектуру

## 📊 Анализ текущего состояния проекта

### Текущая архитектура

**Монолитное приложение:**
- **Backend + Frontend в одном проекте**
- `server.js` (4862 строки) - Express сервер с API и статической раздачей
- `index.html` (10852+ строк) - весь фронтенд в одном файле (HTML + CSS + JavaScript)
- **62 API endpoints** в одном файле
- **Файловое хранилище** (JSON файлы в `data/`)
- **Статическая раздача** через `app.use(express.static(__dirname))`

### Проблемы текущей архитектуры

1. **Отсутствие разделения ответственности**
   - Backend и Frontend в одном процессе
   - Невозможность независимого масштабирования
   - Сложность тестирования

2. **Монолитный код**
   - 62 endpoints в одном файле
   - 10852+ строк фронтенд кода в одном HTML файле
   - Нет модульной структуры

3. **Отсутствие стандартизации**
   - Нет структуры папок для backend
   - Нет компонентного подхода на frontend
   - Смешанная логика (UI + бизнес-логика)

4. **Сложность разработки**
   - Невозможность параллельной разработки
   - Сложность поддержки
   - Нет возможности использовать современные инструменты (React, TypeScript)

### Текущие API Endpoints (62)

**Products:**
- `GET /api/products`
- `POST /api/products`
- `PUT /api/products/:id`
- `DELETE /api/products/:id`
- `PUT /api/products-all`

**Orders:**
- `GET /api/orders`
- `POST /api/orders/sync-fbs`
- `POST /api/orders/ozon/:orderId/refresh`
- `GET /api/orders/:orderId/label`
- `POST /api/orders/:orderId/collect`

**Warehouses:**
- `GET /api/warehouses`
- `POST /api/warehouses`
- `PUT /api/warehouses/:id`
- `DELETE /api/warehouses/:id`

**Suppliers:**
- `GET /api/suppliers`
- `POST /api/suppliers`
- `PUT /api/suppliers/:id`
- `DELETE /api/suppliers/:id`
- `GET /api/supplier-stocks`

**Marketplaces:**
- `GET /categories/ozon`
- `GET /categories/wb`
- `GET /categories/ym`
- `GET /product/check/ozon`
- `GET /product/check/wb`
- `GET /product/check/ym`
- `GET /product/prices/ozon`
- `GET /product/prices/wb`
- `GET /product/prices/ym`
- `POST /test/ozon`
- `POST /test/wb`
- `POST /test/ym`

**WB Cache:**
- `POST /api/wb-cache/refresh`
- `GET /api/wb-cache/status`
- `GET /api/wb-warehouses`
- `POST /api/wb-warehouses/refresh`
- `GET /api/wb-warehouses/status`

**Mappings:**
- `GET /api/warehouse-mappings`
- `POST /api/warehouse-mappings`
- `DELETE /api/warehouse-mappings`
- `GET /api/category-mappings`
- `POST /api/category-mappings`

**Data Storage:**
- `GET /api/data/:type`
- `POST /api/data/:type`
- `GET /api/data`
- `DELETE /api/data`

**Utilities:**
- `GET /api/test`
- `GET /api/error-log`
- `GET /api/server-logs`
- `GET /status`
- `GET /logs`

### Текущие страницы Frontend

1. **Главная** (`page-home`)
2. **Товары** (`page-products`)
3. **Категории** (`page-categories`)
4. **Бренды** (`page-brands`)
5. **Склады** (`page-stocks`)
   - Основные склады
   - WB склады
   - Остатки
6. **Поставщики** (`page-suppliers`)
7. **Цены** (`page-prices`)
8. **Заказы** (`page-orders`)
9. **Интеграции** (`page-integrations`)
   - Маркетплейсы (Ozon, WB, YM)
   - Поставщики (Mikado, Moskvorechie)

---

## 🏗️ Финальная структура нового проекта

```
erp-system/
├── server/                          # Backend (Node.js + Express)
│   ├── src/
│   │   ├── config/                  # Конфигурация
│   │   │   ├── database.js          # Настройки БД (пока файловое хранилище)
│   │   │   ├── cors.js              # Настройки CORS
│   │   │   └── env.js               # Переменные окружения
│   │   │
│   │   ├── routes/                  # Маршруты API
│   │   │   ├── index.js             # Главный роутер
│   │   │   ├── products.routes.js
│   │   │   ├── orders.routes.js
│   │   │   ├── warehouses.routes.js
│   │   │   ├── suppliers.routes.js
│   │   │   ├── marketplaces.routes.js
│   │   │   ├── categories.routes.js
│   │   │   └── mappings.routes.js
│   │   │
│   │   ├── controllers/             # Контроллеры
│   │   │   ├── products.controller.js
│   │   │   ├── orders.controller.js
│   │   │   ├── warehouses.controller.js
│   │   │   ├── suppliers.controller.js
│   │   │   ├── marketplaces.controller.js
│   │   │   └── categories.controller.js
│   │   │
│   │   ├── services/                # Бизнес-логика
│   │   │   ├── products.service.js
│   │   │   ├── orders.service.js
│   │   │   ├── warehouses.service.js
│   │   │   ├── suppliers.service.js
│   │   │   ├── marketplaces/
│   │   │   │   ├── ozon.service.js
│   │   │   │   ├── wildberries.service.js
│   │   │   │   └── yandex.service.js
│   │   │   ├── suppliers/
│   │   │   │   ├── mikado.service.js
│   │   │   │   └── moskvorechie.service.js
│   │   │   └── cache.service.js
│   │   │
│   │   ├── models/                  # Модели данных
│   │   │   ├── Product.model.js
│   │   │   ├── Order.model.js
│   │   │   ├── Warehouse.model.js
│   │   │   └── Supplier.model.js
│   │   │
│   │   ├── repositories/            # Слой доступа к данным
│   │   │   ├── products.repository.js
│   │   │   ├── orders.repository.js
│   │   │   ├── warehouses.repository.js
│   │   │   └── suppliers.repository.js
│   │   │
│   │   ├── middleware/              # Middleware
│   │   │   ├── errorHandler.js
│   │   │   ├── logger.js
│   │   │   ├── validator.js
│   │   │   └── rateLimiter.js
│   │   │
│   │   ├── utils/                   # Утилиты
│   │   │   ├── storage.js           # Файловое хранилище (временно)
│   │   │   ├── logger.js
│   │   │   └── helpers.js
│   │   │
│   │   └── app.js                   # Главный файл приложения
│   │
│   ├── data/                        # Данные (JSON файлы)
│   │   ├── products.json
│   │   ├── orders.json
│   │   ├── warehouses.json
│   │   └── ...
│   │
│   ├── .env                         # Переменные окружения
│   ├── .env.example                 # Пример .env
│   ├── package.json
│   ├── server.js                    # Точка входа
│   └── README.md
│
├── client/                          # Frontend (React)
│   ├── public/
│   │   ├── index.html
│   │   └── favicon.ico
│   │
│   ├── src/
│   │   ├── components/              # Переиспользуемые компоненты
│   │   │   ├── common/
│   │   │   │   ├── Button/
│   │   │   │   ├── Modal/
│   │   │   │   ├── Table/
│   │   │   │   ├── Input/
│   │   │   │   └── Loading/
│   │   │   ├── layout/
│   │   │   │   ├── Sidebar/
│   │   │   │   ├── Header/
│   │   │   │   └── Layout/
│   │   │   └── forms/
│   │   │       ├── ProductForm/
│   │   │       ├── WarehouseForm/
│   │   │       └── SupplierForm/
│   │   │
│   │   ├── pages/                   # Страницы
│   │   │   ├── Home/
│   │   │   ├── Products/
│   │   │   ├── Orders/
│   │   │   ├── Warehouses/
│   │   │   ├── Suppliers/
│   │   │   ├── Categories/
│   │   │   ├── Brands/
│   │   │   ├── Prices/
│   │   │   └── Integrations/
│   │   │
│   │   ├── services/                # API сервисы
│   │   │   ├── api.js               # Базовый API клиент
│   │   │   ├── products.api.js
│   │   │   ├── orders.api.js
│   │   │   ├── warehouses.api.js
│   │   │   ├── suppliers.api.js
│   │   │   └── marketplaces.api.js
│   │   │
│   │   ├── hooks/                   # Custom React Hooks
│   │   │   ├── useProducts.js
│   │   │   ├── useOrders.js
│   │   │   ├── useWarehouses.js
│   │   │   └── useApi.js
│   │   │
│   │   ├── contexts/                # React Context
│   │   │   ├── AuthContext.js
│   │   │   └── AppContext.js
│   │   │
│   │   ├── utils/                   # Утилиты
│   │   │   ├── helpers.js
│   │   │   ├── constants.js
│   │   │   └── formatters.js
│   │   │
│   │   ├── styles/                  # Стили
│   │   │   ├── index.css
│   │   │   ├── variables.css
│   │   │   └── components.css
│   │   │
│   │   ├── App.js                   # Главный компонент
│   │   ├── App.css
│   │   ├── index.js                 # Точка входа
│   │   └── index.css
│   │
│   ├── package.json
│   └── README.md
│
├── .gitignore
├── package.json                    # Root package.json (опционально)
└── README.md                       # Документация проекта
```

---

## 📋 Пошаговый план разделения монолита

### Фаза 1: Подготовка и настройка окружения (1-2 дня)

#### Шаг 1.1: Создание структуры папок
```bash
# Создаем новую структуру
mkdir -p server/src/{config,routes,controllers,services,models,repositories,middleware,utils}
mkdir -p client/src/{components,pages,services,hooks,contexts,utils,styles}
mkdir -p client/public
```

#### Шаг 1.2: Настройка Backend (server/)
```bash
cd server
npm init -y
npm install express cors dotenv
npm install --save-dev nodemon
```

**server/package.json:**
```json
{
  "name": "erp-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "server": "node server.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
```

#### Шаг 1.3: Настройка Frontend (client/)
```bash
cd client
npx create-react-app . --template minimal
# Или используем Vite для более быстрой настройки
npm create vite@latest . -- --template react
```

**client/package.json:**
```json
{
  "name": "erp-client",
  "version": "1.0.0",
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build",
    "test": "react-scripts test",
    "eject": "react-scripts eject",
    "client": "react-scripts start"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.20.0",
    "axios": "^1.6.2"
  }
}
```

---

### Фаза 2: Миграция Backend (3-5 дней)

#### Шаг 2.1: Создание базовой структуры Express

**server/src/app.js:**
```javascript
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './middleware/logger.js';
import routes from './routes/index.js';

dotenv.config();

const app = express();

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(logger);

// Routes
app.use('/api', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler (должен быть последним)
app.use(errorHandler);

export default app;
```

**server/server.js:**
```javascript
import app from './src/app.js';

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
  console.log(`[Server] API available at http://localhost:${PORT}/api`);
});
```

#### Шаг 2.2: Создание слоя хранилища (Repository)

**server/src/utils/storage.js:**
```javascript
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');

const DATA_FILES = {
  products: join(DATA_DIR, 'products.json'),
  orders: join(DATA_DIR, 'orders.json'),
  warehouses: join(DATA_DIR, 'warehouses.json'),
  suppliers: join(DATA_DIR, 'suppliers.json'),
  ozon: join(DATA_DIR, 'ozon.json'),
  wildberries: join(DATA_DIR, 'wildberries.json'),
  yandex: join(DATA_DIR, 'yandex.json'),
  mikado: join(DATA_DIR, 'mikado.json'),
  moskvorechie: join(DATA_DIR, 'moskvorechie.json'),
  supplierStockCache: join(DATA_DIR, 'supplierStockCache.json'),
  wbCategoriesCache: join(DATA_DIR, 'wbCategoriesCache.json'),
  wbCommissionsCache: join(DATA_DIR, 'wbCommissionsCache.json'),
  wbWarehousesCache: join(DATA_DIR, 'wbWarehousesCache.json'),
  categoryMappings: join(DATA_DIR, 'categoryMappings.json'),
  warehouseMappings: join(DATA_DIR, 'warehouseMappings.json')
};

// Создаем директорию для данных, если её нет
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export async function readData(type) {
  try {
    const filePath = DATA_FILES[type];
    if (!filePath) {
      throw new Error(`Unknown data type: ${type}`);
    }
    
    if (!fs.existsSync(filePath)) {
      return Array.isArray(DATA_FILES[type]) ? [] : {};
    }
    
    const data = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`[Storage] Error reading ${type}:`, error.message);
    return Array.isArray(DATA_FILES[type]) ? [] : {};
  }
}

export async function writeData(type, data) {
  try {
    const filePath = DATA_FILES[type];
    if (!filePath) {
      throw new Error(`Unknown data type: ${type}`);
    }
    
    const jsonString = JSON.stringify(data, null, 2);
    await fs.promises.writeFile(filePath, jsonString, 'utf8');
    return true;
  } catch (error) {
    console.error(`[Storage] Error writing ${type}:`, error.message);
    return false;
  }
}

export { DATA_FILES, DATA_DIR };
```

#### Шаг 2.3: Создание Repository для Products

**server/src/repositories/products.repository.js:**
```javascript
import { readData, writeData } from '../utils/storage.js';

class ProductsRepository {
  async findAll() {
    const data = await readData('products');
    return Array.isArray(data) ? data : (data.products || []);
  }

  async findById(id) {
    const products = await this.findAll();
    return products.find(p => String(p.id) === String(id));
  }

  async findBySku(sku) {
    const products = await this.findAll();
    return products.find(p => p.sku === sku);
  }

  async create(productData) {
    const products = await this.findAll();
    const newProduct = {
      ...productData,
      id: productData.id || Date.now() + Math.random(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    products.push(newProduct);
    await writeData('products', products);
    return newProduct;
  }

  async update(id, updates) {
    const products = await this.findAll();
    const index = products.findIndex(p => String(p.id) === String(id));
    
    if (index === -1) {
      throw new Error('Product not found');
    }
    
    products[index] = {
      ...products[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    await writeData('products', products);
    return products[index];
  }

  async delete(id) {
    const products = await this.findAll();
    const filtered = products.filter(p => String(p.id) !== String(id));
    await writeData('products', filtered);
    return true;
  }

  async updateAll(products) {
    await writeData('products', products);
    return products;
  }
}

export default new ProductsRepository();
```

#### Шаг 2.4: Создание Service для Products

**server/src/services/products.service.js:**
```javascript
import productsRepository from '../repositories/products.repository.js';

class ProductsService {
  async getAllProducts() {
    return await productsRepository.findAll();
  }

  async getProductById(id) {
    const product = await productsRepository.findById(id);
    if (!product) {
      throw new Error('Product not found');
    }
    return product;
  }

  async createProduct(productData) {
    // Валидация
    if (!productData.sku) {
      throw new Error('SKU is required');
    }
    
    // Проверка уникальности
    const existing = await productsRepository.findBySku(productData.sku);
    if (existing) {
      throw new Error('Product with this SKU already exists');
    }
    
    return await productsRepository.create(productData);
  }

  async updateProduct(id, updates) {
    const product = await productsRepository.findById(id);
    if (!product) {
      throw new Error('Product not found');
    }
    
    return await productsRepository.update(id, updates);
  }

  async deleteProduct(id) {
    const product = await productsRepository.findById(id);
    if (!product) {
      throw new Error('Product not found');
    }
    
    return await productsRepository.delete(id);
  }

  async updateAllProducts(products) {
    return await productsRepository.updateAll(products);
  }
}

export default new ProductsService();
```

#### Шаг 2.5: Создание Controller для Products

**server/src/controllers/products.controller.js:**
```javascript
import productsService from '../services/products.service.js';

class ProductsController {
  async getAllProducts(req, res, next) {
    try {
      const products = await productsService.getAllProducts();
      res.json({ ok: true, data: products });
    } catch (error) {
      next(error);
    }
  }

  async getProductById(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.getProductById(id);
      res.json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async createProduct(req, res, next) {
    try {
      const product = await productsService.createProduct(req.body);
      res.status(201).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async updateProduct(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.updateProduct(id, req.body);
      res.json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async deleteProduct(req, res, next) {
    try {
      const { id } = req.params;
      await productsService.deleteProduct(id);
      res.json({ ok: true, message: 'Product deleted' });
    } catch (error) {
      next(error);
    }
  }

  async updateAllProducts(req, res, next) {
    try {
      const products = await productsService.updateAllProducts(req.body);
      res.json({ ok: true, data: products });
    } catch (error) {
      next(error);
    }
  }
}

export default new ProductsController();
```

#### Шаг 2.6: Создание Routes для Products

**server/src/routes/products.routes.js:**
```javascript
import express from 'express';
import productsController from '../controllers/products.controller.js';

const router = express.Router();

router.get('/', productsController.getAllProducts.bind(productsController));
router.get('/:id', productsController.getProductById.bind(productsController));
router.post('/', productsController.createProduct.bind(productsController));
router.put('/:id', productsController.updateProduct.bind(productsController));
router.delete('/:id', productsController.deleteProduct.bind(productsController));
router.put('/all', productsController.updateAllProducts.bind(productsController));

export default router;
```

#### Шаг 2.7: Создание главного роутера

**server/src/routes/index.js:**
```javascript
import express from 'express';
import productsRoutes from './products.routes.js';
import ordersRoutes from './orders.routes.js';
import warehousesRoutes from './warehouses.routes.js';
import suppliersRoutes from './suppliers.routes.js';
// ... другие роуты

const router = express.Router();

router.use('/products', productsRoutes);
router.use('/orders', ordersRoutes);
router.use('/warehouses', warehousesRoutes);
router.use('/suppliers', suppliersRoutes);
// ... другие роуты

export default router;
```

#### Шаг 2.8: Создание Middleware

**server/src/middleware/errorHandler.js:**
```javascript
export function errorHandler(err, req, res, next) {
  console.error('[Error]', err);
  
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  
  res.status(statusCode).json({
    ok: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}
```

**server/src/middleware/logger.js:**
```javascript
export function logger(req, res, next) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
}
```

#### Шаг 2.9: Копирование данных

```bash
# Копируем данные из старого проекта
cp -r data server/data
```

#### Шаг 2.10: Повторение для других модулей

Повторить шаги 2.3-2.7 для:
- Orders
- Warehouses
- Suppliers
- Marketplaces (Ozon, WB, YM)
- Categories
- Mappings

---

### Фаза 3: Миграция Frontend на React (5-7 дней)

#### Шаг 3.1: Настройка API клиента

**client/src/services/api.js:**
```javascript
import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Interceptor для обработки ошибок
api.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('[API Error]', error);
    return Promise.reject(error);
  }
);

export default api;
```

#### Шаг 3.2: Создание API сервисов

**client/src/services/products.api.js:**
```javascript
import api from './api.js';

export const productsApi = {
  getAll: async () => {
    const response = await api.get('/products');
    return response.data;
  },

  getById: async (id) => {
    const response = await api.get(`/products/${id}`);
    return response.data;
  },

  create: async (productData) => {
    const response = await api.post('/products', productData);
    return response.data;
  },

  update: async (id, updates) => {
    const response = await api.put(`/products/${id}`, updates);
    return response.data;
  },

  delete: async (id) => {
    const response = await api.delete(`/products/${id}`);
    return response.data;
  },

  updateAll: async (products) => {
    const response = await api.put('/products/all', products);
    return response.data;
  }
};
```

#### Шаг 3.3: Создание Custom Hooks

**client/src/hooks/useProducts.js:**
```javascript
import { useState, useEffect } from 'react';
import { productsApi } from '../services/products.api.js';

export function useProducts() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async () => {
    try {
      setLoading(true);
      const response = await productsApi.getAll();
      setProducts(response.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const createProduct = async (productData) => {
    try {
      const response = await productsApi.create(productData);
      setProducts([...products, response.data]);
      return response.data;
    } catch (err) {
      throw err;
    }
  };

  const updateProduct = async (id, updates) => {
    try {
      const response = await productsApi.update(id, updates);
      setProducts(products.map(p => p.id === id ? response.data : p));
      return response.data;
    } catch (err) {
      throw err;
    }
  };

  const deleteProduct = async (id) => {
    try {
      await productsApi.delete(id);
      setProducts(products.filter(p => p.id !== id));
    } catch (err) {
      throw err;
    }
  };

  return {
    products,
    loading,
    error,
    loadProducts,
    createProduct,
    updateProduct,
    deleteProduct
  };
}
```

#### Шаг 3.4: Создание компонентов

**client/src/components/layout/Sidebar.jsx:**
```jsx
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import './Sidebar.css';

const menuItems = [
  { path: '/', label: 'Главная', icon: '🏠' },
  { path: '/products', label: 'Товары', icon: '📦' },
  { path: '/orders', label: 'Заказы', icon: '📋' },
  { path: '/warehouses', label: 'Склады', icon: '🏭' },
  { path: '/suppliers', label: 'Поставщики', icon: '🚚' },
  { path: '/categories', label: 'Категории', icon: '📁' },
  { path: '/brands', label: 'Бренды', icon: '⭐' },
  { path: '/prices', label: 'Цены', icon: '💰' },
  { path: '/integrations', label: 'Интеграции', icon: '🔌' }
];

export function Sidebar() {
  const location = useLocation();

  return (
    <aside className="sidebar">
      <h2 className="brand">ERP Demo</h2>
      <nav className="nav">
        {menuItems.map(item => (
          <Link
            key={item.path}
            to={item.path}
            className={`nav-btn ${location.pathname === item.path ? 'active' : ''}`}
          >
            <span>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
```

**client/src/components/common/Button/Button.jsx:**
```jsx
import React from 'react';
import './Button.css';

export function Button({ 
  children, 
  onClick, 
  variant = 'primary', 
  type = 'button',
  disabled = false,
  ...props 
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
```

**client/src/components/common/Modal/Modal.jsx:**
```jsx
import React from 'react';
import './Modal.css';

export function Modal({ isOpen, onClose, title, children }) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}
```

#### Шаг 3.5: Создание страниц

**client/src/pages/Products/Products.jsx:**
```jsx
import React, { useState } from 'react';
import { useProducts } from '../../hooks/useProducts.js';
import { Button } from '../../components/common/Button/Button.jsx';
import { Modal } from '../../components/common/Modal/Modal.jsx';
import { ProductForm } from '../../components/forms/ProductForm/ProductForm.jsx';
import { ProductTable } from '../../components/products/ProductTable/ProductTable.jsx';
import './Products.css';

export function Products() {
  const { products, loading, error, createProduct, updateProduct, deleteProduct } = useProducts();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);

  const handleCreate = () => {
    setEditingProduct(null);
    setIsModalOpen(true);
  };

  const handleEdit = (product) => {
    setEditingProduct(product);
    setIsModalOpen(true);
  };

  const handleSubmit = async (productData) => {
    try {
      if (editingProduct) {
        await updateProduct(editingProduct.id, productData);
      } else {
        await createProduct(productData);
      }
      setIsModalOpen(false);
      setEditingProduct(null);
    } catch (error) {
      console.error('Error saving product:', error);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Вы уверены, что хотите удалить этот товар?')) {
      await deleteProduct(id);
    }
  };

  if (loading) return <div>Загрузка...</div>;
  if (error) return <div>Ошибка: {error}</div>;

  return (
    <div className="products-page">
      <h1>Управление товарами</h1>
      <div className="products-actions">
        <Button onClick={handleCreate}>Добавить товар</Button>
      </div>
      <ProductTable 
        products={products}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingProduct ? 'Редактировать товар' : 'Создать товар'}
      >
        <ProductForm
          product={editingProduct}
          onSubmit={handleSubmit}
          onCancel={() => setIsModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
```

#### Шаг 3.6: Настройка роутинга

**client/src/App.js:**
```jsx
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/layout/Layout/Layout.jsx';
import { Home } from './pages/Home/Home.jsx';
import { Products } from './pages/Products/Products.jsx';
import { Orders } from './pages/Orders/Orders.jsx';
import { Warehouses } from './pages/Warehouses/Warehouses.jsx';
import { Suppliers } from './pages/Suppliers/Suppliers.jsx';
import { Categories } from './pages/Categories/Categories.jsx';
import { Brands } from './pages/Brands/Brands.jsx';
import { Prices } from './pages/Prices/Prices.jsx';
import { Integrations } from './pages/Integrations/Integrations.jsx';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/products" element={<Products />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/warehouses" element={<Warehouses />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/brands" element={<Brands />} />
          <Route path="/prices" element={<Prices />} />
          <Route path="/integrations" element={<Integrations />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
```

#### Шаг 3.7: Миграция стилей

**client/src/styles/variables.css:**
```css
:root {
  --bg: #ffffff;
  --card: #ffffff;
  --text: #1f2937;
  --muted: #6b7280;
  --primary: #1f2937;
  --accent: #DC2626;
  --border: #E5E7EB;
  --success: #10B981;
  --warning: #F59E0B;
  --error: #EF4444;
}
```

**client/src/styles/index.css:**
```css
@import './variables.css';

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
}

/* Общие стили из index.html */
```

---

### Фаза 4: Интеграция и тестирование (2-3 дня)

#### Шаг 4.1: Настройка CORS на Backend

**server/src/config/cors.js:**
```javascript
export const corsOptions = {
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
```

#### Шаг 4.2: Создание .env файлов

**server/.env:**
```env
PORT=3001
CLIENT_URL=http://localhost:3000
NODE_ENV=development
```

**client/.env:**
```env
REACT_APP_API_URL=http://localhost:3001/api
```

#### Шаг 4.3: Обновление package.json scripts

**server/package.json:**
```json
{
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "server": "node server.js"
  }
}
```

**client/package.json:**
```json
{
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build",
    "client": "react-scripts start"
  }
}
```

#### Шаг 4.4: Тестирование API

```bash
# Запуск backend
cd server
npm run dev

# Запуск frontend
cd client
npm start

# Тестирование API
curl http://localhost:3001/api/products
```

---

## 📝 Список файлов для миграции

### Backend (server/)

**Из server.js:**
- [x] Функции `readData`, `writeData` → `server/src/utils/storage.js`
- [x] API endpoints для Products → `server/src/routes/products.routes.js`
- [x] API endpoints для Orders → `server/src/routes/orders.routes.js`
- [x] API endpoints для Warehouses → `server/src/routes/warehouses.routes.js`
- [x] API endpoints для Suppliers → `server/src/routes/suppliers.routes.js`
- [x] API endpoints для Marketplaces → `server/src/routes/marketplaces.routes.js`
- [x] Функции синхронизации → `server/src/services/marketplaces/*.service.js`
- [x] Функции поставщиков → `server/src/services/suppliers/*.service.js`
- [x] Middleware → `server/src/middleware/*.js`
- [x] Главный файл → `server/server.js` + `server/src/app.js`

**Из data/:**
- [x] Все JSON файлы → `server/data/` (копируются как есть)

### Frontend (client/)

**Из index.html:**
- [x] HTML структура → React компоненты в `client/src/components/`
- [x] CSS стили → `client/src/styles/*.css`
- [x] JavaScript логика → React компоненты и hooks
- [x] Функции fetch → API сервисы в `client/src/services/`
- [x] Страницы → `client/src/pages/`
- [x] Навигация → React Router в `client/src/App.js`

**Компоненты для создания:**
- [x] `Sidebar` → `client/src/components/layout/Sidebar.jsx`
- [x] `Layout` → `client/src/components/layout/Layout.jsx`
- [x] `Button` → `client/src/components/common/Button/Button.jsx`
- [x] `Modal` → `client/src/components/common/Modal/Modal.jsx`
- [x] `Table` → `client/src/components/common/Table/Table.jsx`
- [x] `Input` → `client/src/components/common/Input/Input.jsx`
- [x] `ProductForm` → `client/src/components/forms/ProductForm/ProductForm.jsx`
- [x] `WarehouseForm` → `client/src/components/forms/WarehouseForm/WarehouseForm.jsx`
- [x] `SupplierForm` → `client/src/components/forms/SupplierForm/SupplierForm.jsx`

**Страницы для создания:**
- [x] `Home` → `client/src/pages/Home/Home.jsx`
- [x] `Products` → `client/src/pages/Products/Products.jsx`
- [x] `Orders` → `client/src/pages/Orders/Orders.jsx`
- [x] `Warehouses` → `client/src/pages/Warehouses/Warehouses.jsx`
- [x] `Suppliers` → `client/src/pages/Suppliers/Suppliers.jsx`
- [x] `Categories` → `client/src/pages/Categories/Categories.jsx`
- [x] `Brands` → `client/src/pages/Brands/Brands.jsx`
- [x] `Prices` → `client/src/pages/Prices/Prices.jsx`
- [x] `Integrations` → `client/src/pages/Integrations/Integrations.jsx`

---

## 🔧 Примеры структуры Express API

### Полный пример: Products Module

**server/src/repositories/products.repository.js:**
```javascript
import { readData, writeData } from '../utils/storage.js';

class ProductsRepository {
  async findAll() {
    const data = await readData('products');
    return Array.isArray(data) ? data : (data.products || []);
  }

  async findById(id) {
    const products = await this.findAll();
    return products.find(p => String(p.id) === String(id));
  }

  async create(productData) {
    const products = await this.findAll();
    const newProduct = {
      ...productData,
      id: productData.id || Date.now() + Math.random(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    products.push(newProduct);
    await writeData('products', products);
    return newProduct;
  }

  async update(id, updates) {
    const products = await this.findAll();
    const index = products.findIndex(p => String(p.id) === String(id));
    if (index === -1) throw new Error('Product not found');
    products[index] = { ...products[index], ...updates, updatedAt: new Date().toISOString() };
    await writeData('products', products);
    return products[index];
  }

  async delete(id) {
    const products = await this.findAll();
    const filtered = products.filter(p => String(p.id) !== String(id));
    await writeData('products', filtered);
    return true;
  }
}

export default new ProductsRepository();
```

**server/src/services/products.service.js:**
```javascript
import productsRepository from '../repositories/products.repository.js';

class ProductsService {
  async getAllProducts() {
    return await productsRepository.findAll();
  }

  async getProductById(id) {
    const product = await productsRepository.findById(id);
    if (!product) throw new Error('Product not found');
    return product;
  }

  async createProduct(productData) {
    if (!productData.sku) throw new Error('SKU is required');
    const existing = await productsRepository.findBySku(productData.sku);
    if (existing) throw new Error('Product with this SKU already exists');
    return await productsRepository.create(productData);
  }

  async updateProduct(id, updates) {
    const product = await productsRepository.findById(id);
    if (!product) throw new Error('Product not found');
    return await productsRepository.update(id, updates);
  }

  async deleteProduct(id) {
    const product = await productsRepository.findById(id);
    if (!product) throw new Error('Product not found');
    return await productsRepository.delete(id);
  }
}

export default new ProductsService();
```

**server/src/controllers/products.controller.js:**
```javascript
import productsService from '../services/products.service.js';

class ProductsController {
  async getAllProducts(req, res, next) {
    try {
      const products = await productsService.getAllProducts();
      res.json({ ok: true, data: products });
    } catch (error) {
      next(error);
    }
  }

  async getProductById(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.getProductById(id);
      res.json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async createProduct(req, res, next) {
    try {
      const product = await productsService.createProduct(req.body);
      res.status(201).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async updateProduct(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.updateProduct(id, req.body);
      res.json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async deleteProduct(req, res, next) {
    try {
      const { id } = req.params;
      await productsService.deleteProduct(id);
      res.json({ ok: true, message: 'Product deleted' });
    } catch (error) {
      next(error);
    }
  }
}

export default new ProductsController();
```

**server/src/routes/products.routes.js:**
```javascript
import express from 'express';
import productsController from '../controllers/products.controller.js';

const router = express.Router();

router.get('/', productsController.getAllProducts.bind(productsController));
router.get('/:id', productsController.getProductById.bind(productsController));
router.post('/', productsController.createProduct.bind(productsController));
router.put('/:id', productsController.updateProduct.bind(productsController));
router.delete('/:id', productsController.deleteProduct.bind(productsController));

export default router;
```

---

## ⚛️ Примеры React-компонентов

### Пример: Products Page

**client/src/pages/Products/Products.jsx:**
```jsx
import React, { useState } from 'react';
import { useProducts } from '../../hooks/useProducts.js';
import { Button } from '../../components/common/Button/Button.jsx';
import { Modal } from '../../components/common/Modal/Modal.jsx';
import { ProductForm } from '../../components/forms/ProductForm/ProductForm.jsx';
import { ProductTable } from '../../components/products/ProductTable/ProductTable.jsx';
import './Products.css';

export function Products() {
  const { products, loading, error, createProduct, updateProduct, deleteProduct } = useProducts();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);

  const handleCreate = () => {
    setEditingProduct(null);
    setIsModalOpen(true);
  };

  const handleEdit = (product) => {
    setEditingProduct(product);
    setIsModalOpen(true);
  };

  const handleSubmit = async (productData) => {
    try {
      if (editingProduct) {
        await updateProduct(editingProduct.id, productData);
      } else {
        await createProduct(productData);
      }
      setIsModalOpen(false);
      setEditingProduct(null);
    } catch (error) {
      console.error('Error saving product:', error);
      alert('Ошибка сохранения товара');
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Вы уверены, что хотите удалить этот товар?')) {
      try {
        await deleteProduct(id);
      } catch (error) {
        console.error('Error deleting product:', error);
        alert('Ошибка удаления товара');
      }
    }
  };

  if (loading) return <div className="loading">Загрузка...</div>;
  if (error) return <div className="error">Ошибка: {error}</div>;

  return (
    <div className="products-page">
      <div className="page-header">
        <h1>Управление товарами</h1>
        <Button onClick={handleCreate}>Добавить товар</Button>
      </div>
      
      <ProductTable 
        products={products}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
      
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingProduct ? 'Редактировать товар' : 'Создать товар'}
      >
        <ProductForm
          product={editingProduct}
          onSubmit={handleSubmit}
          onCancel={() => setIsModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
```

### Пример: ProductForm Component

**client/src/components/forms/ProductForm/ProductForm.jsx:**
```jsx
import React, { useState, useEffect } from 'react';
import { Input } from '../../common/Input/Input.jsx';
import { Button } from '../../common/Button/Button.jsx';
import './ProductForm.css';

export function ProductForm({ product, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    sku: '',
    name: '',
    description: '',
    brand: '',
    price: '',
    quantity: 0,
    weight: '',
    length: '',
    width: '',
    height: '',
    volume: ''
  });

  useEffect(() => {
    if (product) {
      setFormData({
        sku: product.sku || '',
        name: product.name || '',
        description: product.description || '',
        brand: product.brand || '',
        price: product.price || '',
        quantity: product.quantity || 0,
        weight: product.weight || '',
        length: product.length || '',
        width: product.width || '',
        height: product.height || '',
        volume: product.volume || ''
      });
    }
  }, [product]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="product-form">
      <Input
        label="SKU"
        name="sku"
        value={formData.sku}
        onChange={handleChange}
        required
      />
      <Input
        label="Название"
        name="name"
        value={formData.name}
        onChange={handleChange}
        required
      />
      <Input
        label="Описание"
        name="description"
        value={formData.description}
        onChange={handleChange}
        type="textarea"
      />
      <Input
        label="Бренд"
        name="brand"
        value={formData.brand}
        onChange={handleChange}
      />
      <Input
        label="Цена"
        name="price"
        type="number"
        value={formData.price}
        onChange={handleChange}
        required
      />
      <Input
        label="Количество"
        name="quantity"
        type="number"
        value={formData.quantity}
        onChange={handleChange}
      />
      <div className="form-actions">
        <Button type="submit" variant="primary">Сохранить</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Отмена</Button>
      </div>
    </form>
  );
}
```

---

## 🔒 Описание корректной конфигурации CORS

### Backend CORS Configuration

**server/src/config/cors.js:**
```javascript
export const corsOptions = {
  origin: function (origin, callback) {
    // Список разрешенных источников
    const allowedOrigins = [
      process.env.CLIENT_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    ];
    
    // В development разрешаем все источники
    if (process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    // В production проверяем список
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Per-Page'],
  maxAge: 86400 // 24 часа
};
```

**server/src/app.js:**
```javascript
import express from 'express';
import cors from 'cors';
import { corsOptions } from './config/cors.js';

const app = express();

// CORS middleware
app.use(cors(corsOptions));

// Preflight requests
app.options('*', cors(corsOptions));

// ... остальной код
```

### Frontend API Configuration

**client/src/services/api.js:**
```javascript
import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  withCredentials: true // Для отправки cookies (если нужна аутентификация)
});

// Request interceptor
api.interceptors.request.use(
  (config) => {
    // Добавляем токен авторизации, если есть
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Обработка неавторизованного доступа
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
```

---

## 🚀 Рекомендации по запуску и окружению

### Разработка (Development)

**Запуск Backend:**
```bash
cd server
npm install
npm run dev  # или npm run server
# Сервер запустится на http://localhost:3001
```

**Запуск Frontend:**
```bash
cd client
npm install
npm start  # или npm run client
# Приложение откроется на http://localhost:3000
```

### Production

**Backend:**
```bash
cd server
npm install --production
npm start
# Используйте PM2 для управления процессом
pm2 start server.js --name erp-server
```

**Frontend:**
```bash
cd client
npm install
npm run build
# Собранные файлы в client/build/
# Можно раздавать через nginx или другой веб-сервер
```

### Переменные окружения

**server/.env:**
```env
PORT=3001
CLIENT_URL=http://localhost:3000
NODE_ENV=development
```

**client/.env:**
```env
REACT_APP_API_URL=http://localhost:3001/api
```

### Docker (опционально)

**docker-compose.yml:**
```yaml
version: '3.8'

services:
  server:
    build: ./server
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - CLIENT_URL=http://localhost:3000
    volumes:
      - ./server/data:/app/data

  client:
    build: ./client
    ports:
      - "3000:3000"
    environment:
      - REACT_APP_API_URL=http://localhost:3001/api
    depends_on:
      - server
```

---

## ⚠️ Потенциальные риски миграции

### 1. Потеря данных
**Риск:** При копировании данных могут быть ошибки
**Решение:** 
- Создать резервную копию перед миграцией
- Проверить целостность данных после копирования
- Использовать скрипты миграции

### 2. Изменение API
**Риск:** Изменение структуры ответов API
**Решение:**
- Сохранить совместимость API
- Использовать версионирование API (`/api/v1/products`)
- Тестировать все endpoints

### 3. Потеря функциональности
**Риск:** Не все функции могут быть перенесены
**Решение:**
- Создать чек-лист всех функций
- Тестировать каждую функцию после миграции
- Документировать изменения

### 4. Проблемы с CORS
**Риск:** CORS может блокировать запросы
**Решение:**
- Правильно настроить CORS на backend
- Тестировать запросы из браузера
- Использовать прокси в development

### 5. Производительность
**Риск:** Новая архитектура может быть медленнее
**Решение:**
- Оптимизировать запросы к API
- Использовать кэширование
- Мониторить производительность

---

## ✅ Что улучшить после разделения

### 1. База данных
- Миграция с файлового хранилища на PostgreSQL
- Индексы для быстрого поиска
- Транзакции для целостности данных

### 2. Аутентификация
- JWT токены
- Роли и права доступа
- Защита API endpoints

### 3. Тестирование
- Unit тесты для services
- Integration тесты для API
- E2E тесты для React компонентов

### 4. Документация
- Swagger/OpenAPI для API
- Storybook для React компонентов
- README для каждого модуля

### 5. CI/CD
- Автоматические тесты
- Автоматический деплой
- Мониторинг и логирование

### 6. Оптимизация
- Кэширование на backend (Redis)
- Ленивая загрузка на frontend
- Оптимизация bundle size

---

## 📋 Чек-лист готовности проекта

### Backend
- [ ] Все API endpoints работают
- [ ] CORS правильно настроен
- [ ] Обработка ошибок работает
- [ ] Логирование настроено
- [ ] Данные корректно читаются/записываются
- [ ] Все модули (Products, Orders, Warehouses, Suppliers) работают
- [ ] Интеграции с маркетплейсами работают
- [ ] Интеграции с поставщиками работают

### Frontend
- [ ] Все страницы отображаются
- [ ] Навигация работает
- [ ] API запросы работают
- [ ] Формы работают
- [ ] Модальные окна работают
- [ ] Стили применяются корректно
- [ ] Обработка ошибок работает
- [ ] Загрузка данных работает

### Интеграция
- [ ] Backend и Frontend работают вместе
- [ ] CORS не блокирует запросы
- [ ] Данные корректно передаются
- [ ] Ошибки обрабатываются корректно
- [ ] Все функции работают как в старом приложении

### Тестирование
- [ ] Все CRUD операции работают
- [ ] Синхронизация заказов работает
- [ ] Синхронизация остатков работает
- [ ] Интеграции работают
- [ ] Формы валидируются
- [ ] Ошибки обрабатываются

---

## 🎯 Следующие задачи

### Краткосрочные (1-2 недели)
1. Завершить миграцию всех модулей
2. Протестировать все функции
3. Исправить найденные ошибки
4. Оптимизировать производительность

### Среднесрочные (1 месяц)
1. Добавить аутентификацию
2. Добавить тесты
3. Оптимизировать код
4. Добавить документацию

### Долгосрочные (2-3 месяца)
1. Миграция на PostgreSQL
2. Добавление Redis для кэширования
3. Настройка CI/CD
4. Мониторинг и логирование
5. Оптимизация производительности

---

**Документ создан:** 2025-01-20  
**Версия:** 1.0.0

