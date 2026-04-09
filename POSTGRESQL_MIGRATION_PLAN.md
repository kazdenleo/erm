# План миграции на PostgreSQL

**Версия:** 1.0.0  
**Дата:** 2025-01-20  
**Автор:** Senior Backend Architect

---

## 📊 1. Анализ текущего состояния данных

### 1.1 Текущая архитектура хранения

**Файловое хранилище (JSON):**
- `products.json` - массив товаров (~120+ записей)
- `orders.json` - объект с массивом заказов (~12,000+ записей)
- `warehouses.json` - массив складов (3 записи)
- `suppliers.json` - массив поставщиков (пустой, но есть конфиги)
- `supplierStockCache.json` - кэш остатков поставщиков (вложенная структура)
- `mikado.json`, `moskvorechie.json` - конфигурации поставщиков
- `ozon.json`, `wildberries.json`, `yandex.json` - конфигурации маркетплейсов
- `categoryMappings.json`, `warehouseMappings.json` - маппинги
- `wbCategoriesCache.json`, `wbCommissionsCache.json`, `wbWarehousesCache.json` - кэши WB

### 1.2 Структура данных

#### Products (Товары)
```json
{
  "id": 1760895284410.328,
  "sku": "AN1048",
  "name": "Фильтр воздушный AN1048",
  "brand": "Nordfil",
  "categoryId": "1760021100890",
  "price": 227.97,
  "minPrice": 100,
  "buyout_rate": 95,
  "barcodes": ["1234567890123"],
  "sku_ozon": "AN1048",
  "sku_wb": "AN1048",
  "sku_ym": "AN1048",
  "mp_linked": { "ozon": true, "wb": true, "ym": true },
  "weight": 310,
  "length": 240,
  "width": 45,
  "height": 296,
  "volume": 3.197,
  "quantity": 1,
  "unit": "шт",
  "description": "...",
  "createdAt": "2025-10-19T17:34:44.410Z",
  "updatedAt": "2025-11-09T18:47:58.579Z"
}
```

#### Orders (Заказы)
```json
{
  "marketplace": "ozon",
  "orderId": "28395815-0193-1",
  "offerId": "AN1179",
  "sku": 2790012542,
  "productName": "...",
  "quantity": 1,
  "price": "914.0000",
  "status": "delivered",
  "createdAt": "",
  "inProcessAt": "2025-10-01T00:54:38Z",
  "shipmentDate": "2025-10-01T18:00:00Z",
  "customerName": "",
  "customerPhone": "",
  "deliveryAddress": ""
}
```

#### Warehouses (Склады)
```json
{
  "id": "1761417295043",
  "type": "warehouse",
  "address": "Электролитный проезд 3а стр.1",
  "supplierId": null,
  "mainWarehouseId": null,
  "createdAt": "2025-10-25T18:34:55.043Z",
  "updatedAt": "2025-10-25T18:34:55.043Z"
}
```

#### Supplier Stock Cache
```json
{
  "mikado": {
    "AN1048": {
      "stock": 10,
      "stockName": "Склад Mikado",
      "deliveryDays": 0,
      "price": 227.97,
      "source": "api",
      "warehouses": [...]
    }
  }
}
```

### 1.3 Проблемы текущей архитектуры

1. **Отсутствие нормализации** - дублирование данных, нет связей
2. **Нет транзакций** - риск потери данных при сбоях
3. **Нет индексов** - медленный поиск по SKU, barcode
4. **Нет целостности данных** - отсутствие внешних ключей
5. **Сложные запросы** - невозможно делать JOIN'ы
6. **Масштабируемость** - файлы растут, производительность падает
7. **Кэширование** - нет эффективного кэширования остатков

---

## 🗄️ 2. Описание будущей схемы БД (ER-диаграмма)

### 2.1 Текстовая ER-диаграмма

```
┌─────────────────┐
│   categories    │
│─────────────────│
│ id (PK)         │
│ name            │
│ marketplace     │
│ parent_id (FK)  │──┐
│ path            │  │
│ created_at      │  │
│ updated_at      │  │
└─────────────────┘  │
                     │
┌─────────────────┐  │
│    products     │  │
│─────────────────│  │
│ id (PK)         │  │
│ sku (UNIQUE)    │  │
│ name            │  │
│ brand_id (FK)   │──┼──┐
│ category_id(FK) │──┘  │
│ price           │     │
│ min_price       │     │
│ buyout_rate     │     │
│ weight          │     │
│ length          │     │
│ width           │     │
│ height          │     │
│ volume          │     │
│ quantity        │     │
│ unit            │     │
│ description     │     │
│ created_at      │     │
│ updated_at      │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│     brands      │     │
│─────────────────│     │
│ id (PK)         │     │
│ name (UNIQUE)   │◄────┘
│ created_at      │
│ updated_at      │
└─────────────────┘

┌─────────────────┐
│   barcodes      │
│─────────────────│
│ id (PK)         │
│ product_id (FK) │──┐
│ barcode (UNIQUE)│  │
│ created_at      │  │
└─────────────────┘  │
                     │
┌─────────────────┐  │
│ product_skus    │  │
│─────────────────│  │
│ id (PK)         │  │
│ product_id (FK) │──┼──┐
│ marketplace     │  │  │
│ sku             │  │  │
│ created_at      │  │  │
└─────────────────┘  │  │
                     │  │
┌─────────────────┐  │  │
│ product_links   │  │  │
│─────────────────│  │  │
│ id (PK)         │  │  │
│ product_id (FK) │──┘  │
│ marketplace     │     │
│ is_linked       │     │
│ created_at      │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│   suppliers     │     │
│─────────────────│     │
│ id (PK)         │     │
│ name (UNIQUE)   │     │
│ code (UNIQUE)   │     │
│ api_config (JSONB)│   │
│ is_active       │     │
│ created_at      │     │
│ updated_at      │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│   warehouses    │     │
│─────────────────│     │
│ id (PK)         │     │
│ type            │     │
│ address         │     │
│ supplier_id(FK) │─────┘
│ main_warehouse_id(FK)│
│ created_at      │
│ updated_at      │
└─────────────────┘

┌─────────────────┐
│ supplier_stocks │
│─────────────────│
│ id (PK)         │
│ supplier_id(FK) │──┐
│ product_id (FK) │──┼──┐
│ stock           │  │  │
│ price           │  │  │
│ delivery_days   │  │  │
│ stock_name      │  │  │
│ source          │  │  │
│ warehouses (JSONB)│  │  │
│ cached_at       │  │  │
│ created_at      │  │  │
│ updated_at      │  │  │
└─────────────────┘  │  │
                     │  │
┌─────────────────┐  │  │
│ supplier_warehouses│ │  │
│─────────────────│  │  │
│ id (PK)         │  │  │
│ supplier_stock_id(FK)│ │
│ city            │  │  │
│ stock           │  │  │
│ price           │  │  │
│ delivery_days   │  │  │
│ created_at      │  │  │
└─────────────────┘  │  │
                     │  │
┌─────────────────┐  │  │
│    orders       │  │  │
│─────────────────│  │  │
│ id (PK)         │  │  │
│ marketplace     │  │  │
│ order_id        │  │  │
│ product_id (FK) │──┘  │
│ offer_id        │     │
│ marketplace_sku │     │
│ product_name    │     │
│ quantity        │     │
│ price           │     │
│ status          │     │
│ customer_name   │     │
│ customer_phone  │     │
│ delivery_address│     │
│ created_at      │     │
│ in_process_at   │     │
│ shipment_date   │     │
│ updated_at      │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│  integrations   │     │
│─────────────────│     │
│ id (PK)         │     │
│ type            │     │
│ name            │     │
│ config (JSONB)  │     │
│ is_active       │     │
│ created_at      │     │
│ updated_at      │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│ category_mappings│    │
│─────────────────│     │
│ id (PK)         │     │
│ product_id (FK) │─────┘
│ marketplace     │
│ category_id     │
│ created_at      │
└─────────────────┘

┌─────────────────┐
│warehouse_mappings│
│─────────────────│
│ id (PK)         │
│ warehouse_id(FK)│──┐
│ marketplace     │  │
│ marketplace_warehouse_id│
│ created_at      │  │
└─────────────────┘  │
                     │
┌─────────────────┐  │
│  cache_entries  │  │
│─────────────────│  │
│ id (PK)         │  │
│ cache_type      │  │
│ cache_key       │  │
│ cache_value (JSONB)│
│ expires_at      │  │
│ created_at      │  │
│ updated_at      │  │
└─────────────────┘  │
```

### 2.2 Основные связи

1. **Products → Brands** (Many-to-One)
2. **Products → Categories** (Many-to-One)
3. **Products → Barcodes** (One-to-Many)
4. **Products → ProductSKUs** (One-to-Many)
5. **Products → ProductLinks** (One-to-Many)
6. **Products → SupplierStocks** (One-to-Many)
7. **Products → Orders** (One-to-Many)
8. **Suppliers → Warehouses** (One-to-Many)
9. **Suppliers → SupplierStocks** (One-to-Many)
10. **Warehouses → WarehouseMappings** (One-to-Many)

---

## 📋 3. Подробная структура таблиц

### 3.1 Таблица `brands` (Бренды)

```sql
CREATE TABLE brands (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_brands_name ON brands(name);
```

**Поля:**
- `id` - первичный ключ
- `name` - название бренда (уникальное)
- `created_at`, `updated_at` - временные метки

### 3.2 Таблица `categories` (Категории)

```sql
CREATE TABLE categories (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    marketplace VARCHAR(50) NOT NULL, -- 'ozon', 'wb', 'ym'
    marketplace_category_id VARCHAR(255),
    parent_id BIGINT REFERENCES categories(id) ON DELETE CASCADE,
    path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_categories_marketplace ON categories(marketplace);
CREATE INDEX idx_categories_parent_id ON categories(parent_id);
CREATE INDEX idx_categories_marketplace_id ON categories(marketplace, marketplace_category_id);
```

**Поля:**
- `id` - первичный ключ
- `name` - название категории
- `marketplace` - маркетплейс
- `marketplace_category_id` - ID категории в маркетплейсе
- `parent_id` - родительская категория (самореференс)
- `path` - полный путь категории

### 3.3 Таблица `products` (Товары)

```sql
CREATE TABLE products (
    id BIGSERIAL PRIMARY KEY,
    sku VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(1000) NOT NULL,
    brand_id BIGINT REFERENCES brands(id) ON DELETE SET NULL,
    category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    price DECIMAL(10, 2) NOT NULL DEFAULT 0,
    min_price DECIMAL(10, 2) DEFAULT 0,
    buyout_rate INTEGER DEFAULT 100,
    weight INTEGER, -- в граммах
    length INTEGER, -- в мм
    width INTEGER,  -- в мм
    height INTEGER, -- в мм
    volume DECIMAL(10, 3), -- в литрах
    quantity INTEGER DEFAULT 1,
    unit VARCHAR(50) DEFAULT 'шт',
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_brand_id ON products(brand_id);
CREATE INDEX idx_products_category_id ON products(category_id);
CREATE INDEX idx_products_name ON products USING gin(to_tsvector('russian', name));
```

**Поля:**
- `id` - первичный ключ
- `sku` - артикул товара (уникальный)
- `name` - название товара
- `brand_id` - ссылка на бренд
- `category_id` - ссылка на категорию
- `price`, `min_price`, `buyout_rate` - цены и ставка выкупа
- `weight`, `length`, `width`, `height`, `volume` - габариты
- `quantity`, `unit` - количество и единица измерения
- `description` - описание

### 3.4 Таблица `barcodes` (Штрихкоды)

```sql
CREATE TABLE barcodes (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    barcode VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_barcodes_product_id ON barcodes(product_id);
CREATE INDEX idx_barcodes_barcode ON barcodes(barcode);
```

**Поля:**
- `id` - первичный ключ
- `product_id` - ссылка на товар
- `barcode` - штрихкод (уникальный)

### 3.5 Таблица `product_skus` (SKU товаров в маркетплейсах)

```sql
CREATE TABLE product_skus (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL, -- 'ozon', 'wb', 'ym'
    sku VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, marketplace)
);

CREATE INDEX idx_product_skus_product_id ON product_skus(product_id);
CREATE INDEX idx_product_skus_marketplace ON product_skus(marketplace);
CREATE INDEX idx_product_skus_sku ON product_skus(marketplace, sku);
```

**Поля:**
- `id` - первичный ключ
- `product_id` - ссылка на товар
- `marketplace` - маркетплейс
- `sku` - SKU в маркетплейсе

### 3.6 Таблица `product_links` (Связи товаров с маркетплейсами)

```sql
CREATE TABLE product_links (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    is_linked BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, marketplace)
);

CREATE INDEX idx_product_links_product_id ON product_links(product_id);
CREATE INDEX idx_product_links_marketplace ON product_links(marketplace);
```

**Поля:**
- `id` - первичный ключ
- `product_id` - ссылка на товар
- `marketplace` - маркетплейс
- `is_linked` - связан ли товар с маркетплейсом

### 3.7 Таблица `suppliers` (Поставщики)

```sql
CREATE TABLE suppliers (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    code VARCHAR(100) NOT NULL UNIQUE, -- 'mikado', 'moskvorechie'
    api_config JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_suppliers_code ON suppliers(code);
CREATE INDEX idx_suppliers_is_active ON suppliers(is_active);
```

**Поля:**
- `id` - первичный ключ
- `name` - название поставщика
- `code` - код поставщика (уникальный)
- `api_config` - конфигурация API (JSONB)
- `is_active` - активен ли поставщик

### 3.8 Таблица `warehouses` (Склады)

```sql
CREATE TABLE warehouses (
    id BIGSERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL, -- 'warehouse', 'supplier'
    address TEXT,
    supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    main_warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_warehouses_type ON warehouses(type);
CREATE INDEX idx_warehouses_supplier_id ON warehouses(supplier_id);
CREATE INDEX idx_warehouses_main_warehouse_id ON warehouses(main_warehouse_id);
```

**Поля:**
- `id` - первичный ключ
- `type` - тип склада
- `address` - адрес
- `supplier_id` - ссылка на поставщика
- `main_warehouse_id` - ссылка на основной склад

### 3.9 Таблица `supplier_stocks` (Остатки поставщиков)

```sql
CREATE TABLE supplier_stocks (
    id BIGSERIAL PRIMARY KEY,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    stock INTEGER NOT NULL DEFAULT 0,
    price DECIMAL(10, 2),
    delivery_days INTEGER DEFAULT 0,
    stock_name VARCHAR(255),
    source VARCHAR(50) DEFAULT 'api', -- 'api', 'cache'
    warehouses JSONB, -- массив складов с остатками
    cached_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(supplier_id, product_id)
);

CREATE INDEX idx_supplier_stocks_supplier_id ON supplier_stocks(supplier_id);
CREATE INDEX idx_supplier_stocks_product_id ON supplier_stocks(product_id);
CREATE INDEX idx_supplier_stocks_sku ON supplier_stocks(supplier_id, product_id);
CREATE INDEX idx_supplier_stocks_cached_at ON supplier_stocks(cached_at);
```

**Поля:**
- `id` - первичный ключ
- `supplier_id` - ссылка на поставщика
- `product_id` - ссылка на товар
- `stock` - остаток
- `price` - цена
- `delivery_days` - срок доставки
- `stock_name` - название склада
- `source` - источник данных
- `warehouses` - JSONB с данными складов
- `cached_at` - время кэширования

### 3.10 Таблица `orders` (Заказы)

```sql
CREATE TABLE orders (
    id BIGSERIAL PRIMARY KEY,
    marketplace VARCHAR(50) NOT NULL, -- 'ozon', 'wb', 'ym'
    order_id VARCHAR(255) NOT NULL,
    product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
    offer_id VARCHAR(255),
    marketplace_sku BIGINT,
    product_name VARCHAR(1000),
    quantity INTEGER NOT NULL DEFAULT 1,
    price DECIMAL(10, 2) NOT NULL,
    status VARCHAR(100),
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    delivery_address TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    in_process_at TIMESTAMP WITH TIME ZONE,
    shipment_date TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(marketplace, order_id)
);

CREATE INDEX idx_orders_marketplace ON orders(marketplace);
CREATE INDEX idx_orders_order_id ON orders(marketplace, order_id);
CREATE INDEX idx_orders_product_id ON orders(product_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
```

**Поля:**
- `id` - первичный ключ
- `marketplace` - маркетплейс
- `order_id` - ID заказа в маркетплейсе
- `product_id` - ссылка на товар
- `offer_id`, `marketplace_sku` - идентификаторы в маркетплейсе
- `product_name` - название товара
- `quantity`, `price` - количество и цена
- `status` - статус заказа
- `customer_name`, `customer_phone`, `delivery_address` - данные клиента
- `created_at`, `in_process_at`, `shipment_date` - даты

### 3.11 Таблица `integrations` (Интеграции)

```sql
CREATE TABLE integrations (
    id BIGSERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL, -- 'marketplace', 'supplier'
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100) NOT NULL UNIQUE, -- 'ozon', 'wb', 'ym', 'mikado', 'moskvorechie'
    config JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_integrations_type ON integrations(type);
CREATE INDEX idx_integrations_code ON integrations(code);
```

**Поля:**
- `id` - первичный ключ
- `type` - тип интеграции
- `name` - название
- `code` - код интеграции
- `config` - конфигурация (JSONB)
- `is_active` - активна ли интеграция

### 3.12 Таблица `category_mappings` (Маппинги категорий)

```sql
CREATE TABLE category_mappings (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    category_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, marketplace)
);

CREATE INDEX idx_category_mappings_product_id ON category_mappings(product_id);
CREATE INDEX idx_category_mappings_marketplace ON category_mappings(marketplace);
```

**Поля:**
- `id` - первичный ключ
- `product_id` - ссылка на товар
- `marketplace` - маркетплейс
- `category_id` - ID категории в маркетплейсе

### 3.13 Таблица `warehouse_mappings` (Маппинги складов)

```sql
CREATE TABLE warehouse_mappings (
    id BIGSERIAL PRIMARY KEY,
    warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    marketplace_warehouse_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(warehouse_id, marketplace)
);

CREATE INDEX idx_warehouse_mappings_warehouse_id ON warehouse_mappings(warehouse_id);
CREATE INDEX idx_warehouse_mappings_marketplace ON warehouse_mappings(marketplace);
```

**Поля:**
- `id` - первичный ключ
- `warehouse_id` - ссылка на склад
- `marketplace` - маркетплейс
- `marketplace_warehouse_id` - ID склада в маркетплейсе

### 3.14 Таблица `cache_entries` (Кэш)

```sql
CREATE TABLE cache_entries (
    id BIGSERIAL PRIMARY KEY,
    cache_type VARCHAR(100) NOT NULL, -- 'wb_categories', 'wb_commissions', 'wb_warehouses'
    cache_key VARCHAR(500) NOT NULL,
    cache_value JSONB NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cache_type, cache_key)
);

CREATE INDEX idx_cache_entries_type ON cache_entries(cache_type);
CREATE INDEX idx_cache_entries_key ON cache_entries(cache_type, cache_key);
CREATE INDEX idx_cache_entries_expires_at ON cache_entries(expires_at);
```

**Поля:**
- `id` - первичный ключ
- `cache_type` - тип кэша
- `cache_key` - ключ кэша
- `cache_value` - значение (JSONB)
- `expires_at` - время истечения

---

## 🔄 4. Создание SQL-миграций

### 4.1 Структура миграций

Создадим систему миграций с версионированием:

```
server/
├── migrations/
│   ├── 001_create_brands.sql
│   ├── 002_create_categories.sql
│   ├── 003_create_products.sql
│   ├── 004_create_barcodes.sql
│   ├── 005_create_product_skus.sql
│   ├── 006_create_product_links.sql
│   ├── 007_create_suppliers.sql
│   ├── 008_create_warehouses.sql
│   ├── 009_create_supplier_stocks.sql
│   ├── 010_create_orders.sql
│   ├── 011_create_integrations.sql
│   ├── 012_create_category_mappings.sql
│   ├── 013_create_warehouse_mappings.sql
│   ├── 014_create_cache_entries.sql
│   ├── 015_create_indexes.sql
│   └── 016_create_triggers.sql
```

### 4.2 Миграция 001: Создание таблицы brands

```sql
-- Migration: 001_create_brands.sql
-- Description: Создание таблицы брендов

BEGIN;

CREATE TABLE IF NOT EXISTS brands (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name);

COMMENT ON TABLE brands IS 'Таблица брендов товаров';
COMMENT ON COLUMN brands.id IS 'Уникальный идентификатор бренда';
COMMENT ON COLUMN brands.name IS 'Название бренда (уникальное)';

COMMIT;
```

### 4.3 Миграция 002: Создание таблицы categories

```sql
-- Migration: 002_create_categories.sql
-- Description: Создание таблицы категорий

BEGIN;

CREATE TABLE IF NOT EXISTS categories (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    marketplace VARCHAR(50) NOT NULL,
    marketplace_category_id VARCHAR(255),
    parent_id BIGINT REFERENCES categories(id) ON DELETE CASCADE,
    path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_categories_marketplace ON categories(marketplace);
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_marketplace_id ON categories(marketplace, marketplace_category_id);

COMMENT ON TABLE categories IS 'Таблица категорий товаров по маркетплейсам';
COMMENT ON COLUMN categories.marketplace IS 'Маркетплейс: ozon, wb, ym';

COMMIT;
```

### 4.4 Миграция 003: Создание таблицы products

```sql
-- Migration: 003_create_products.sql
-- Description: Создание таблицы товаров

BEGIN;

CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY,
    sku VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(1000) NOT NULL,
    brand_id BIGINT REFERENCES brands(id) ON DELETE SET NULL,
    category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    price DECIMAL(10, 2) NOT NULL DEFAULT 0,
    min_price DECIMAL(10, 2) DEFAULT 0,
    buyout_rate INTEGER DEFAULT 100,
    weight INTEGER,
    length INTEGER,
    width INTEGER,
    height INTEGER,
    volume DECIMAL(10, 3),
    quantity INTEGER DEFAULT 1,
    unit VARCHAR(50) DEFAULT 'шт',
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_price CHECK (price >= 0),
    CONSTRAINT chk_min_price CHECK (min_price >= 0),
    CONSTRAINT chk_buyout_rate CHECK (buyout_rate >= 0 AND buyout_rate <= 100)
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);

-- Full-text search index для поиска по названию
CREATE INDEX IF NOT EXISTS idx_products_name_fts ON products USING gin(to_tsvector('russian', name));

COMMENT ON TABLE products IS 'Таблица товаров';
COMMENT ON COLUMN products.sku IS 'Артикул товара (уникальный)';
COMMENT ON COLUMN products.weight IS 'Вес в граммах';
COMMENT ON COLUMN products.length IS 'Длина в мм';
COMMENT ON COLUMN products.width IS 'Ширина в мм';
COMMENT ON COLUMN products.height IS 'Высота в мм';
COMMENT ON COLUMN products.volume IS 'Объем в литрах';

COMMIT;
```

### 4.5 Миграция 004: Создание таблицы barcodes

```sql
-- Migration: 004_create_barcodes.sql
-- Description: Создание таблицы штрихкодов

BEGIN;

CREATE TABLE IF NOT EXISTS barcodes (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    barcode VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_barcodes_product_id ON barcodes(product_id);
CREATE INDEX IF NOT EXISTS idx_barcodes_barcode ON barcodes(barcode);

COMMENT ON TABLE barcodes IS 'Таблица штрихкодов товаров';
COMMENT ON COLUMN barcodes.barcode IS 'Штрихкод (уникальный)';

COMMIT;
```

### 4.6 Миграция 005: Создание таблицы product_skus

```sql
-- Migration: 005_create_product_skus.sql
-- Description: Создание таблицы SKU товаров в маркетплейсах

BEGIN;

CREATE TABLE IF NOT EXISTS product_skus (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    sku VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, marketplace),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_product_skus_product_id ON product_skus(product_id);
CREATE INDEX IF NOT EXISTS idx_product_skus_marketplace ON product_skus(marketplace);
CREATE INDEX IF NOT EXISTS idx_product_skus_sku ON product_skus(marketplace, sku);

COMMENT ON TABLE product_skus IS 'Таблица SKU товаров в маркетплейсах';

COMMIT;
```

### 4.7 Миграция 006: Создание таблицы product_links

```sql
-- Migration: 006_create_product_links.sql
-- Description: Создание таблицы связей товаров с маркетплейсами

BEGIN;

CREATE TABLE IF NOT EXISTS product_links (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    is_linked BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, marketplace),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_product_links_product_id ON product_links(product_id);
CREATE INDEX IF NOT EXISTS idx_product_links_marketplace ON product_links(marketplace);

COMMENT ON TABLE product_links IS 'Таблица связей товаров с маркетплейсами';

COMMIT;
```

### 4.8 Миграция 007: Создание таблицы suppliers

```sql
-- Migration: 007_create_suppliers.sql
-- Description: Создание таблицы поставщиков

BEGIN;

CREATE TABLE IF NOT EXISTS suppliers (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    code VARCHAR(100) NOT NULL UNIQUE,
    api_config JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_suppliers_code ON suppliers(code);
CREATE INDEX IF NOT EXISTS idx_suppliers_is_active ON suppliers(is_active);

COMMENT ON TABLE suppliers IS 'Таблица поставщиков';
COMMENT ON COLUMN suppliers.code IS 'Уникальный код поставщика (mikado, moskvorechie)';
COMMENT ON COLUMN suppliers.api_config IS 'Конфигурация API в формате JSONB';

COMMIT;
```

### 4.9 Миграция 008: Создание таблицы warehouses

```sql
-- Migration: 008_create_warehouses.sql
-- Description: Создание таблицы складов

BEGIN;

CREATE TABLE IF NOT EXISTS warehouses (
    id BIGSERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    address TEXT,
    supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    main_warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_warehouse_type CHECK (type IN ('warehouse', 'supplier'))
);

CREATE INDEX IF NOT EXISTS idx_warehouses_type ON warehouses(type);
CREATE INDEX IF NOT EXISTS idx_warehouses_supplier_id ON warehouses(supplier_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_main_warehouse_id ON warehouses(main_warehouse_id);

COMMENT ON TABLE warehouses IS 'Таблица складов';
COMMENT ON COLUMN warehouses.type IS 'Тип склада: warehouse или supplier';

COMMIT;
```

### 4.10 Миграция 009: Создание таблицы supplier_stocks

```sql
-- Migration: 009_create_supplier_stocks.sql
-- Description: Создание таблицы остатков поставщиков

BEGIN;

CREATE TABLE IF NOT EXISTS supplier_stocks (
    id BIGSERIAL PRIMARY KEY,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    stock INTEGER NOT NULL DEFAULT 0,
    price DECIMAL(10, 2),
    delivery_days INTEGER DEFAULT 0,
    stock_name VARCHAR(255),
    source VARCHAR(50) DEFAULT 'api',
    warehouses JSONB,
    cached_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(supplier_id, product_id),
    CONSTRAINT chk_stock CHECK (stock >= 0),
    CONSTRAINT chk_delivery_days CHECK (delivery_days >= 0),
    CONSTRAINT chk_source CHECK (source IN ('api', 'cache'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_stocks_supplier_id ON supplier_stocks(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_product_id ON supplier_stocks(product_id);
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_sku ON supplier_stocks(supplier_id, product_id);
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_cached_at ON supplier_stocks(cached_at);

COMMENT ON TABLE supplier_stocks IS 'Таблица остатков товаров у поставщиков';
COMMENT ON COLUMN supplier_stocks.warehouses IS 'JSONB массив складов с остатками';
COMMENT ON COLUMN supplier_stocks.source IS 'Источник данных: api или cache';

COMMIT;
```

### 4.11 Миграция 010: Создание таблицы orders

```sql
-- Migration: 010_create_orders.sql
-- Description: Создание таблицы заказов

BEGIN;

CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    marketplace VARCHAR(50) NOT NULL,
    order_id VARCHAR(255) NOT NULL,
    product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
    offer_id VARCHAR(255),
    marketplace_sku BIGINT,
    product_name VARCHAR(1000),
    quantity INTEGER NOT NULL DEFAULT 1,
    price DECIMAL(10, 2) NOT NULL,
    status VARCHAR(100),
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    delivery_address TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    in_process_at TIMESTAMP WITH TIME ZONE,
    shipment_date TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(marketplace, order_id),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym')),
    CONSTRAINT chk_quantity CHECK (quantity > 0),
    CONSTRAINT chk_price CHECK (price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_orders_marketplace ON orders(marketplace);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(marketplace, order_id);
CREATE INDEX IF NOT EXISTS idx_orders_product_id ON orders(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

COMMENT ON TABLE orders IS 'Таблица заказов с маркетплейсов';

COMMIT;
```

### 4.12 Миграция 011: Создание таблицы integrations

```sql
-- Migration: 011_create_integrations.sql
-- Description: Создание таблицы интеграций

BEGIN;

CREATE TABLE IF NOT EXISTS integrations (
    id BIGSERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100) NOT NULL UNIQUE,
    config JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_integration_type CHECK (type IN ('marketplace', 'supplier'))
);

CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(type);
CREATE INDEX IF NOT EXISTS idx_integrations_code ON integrations(code);

COMMENT ON TABLE integrations IS 'Таблица интеграций с маркетплейсами и поставщиками';
COMMENT ON COLUMN integrations.config IS 'Конфигурация интеграции в формате JSONB';

COMMIT;
```

### 4.13 Миграция 012: Создание таблицы category_mappings

```sql
-- Migration: 012_create_category_mappings.sql
-- Description: Создание таблицы маппингов категорий

BEGIN;

CREATE TABLE IF NOT EXISTS category_mappings (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    category_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, marketplace),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_category_mappings_product_id ON category_mappings(product_id);
CREATE INDEX IF NOT EXISTS idx_category_mappings_marketplace ON category_mappings(marketplace);

COMMENT ON TABLE category_mappings IS 'Таблица маппингов категорий товаров по маркетплейсам';

COMMIT;
```

### 4.14 Миграция 013: Создание таблицы warehouse_mappings

```sql
-- Migration: 013_create_warehouse_mappings.sql
-- Description: Создание таблицы маппингов складов

BEGIN;

CREATE TABLE IF NOT EXISTS warehouse_mappings (
    id BIGSERIAL PRIMARY KEY,
    warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    marketplace_warehouse_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(warehouse_id, marketplace),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_warehouse_mappings_warehouse_id ON warehouse_mappings(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_mappings_marketplace ON warehouse_mappings(marketplace);

COMMENT ON TABLE warehouse_mappings IS 'Таблица маппингов складов по маркетплейсам';

COMMIT;
```

### 4.15 Миграция 014: Создание таблицы cache_entries

```sql
-- Migration: 014_create_cache_entries.sql
-- Description: Создание таблицы кэша

BEGIN;

CREATE TABLE IF NOT EXISTS cache_entries (
    id BIGSERIAL PRIMARY KEY,
    cache_type VARCHAR(100) NOT NULL,
    cache_key VARCHAR(500) NOT NULL,
    cache_value JSONB NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cache_type, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_cache_entries_type ON cache_entries(cache_type);
CREATE INDEX IF NOT EXISTS idx_cache_entries_key ON cache_entries(cache_type, cache_key);
CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at ON cache_entries(expires_at);

COMMENT ON TABLE cache_entries IS 'Таблица кэша для различных типов данных';
COMMENT ON COLUMN cache_entries.cache_type IS 'Тип кэша: wb_categories, wb_commissions, wb_warehouses и т.д.';

COMMIT;
```

### 4.16 Миграция 015: Дополнительные индексы

```sql
-- Migration: 015_create_additional_indexes.sql
-- Description: Создание дополнительных индексов для оптимизации

BEGIN;

-- Составные индексы для частых запросов
CREATE INDEX IF NOT EXISTS idx_products_brand_category ON products(brand_id, category_id);
CREATE INDEX IF NOT EXISTS idx_orders_marketplace_status ON orders(marketplace, status);
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_stock ON supplier_stocks(stock) WHERE stock > 0;
CREATE INDEX IF NOT EXISTS idx_orders_date_range ON orders(created_at) WHERE created_at IS NOT NULL;

-- Индексы для JSONB полей (GIN индексы)
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_warehouses ON supplier_stocks USING gin(warehouses);
CREATE INDEX IF NOT EXISTS idx_integrations_config ON integrations USING gin(config);
CREATE INDEX IF NOT EXISTS idx_cache_entries_value ON cache_entries USING gin(cache_value);

COMMIT;
```

### 4.17 Миграция 016: Триггеры для updated_at

```sql
-- Migration: 016_create_triggers.sql
-- Description: Создание триггеров для автоматического обновления updated_at

BEGIN;

-- Функция для обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Триггеры для всех таблиц с updated_at
CREATE TRIGGER update_brands_updated_at BEFORE UPDATE ON brands
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_product_links_updated_at BEFORE UPDATE ON product_links
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_suppliers_updated_at BEFORE UPDATE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_warehouses_updated_at BEFORE UPDATE ON warehouses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_supplier_stocks_updated_at BEFORE UPDATE ON supplier_stocks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_integrations_updated_at BEFORE UPDATE ON integrations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_cache_entries_updated_at BEFORE UPDATE ON cache_entries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
```

---

## 📥 5. Скрипты импорта старых данных

### 5.1 Структура скриптов импорта

```
server/
├── scripts/
│   ├── import/
│   │   ├── 01_import_brands.js
│   │   ├── 02_import_categories.js
│   │   ├── 03_import_products.js
│   │   ├── 04_import_barcodes.js
│   │   ├── 05_import_product_skus.js
│   │   ├── 06_import_product_links.js
│   │   ├── 07_import_suppliers.js
│   │   ├── 08_import_warehouses.js
│   │   ├── 09_import_supplier_stocks.js
│   │   ├── 10_import_orders.js
│   │   ├── 11_import_integrations.js
│   │   ├── 12_import_category_mappings.js
│   │   ├── 13_import_warehouse_mappings.js
│   │   ├── 14_import_cache.js
│   │   └── import_all.js
```

### 5.2 Базовый скрипт импорта (пример для products)

Скрипты будут созданы в следующих шагах.

---

## 🔧 6. Пример репозиториев и сервисов для работы с PostgreSQL

### 6.1 Подключение к PostgreSQL

Создадим модуль для работы с БД.

---

## 🔧 6. Пример репозиториев и сервисов для работы с PostgreSQL

### 6.1 Подключение к PostgreSQL

Создан модуль `server/src/config/database.js` с пулом соединений и функциями для работы с транзакциями.

### 6.2 Пример репозитория (ProductsRepositoryPG)

Создан файл `server/src/repositories/products.repository.pg.js` с полной реализацией CRUD операций для товаров.

**Основные методы:**
- `findAll(options)` - получение всех товаров с фильтрацией и пагинацией
- `findById(id)` - получение товара по ID
- `findBySku(sku)` - получение товара по SKU
- `findByIdWithDetails(id)` - получение товара со всеми связанными данными
- `create(productData)` - создание товара с транзакцией
- `update(id, updates)` - обновление товара
- `delete(id)` - удаление товара
- `count(options)` - подсчет товаров

### 6.3 Переключение между хранилищами

Для плавного перехода можно использовать паттерн адаптера:

```javascript
// server/src/repositories/products.repository.js
import productsRepositoryPG from './products.repository.pg.js';
import productsRepositoryFile from './products.repository.file.js';

const USE_POSTGRESQL = process.env.USE_POSTGRESQL === 'true';

export default USE_POSTGRESQL ? productsRepositoryPG : productsRepositoryFile;
```

---

## 🔌 7. Рекомендации по подключению PG к Express

### 7.1 Инициализация подключения при старте приложения

```javascript
// server/src/app.js
import { testConnection } from './config/database.js';

// Проверка подключения при старте
testConnection().then(connected => {
  if (!connected) {
    console.error('[App] Database connection failed. Exiting...');
    process.exit(1);
  }
  console.log('[App] Database connected successfully');
});
```

### 7.2 Middleware для обработки ошибок БД

```javascript
// server/src/middleware/dbErrorHandler.js
export function dbErrorHandler(err, req, res, next) {
  if (err.code === '23505') { // Unique violation
    return res.status(409).json({
      ok: false,
      message: 'Запись с такими данными уже существует'
    });
  }
  
  if (err.code === '23503') { // Foreign key violation
    return res.status(400).json({
      ok: false,
      message: 'Нарушение целостности данных'
    });
  }
  
  if (err.code === '23502') { // Not null violation
    return res.status(400).json({
      ok: false,
      message: 'Обязательное поле не заполнено'
    });
  }
  
  next(err);
}
```

### 7.3 Graceful shutdown

```javascript
// server/server.js
import { closePool } from './src/config/database.js';

process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received, closing connections...');
  await closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT received, closing connections...');
  await closePool();
  process.exit(0);
});
```

---

## 🚀 8. Рекомендации по Redis и кэшированию

### 8.1 Установка и настройка Redis

```bash
# Установка Redis (Ubuntu/Debian)
sudo apt-get install redis-server

# Запуск Redis
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

### 8.2 Конфигурация Redis клиента

```javascript
// server/src/config/redis.js
import { createClient } from 'redis';
import config from './env.js';

const redisClient = createClient({
  socket: {
    host: config.redisHost,
    port: config.redisPort
  },
  password: config.redisPassword || undefined
});

redisClient.on('error', (err) => {
  console.error('[Redis] Error:', err);
});

redisClient.on('connect', () => {
  console.log('[Redis] Connected');
});

// Подключение
await redisClient.connect();

export default redisClient;
```

### 8.3 Сервис кэширования

```javascript
// server/src/services/cache.service.js
import redisClient from '../config/redis.js';

class CacheService {
  // Получить значение из кэша
  async get(key) {
    try {
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error('[Cache] Get error:', error);
      return null;
    }
  }
  
  // Установить значение в кэш
  async set(key, value, ttl = 3600) {
    try {
      await redisClient.setEx(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('[Cache] Set error:', error);
      return false;
    }
  }
  
  // Удалить значение из кэша
  async delete(key) {
    try {
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error('[Cache] Delete error:', error);
      return false;
    }
  }
  
  // Удалить все ключи по паттерну
  async deletePattern(pattern) {
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
      return true;
    } catch (error) {
      console.error('[Cache] Delete pattern error:', error);
      return false;
    }
  }
  
  // Кэш остатков поставщиков
  async cacheSupplierStock(supplier, sku, stockData, ttl = 1800) {
    const key = `supplier_stock:${supplier}:${sku}`;
    return await this.set(key, stockData, ttl);
  }
  
  async getSupplierStock(supplier, sku) {
    const key = `supplier_stock:${supplier}:${sku}`;
    return await this.get(key);
  }
  
  // Кэш категорий маркетплейсов
  async cacheMarketplaceCategories(marketplace, categories, ttl = 86400) {
    const key = `marketplace_categories:${marketplace}`;
    return await this.set(key, categories, ttl);
  }
  
  async getMarketplaceCategories(marketplace) {
    const key = `marketplace_categories:${marketplace}`;
    return await this.get(key);
  }
}

export default new CacheService();
```

### 8.4 Использование кэша в сервисах

```javascript
// server/src/services/supplierStocks.service.js
import cacheService from './cache.service.js';

async getSupplierStock({ supplier, sku, brand, cities }) {
  // Проверяем кэш
  const cacheKey = `supplier_stock:${supplier}:${sku}`;
  const cached = await cacheService.get(cacheKey);
  
  if (cached) {
    console.log('[SupplierStock] Cache hit');
    return cached;
  }
  
  // Получаем из API
  const stockData = await this.fetchFromAPI(supplier, sku, brand);
  
  // Кэшируем на 30 минут
  await cacheService.set(cacheKey, stockData, 1800);
  
  return stockData;
}
```

### 8.5 Инвалидация кэша

```javascript
// При обновлении товара
async updateProduct(id, updates) {
  const product = await productsRepository.update(id, updates);
  
  // Инвалидируем кэш остатков для этого товара
  await cacheService.deletePattern(`supplier_stock:*:${product.sku}`);
  
  return product;
}
```

---

## 🏗️ 9. Архитектура next-stage (модули, сервисы, слои)

### 9.1 Модульная архитектура

```
server/
├── src/
│   ├── modules/
│   │   ├── products/
│   │   │   ├── products.controller.js
│   │   │   ├── products.service.js
│   │   │   ├── products.repository.js
│   │   │   └── products.routes.js
│   │   ├── orders/
│   │   ├── suppliers/
│   │   └── warehouses/
│   ├── shared/
│   │   ├── database/
│   │   ├── cache/
│   │   ├── queue/
│   │   └── events/
│   └── infrastructure/
│       ├── logging/
│       ├── monitoring/
│       └── health/
```

### 9.2 Event-driven архитектура (опционально)

```javascript
// server/src/shared/events/eventEmitter.js
import { EventEmitter } from 'events';

class AppEventEmitter extends EventEmitter {
  emitProductCreated(product) {
    this.emit('product:created', product);
  }
  
  emitProductUpdated(product) {
    this.emit('product:updated', product);
  }
  
  emitOrderCreated(order) {
    this.emit('order:created', order);
  }
}

export default new AppEventEmitter();

// Использование
// server/src/services/products.service.js
import eventEmitter from '../shared/events/eventEmitter.js';

async createProduct(productData) {
  const product = await productsRepository.create(productData);
  eventEmitter.emitProductCreated(product);
  return product;
}

// Обработчики событий
// server/src/shared/events/handlers.js
import eventEmitter from './eventEmitter.js';
import cacheService from '../../services/cache.service.js';

eventEmitter.on('product:updated', async (product) => {
  // Инвалидируем кэш
  await cacheService.deletePattern(`supplier_stock:*:${product.sku}`);
  
  // Обновляем индексы поиска
  // await searchService.reindex(product);
});
```

### 9.3 Очередь задач (Bull/BullMQ)

```javascript
// server/src/shared/queue/queue.js
import { Queue } from 'bullmq';
import config from '../../config/env.js';

export const stockSyncQueue = new Queue('stock-sync', {
  connection: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword
  }
});

// Добавление задачи
await stockSyncQueue.add('sync-supplier-stocks', {
  supplier: 'mikado',
  products: [...]
}, {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000
  }
});

// Обработчик задач
// server/src/workers/stockSync.worker.js
import { Worker } from 'bullmq';
import supplierStocksService from '../services/supplierStocks.service.js';

const worker = new Worker('stock-sync', async (job) => {
  const { supplier, products } = job.data;
  return await supplierStocksService.syncSupplierStocks(products);
}, {
  connection: {
    host: config.redisHost,
    port: config.redisPort
  }
});
```

### 9.4 Микросервисная архитектура (будущее)

```
┌─────────────┐
│   API Gateway   │
└──────┬──────┘
       │
   ┌───┴───┬──────────┬──────────┐
   │       │          │          │
┌──▼──┐ ┌──▼──┐  ┌───▼───┐  ┌───▼───┐
│Products│ │Orders│ │Suppliers│ │Marketplaces│
│Service │ │Service│ │ Service │ │  Service  │
└───┬───┘ └───┬──┘  └────┬────┘  └─────┬────┘
    │         │          │              │
    └─────────┴──────────┴──────────────┘
                    │
            ┌───────▼───────┐
            │   PostgreSQL  │
            │   + Redis     │
            └───────────────┘
```

---

## ⚡ 10. Оптимизация нагрузки и масштабирование

### 10.1 Индексы для оптимизации

- **B-tree индексы** для точных поисков (SKU, ID)
- **GIN индексы** для JSONB полей и full-text search
- **Составные индексы** для частых комбинаций фильтров
- **Частичные индексы** для условий WHERE

### 10.2 Партиционирование таблиц

```sql
-- Партиционирование таблицы orders по дате
CREATE TABLE orders (
    ...
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2025_01 PARTITION OF orders
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE orders_2025_02 PARTITION OF orders
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
```

### 10.3 Репликация PostgreSQL

```sql
-- Настройка репликации (master-slave)
-- Master: запись
-- Replica: чтение
```

### 10.4 Connection pooling

```javascript
// Использование PgBouncer для пула соединений
const pool = new Pool({
  host: 'pgbouncer-host',
  port: 6432, // PgBouncer порт
  // ...
});
```

### 10.5 Read replicas для чтения

```javascript
// server/src/config/database.js
const readPool = new Pool({
  host: config.dbReadReplicaHost,
  // ...
});

const writePool = new Pool({
  host: config.dbHost,
  // ...
});

export async function queryRead(text, params) {
  return await readPool.query(text, params);
}

export async function queryWrite(text, params) {
  return await writePool.query(text, params);
}
```

### 10.6 Шардирование (горизонтальное масштабирование)

Для очень больших объемов данных можно использовать:
- **Citus** (PostgreSQL extension для шардирования)
- **Партиционирование по supplier_id** для supplier_stocks
- **Партиционирование по marketplace** для orders

---

## ✅ 11. Чек-лист успешной миграции

### 11.1 Подготовка

- [ ] Создана резервная копия всех JSON файлов
- [ ] Установлен и настроен PostgreSQL
- [ ] Создана база данных `erp_system`
- [ ] Настроены переменные окружения (.env)
- [ ] Установлены зависимости (`npm install`)

### 11.2 Миграции

- [ ] Все миграции созданы и протестированы
- [ ] Миграции применены (`npm run migrate`)
- [ ] Проверен статус миграций (`npm run migrate:status`)
- [ ] Созданы все индексы
- [ ] Созданы все триггеры

### 11.3 Импорт данных

- [ ] Импортированы бренды
- [ ] Импортированы категории (если есть)
- [ ] Импортированы товары
- [ ] Импортированы штрихкоды
- [ ] Импортированы SKU маркетплейсов
- [ ] Импортированы связи товаров
- [ ] Импортированы поставщики
- [ ] Импортированы склады
- [ ] Импортированы остатки поставщиков
- [ ] Импортированы заказы
- [ ] Импортированы интеграции
- [ ] Импортированы маппинги
- [ ] Импортирован кэш

### 11.4 Проверка данных

- [ ] Проверено количество записей в каждой таблице
- [ ] Проверена целостность внешних ключей
- [ ] Проверены уникальные ограничения
- [ ] Проверены индексы (EXPLAIN ANALYZE)
- [ ] Проверены триггеры (обновление updated_at)

### 11.5 Тестирование API

- [ ] GET /api/products - получение товаров
- [ ] POST /api/products - создание товара
- [ ] PUT /api/products/:id - обновление товара
- [ ] DELETE /api/products/:id - удаление товара
- [ ] GET /api/orders - получение заказов
- [ ] GET /api/suppliers - получение поставщиков
- [ ] GET /api/supplier-stocks - получение остатков
- [ ] Все endpoints работают корректно

### 11.6 Производительность

- [ ] Запросы выполняются быстро (< 100ms для простых)
- [ ] Нет N+1 проблем в запросах
- [ ] Используются индексы (проверено через EXPLAIN)
- [ ] Настроен connection pooling
- [ ] Настроен Redis для кэширования

### 11.7 Мониторинг

- [ ] Настроено логирование запросов к БД
- [ ] Настроен мониторинг производительности
- [ ] Настроены алерты на ошибки БД
- [ ] Настроен мониторинг размера БД

### 11.8 Документация

- [ ] Документирована схема БД
- [ ] Документированы миграции
- [ ] Документированы скрипты импорта
- [ ] Создан README с инструкциями

### 11.9 Откат (если нужно)

- [ ] Создан план отката
- [ ] Сохранены резервные копии
- [ ] Протестирован процесс отката

---

## 📚 12. Дополнительные ресурсы

### 12.1 Полезные команды PostgreSQL

```sql
-- Проверка размера таблиц
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Проверка индексов
SELECT 
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;

-- Анализ запроса
EXPLAIN ANALYZE SELECT * FROM products WHERE sku = 'AN1048';

-- Очистка кэша
VACUUM ANALYZE;
```

### 12.2 Мониторинг производительности

```sql
-- Активные запросы
SELECT pid, now() - pg_stat_activity.query_start AS duration, query 
FROM pg_stat_activity 
WHERE state = 'active';

-- Статистика таблиц
SELECT * FROM pg_stat_user_tables;

-- Статистика индексов
SELECT * FROM pg_stat_user_indexes;
```

---

## 🎯 Заключение

Данный план миграции обеспечивает:

1. **Безопасность данных** - транзакции, резервные копии, откат
2. **Производительность** - индексы, кэширование, оптимизация запросов
3. **Масштабируемость** - партиционирование, репликация, шардирование
4. **Надежность** - целостность данных, внешние ключи, проверки
5. **Расширяемость** - модульная архитектура, event-driven, очереди

**Следующие шаги:**
1. Применить миграции
2. Импортировать данные
3. Протестировать API
4. Настроить Redis
5. Настроить мониторинг
6. Постепенно переключать сервисы на PostgreSQL

**Версия документа:** 1.0.0  
**Дата обновления:** 2025-01-20

