# Архитектурный анализ и рекомендации по миграции ERP-системы

## 📋 Резюме

Текущее приложение представляет собой монолитное Node.js/Express решение с файловым хранилищем (JSON), интегрированное с маркетплейсами (Ozon, Wildberries, Yandex Market) и поставщиками (Mikado, Moskvorechie). Система обрабатывает товары, заказы, склады, остатки и синхронизацию данных.

**Ключевые проблемы текущей архитектуры:**
- Файловое хранилище не масштабируется и не обеспечивает ACID-транзакции
- Отсутствие индексов для быстрого поиска
- Нет механизма конкурентного доступа к данным
- Rate limiting хранится в памяти (теряется при перезапуске)
- Отсутствие аутентификации и авторизации
- Нет резервного копирования и восстановления данных
- Сложность горизонтального масштабирования

---

## 🏗️ Варианты архитектуры Backend-сервера

### Вариант 1: Модульный монолит (Рекомендуется для старта)

**Описание:**
Монолитное приложение с четким разделением на модули (layered architecture), готовое к последующему выделению микросервисов.

**Структура:**
```
┌─────────────────────────────────────────┐
│         API Gateway / Router            │
├─────────────────────────────────────────┤
│  Controllers Layer                      │
│  ├─ ProductsController                  │
│  ├─ OrdersController                    │
│  ├─ WarehousesController                │
│  └─ SuppliersController                 │
├─────────────────────────────────────────┤
│  Services Layer                         │
│  ├─ ProductService                      │
│  ├─ OrderService                        │
│  ├─ StockService                        │
│  ├─ MarketplaceSyncService              │
│  └─ SupplierSyncService                 │
├─────────────────────────────────────────┤
│  Repository Layer                       │
│  ├─ ProductRepository                   │
│  ├─ OrderRepository                     │
│  └─ StockRepository                     │
├─────────────────────────────────────────┤
│  Data Access Layer                      │
│  ├─ PostgreSQL (основные данные)        │
│  ├─ Redis (кэш, rate limiting, очереди) │
│  └─ Message Queue (RabbitMQ/Kafka)      │
└─────────────────────────────────────────┘
```

**Преимущества:**
- ✅ Быстрая разработка и деплой
- ✅ Простое тестирование
- ✅ Низкая сложность операций
- ✅ Легкая отладка
- ✅ Готовность к выделению микросервисов

**Недостатки:**
- ⚠️ Ограниченное горизонтальное масштабирование
- ⚠️ Единая точка отказа (при неправильной архитектуре)

**Масштабирование:**
- Вертикальное: увеличение ресурсов сервера
- Горизонтальное: несколько инстансов за load balancer
- Частичное: выделение тяжелых операций (синхронизация) в отдельные воркеры

**API-структура:**
- REST API для CRUD операций
- WebSocket для real-time обновлений (статусы заказов)
- GraphQL опционально для сложных запросов

---

### Вариант 2: Микросервисная архитектура

**Описание:**
Разделение на независимые сервисы с собственными БД и API.

**Структура:**
```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Products   │  │    Orders    │  │   Stock      │
│   Service    │  │   Service    │  │   Service    │
│              │  │              │  │              │
│  PostgreSQL  │  │  PostgreSQL  │  │  PostgreSQL  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
              ┌──────────▼──────────┐
              │   API Gateway       │
              │   (Kong/Tyk)        │
              └──────────┬──────────┘
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
│  Marketplace│  │  Supplier   │  │  Auth       │
│  Sync       │  │  Sync       │  │  Service    │
│  Service    │  │  Service    │  │             │
└─────────────┘  └─────────────┘  └─────────────┘
```

**Преимущества:**
- ✅ Независимое масштабирование сервисов
- ✅ Изоляция отказов
- ✅ Технологическая гибкость
- ✅ Параллельная разработка команд

**Недостатки:**
- ❌ Высокая сложность операций
- ❌ Сложность отладки распределенных транзакций
- ❌ Overhead на межсервисную коммуникацию
- ❌ Требует опытной команды DevOps

**Масштабирование:**
- Горизонтальное масштабирование каждого сервиса независимо
- Auto-scaling на основе метрик

**API-структура:**
- REST API для каждого сервиса
- API Gateway для единой точки входа
- Event-driven архитектура через message queue

**Когда использовать:**
- Команда > 10 разработчиков
- Разные команды работают над разными доменами
- Требуется независимое масштабирование компонентов
- Готовность к высокой сложности операций

---

### Вариант 3: Гибридная архитектура (Монолит + Микросервисы)

**Описание:**
Основное приложение — монолит, тяжелые операции (синхронизация) — микросервисы.

**Структура:**
```
┌─────────────────────────────────────────┐
│         Монолит (Core)                  │
│  Products, Orders, Warehouses, Stock    │
│  PostgreSQL + Redis                     │
└──────────────┬──────────────────────────┘
               │
    ┌──────────┼──────────┐
    │          │          │
┌───▼───┐ ┌───▼───┐ ┌───▼───┐
│ Ozon  │ │  WB   │ │  YM   │
│ Sync  │ │ Sync  │ │ Sync  │
│Worker │ │Worker │ │Worker │
└───────┘ └───────┘ └───────┘
```

**Преимущества:**
- ✅ Баланс между простотой и масштабируемостью
- ✅ Изоляция тяжелых операций
- ✅ Постепенная миграция к микросервисам

**Недостатки:**
- ⚠️ Сложность управления двумя типами сервисов

**Масштабирование:**
- Монолит: вертикальное + несколько инстансов
- Воркеры: горизонтальное масштабирование

---

### Вариант 4: Serverless / FaaS архитектура

**Описание:**
Функции как сервис для обработки запросов и синхронизации.

**Преимущества:**
- ✅ Автоматическое масштабирование
- ✅ Оплата за использование
- ✅ Нет управления инфраструктурой

**Недостатки:**
- ❌ Cold start проблемы
- ❌ Ограничения по времени выполнения
- ❌ Сложность отладки
- ❌ Vendor lock-in

**Рекомендация:** Не подходит для данной задачи из-за необходимости постоянной работы и сложной логики.

---

## 🗄️ Сравнение баз данных

### Таблица сравнения БД

| Критерий | PostgreSQL | MySQL | MongoDB | Redis | Гибрид (PG+Redis) |
|----------|-----------|-------|---------|-------|-------------------|
| **Тип** | Реляционная | Реляционная | Документная | In-Memory | Реляционная + Кэш |
| **ACID транзакции** | ✅ Полная поддержка | ✅ Полная поддержка | ⚠️ Ограниченная (4.0+) | ❌ Нет | ✅ Полная (PG) |
| **Консистентность** | ✅ Строгая | ✅ Строгая | ⚠️ Eventual | ⚠️ Eventual | ✅ Строгая |
| **Сложные запросы** | ✅ Отлично (JOIN, подзапросы) | ✅ Хорошо | ⚠️ Ограничено | ❌ Нет | ✅ Отлично |
| **Связи (Relations)** | ✅ Foreign Keys, JOIN | ✅ Foreign Keys, JOIN | ⚠️ Manual references | ❌ Нет | ✅ Foreign Keys |
| **Производительность (чтение)** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Производительность (запись)** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Масштабирование (вертикальное)** | ✅ Отлично | ✅ Хорошо | ✅ Отлично | ⚠️ Ограничено | ✅ Отлично |
| **Масштабирование (горизонтальное)** | ⚠️ Сложное (репликация) | ⚠️ Сложное | ✅ Sharding | ✅ Cluster | ✅ Комбинированное |
| **Риск потери данных** | ✅ Низкий (WAL, репликация) | ✅ Низкий | ⚠️ Средний | ⚠️ Высокий (in-memory) | ✅ Низкий |
| **Скорость разработки** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| **JSON поддержка** | ✅ JSONB (индексируемый) | ✅ JSON (5.7+) | ✅ Нативно | ✅ Нативно | ✅ JSONB + Redis |
| **Full-text search** | ✅ Встроенный | ✅ Встроенный | ⚠️ Ограниченный | ❌ Нет | ✅ Встроенный |
| **Индексы** | ✅ B-tree, GIN, GiST | ✅ B-tree, Full-text | ✅ Множество типов | ⚠️ Ограничено | ✅ Все типы |
| **Резервное копирование** | ✅ pg_dump, WAL | ✅ mysqldump, binlog | ✅ mongodump | ⚠️ RDB, AOF | ✅ Полное |
| **Стоимость (self-hosted)** | Бесплатно | Бесплатно | Бесплатно | Бесплатно | Бесплатно |
| **Стоимость (managed)** | Средняя | Низкая | Средняя | Низкая | Средняя |

### Детальный анализ по задачам

#### 1. Товары (Products)

**Требования:**
- Сложные связи (категории, бренды, маркетплейсы)
- Полнотекстовый поиск
- Индексация по SKU, артикулам
- История изменений

**Рекомендация:** **PostgreSQL**
- Foreign keys для связей
- JSONB для гибких полей (mp_linked, barcodes)
- GIN индексы для JSONB
- Full-text search для поиска по названиям
- Triggers для аудита

#### 2. Остатки на складе (Stock)

**Требования:**
- Высокая частота обновлений
- Транзакции при списании/приходе
- Консистентность критична
- Агрегации (суммы по складам)

**Рекомендация:** **PostgreSQL + Redis**
- PostgreSQL: основное хранилище с ACID
- Redis: кэш для быстрого чтения остатков
- Транзакции в PostgreSQL для списания
- Инвалидация кэша при обновлении

#### 3. Операции заказов (Orders)

**Требования:**
- Строгая консистентность
- Связи с товарами, клиентами
- История статусов
- Аналитика и отчеты

**Рекомендация:** **PostgreSQL**
- Foreign keys для целостности
- JSONB для метаданных маркетплейсов
- Индексы по статусу, дате, marketplace
- Partitioning по дате для больших объемов

#### 4. Синхронизация с поставщиками

**Требования:**
- Кэширование результатов
- Rate limiting
- Очереди для асинхронной обработки
- Временное хранение данных

**Рекомендация:** **Redis + PostgreSQL**
- Redis: кэш остатков поставщиков, rate limiting
- PostgreSQL: постоянное хранение синхронизированных данных
- RabbitMQ/Kafka: очереди для фоновой синхронизации

#### 5. Пользовательские данные (Auth)

**Требования:**
- Безопасность
- Сессии
- Роли и права

**Рекомендация:** **PostgreSQL + Redis**
- PostgreSQL: пользователи, роли
- Redis: сессии, JWT refresh tokens
- Хеширование паролей (bcrypt)

---

## 🎯 Рекомендация оптимальной БД

### **PostgreSQL + Redis (Гибридная архитектура)**

#### Технические аргументы:

**1. Тип транзакций:**
- **PostgreSQL:** Полная поддержка ACID транзакций
  - Изоляция уровней (READ COMMITTED, REPEATABLE READ, SERIALIZABLE)
  - Multi-row транзакции для списания остатков
  - Rollback при ошибках
- **Redis:** Транзакции через MULTI/EXEC (ограниченные, но достаточные для кэша)

**2. Консистентность данных:**
- **PostgreSQL:** Строгая консистентность через constraints и foreign keys
  - Гарантия целостности связей (товар → заказ → склад)
  - Невозможность удаления товара с активными заказами
- **Redis:** Eventual consistency для кэша (приемлемо)

**3. Поддержка сложных запросов:**
- **PostgreSQL:**
  - JOIN для связей между таблицами
  - Подзапросы и CTE для аналитики
  - Агрегации (SUM, COUNT, GROUP BY) для отчетов
  - Window functions для ранжирования
- **Пример:** Получить остатки товаров по всем складам с информацией о поставщиках:
  ```sql
  SELECT p.sku, p.name, 
         SUM(s.quantity) as total_stock,
         w.address as warehouse
  FROM products p
  LEFT JOIN stock s ON s.product_id = p.id
  LEFT JOIN warehouses w ON w.id = s.warehouse_id
  GROUP BY p.id, w.id;
  ```

**4. Моделирование связей:**
- **PostgreSQL:**
  - Foreign keys для referential integrity
  - One-to-many, many-to-many через junction tables
  - Каскадные обновления/удаления
- **Пример структуры:**
  ```
  products (1) ──< (many) order_items (many) >── (1) orders
  products (1) ──< (many) stock (many) >── (1) warehouses
  warehouses (1) ──< (many) warehouse_suppliers (many) >── (1) suppliers
  ```

**5. Работа под высокой нагрузкой:**
- **PostgreSQL:**
  - Connection pooling (PgBouncer)
  - Индексы для быстрого поиска
  - Материализованные представления для тяжелых запросов
  - Read replicas для масштабирования чтения
- **Redis:**
  - In-memory кэш для горячих данных (остатки, настройки)
  - TTL для автоматической инвалидации
  - Pub/Sub для real-time обновлений

**6. Риск потери данных:**
- **PostgreSQL:**
  - Write-Ahead Logging (WAL) для durability
  - Синхронная/асинхронная репликация
  - Point-in-time recovery
  - Регулярные бэкапы (pg_dump, pg_basebackup)
- **Redis:**
  - RDB snapshots + AOF для persistence
  - Репликация для высокой доступности

**7. Скорость масштабирования:**
- **PostgreSQL:**
  - Вертикальное: увеличение RAM/CPU
  - Горизонтальное: read replicas, partitioning
  - Sharding через внешние решения (Citus)
- **Redis:**
  - Redis Cluster для горизонтального масштабирования
  - Автоматическое распределение данных

#### Почему не другие варианты:

**MongoDB:**
- ❌ Слабая поддержка транзакций (критично для остатков)
- ❌ Нет foreign keys (риск orphaned documents)
- ❌ Сложные JOIN через $lookup (медленно)
- ✅ Подходит для: логов, событий, документов

**MySQL:**
- ⚠️ Слабее JSON поддержка (PostgreSQL JSONB лучше)
- ⚠️ Менее гибкие индексы
- ✅ Альтернатива PostgreSQL, но уступает по возможностям

**Только Redis:**
- ❌ Нет персистентности (риск потери данных)
- ❌ Нет сложных запросов
- ❌ Нет транзакций

---

## 📊 Проектирование структуры данных

### Схема базы данных (PostgreSQL)

#### 1. users
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'user', -- 'admin', 'manager', 'user'
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_login_at TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
```

#### 2. products
```sql
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(500) NOT NULL,
    description TEXT,
    brand VARCHAR(100),
    category_id VARCHAR(100),
    price DECIMAL(10, 2) NOT NULL,
    min_price DECIMAL(10, 2),
    buyout_rate INTEGER DEFAULT 100, -- процент выкупа
    quantity INTEGER DEFAULT 0, -- остаток на основном складе
    unit VARCHAR(20) DEFAULT 'шт',
    
    -- Габариты
    weight INTEGER, -- граммы
    length INTEGER, -- мм
    width INTEGER, -- мм
    height INTEGER, -- мм
    volume DECIMAL(10, 3), -- литры
    
    -- Артикулы маркетплейсов
    sku_ozon VARCHAR(100),
    sku_wb VARCHAR(100),
    sku_ym VARCHAR(100),
    
    -- Связи с маркетплейсами (JSONB для гибкости)
    mp_linked JSONB DEFAULT '{}', -- {"ozon": true, "wb": true}
    
    -- Баркоды (массив)
    barcodes JSONB DEFAULT '[]',
    
    -- Метаданные
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_by UUID REFERENCES users(id)
);

CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_brand ON products(brand);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_mp_linked ON products USING GIN(mp_linked);
CREATE INDEX idx_products_name_fts ON products USING GIN(to_tsvector('russian', name));
```

#### 3. warehouses
```sql
CREATE TABLE warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(50) NOT NULL, -- 'warehouse', 'supplier'
    address VARCHAR(500),
    name VARCHAR(255),
    
    -- Для складов поставщиков
    supplier_id VARCHAR(100), -- ссылка на suppliers.id
    main_warehouse_id UUID REFERENCES warehouses(id), -- связь с основным складом
    
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_warehouses_type ON warehouses(type);
CREATE INDEX idx_warehouses_supplier ON warehouses(supplier_id);
CREATE INDEX idx_warehouses_main ON warehouses(main_warehouse_id);
```

#### 4. stock
```sql
CREATE TABLE stock (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 0,
    
    -- Метаданные
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    
    UNIQUE(product_id, warehouse_id)
);

CREATE INDEX idx_stock_product ON stock(product_id);
CREATE INDEX idx_stock_warehouse ON stock(warehouse_id);
CREATE INDEX idx_stock_quantity ON stock(quantity) WHERE quantity > 0;
```

#### 5. suppliers
```sql
CREATE TABLE suppliers (
    id VARCHAR(100) PRIMARY KEY, -- 'mikado', 'moskvorechie'
    name VARCHAR(255) NOT NULL,
    api_config JSONB DEFAULT '{}', -- настройки API
    warehouses JSONB DEFAULT '[]', -- список складов
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_suppliers_active ON suppliers(is_active);
```

#### 6. orders
```sql
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    marketplace VARCHAR(50) NOT NULL, -- 'ozon', 'wildberries', 'yandex'
    order_id VARCHAR(255) NOT NULL, -- ID заказа на маркетплейсе
    status VARCHAR(50) NOT NULL, -- 'new', 'processing', 'shipped', 'delivered', 'cancelled'
    
    -- Даты
    created_at TIMESTAMP,
    in_process_at TIMESTAMP,
    shipment_date TIMESTAMP,
    delivered_at TIMESTAMP,
    
    -- Клиент
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    delivery_address TEXT,
    
    -- Метаданные маркетплейса (JSONB)
    marketplace_data JSONB DEFAULT '{}',
    
    -- Системные поля
    synced_at TIMESTAMP DEFAULT NOW(),
    created_by_system TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(marketplace, order_id)
);

CREATE INDEX idx_orders_marketplace ON orders(marketplace);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_marketplace_data ON orders USING GIN(marketplace_data);
```

#### 7. order_items
```sql
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    
    -- Данные из маркетплейса
    offer_id VARCHAR(100), -- артикул товара на маркетплейсе
    sku BIGINT, -- SKU маркетплейса
    product_name VARCHAR(500),
    quantity INTEGER NOT NULL DEFAULT 1,
    price DECIMAL(10, 2) NOT NULL,
    
    -- Метаданные
    marketplace_data JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);
CREATE INDEX idx_order_items_offer ON order_items(offer_id);
```

#### 8. supplier_stock_cache (для кэширования остатков поставщиков)
```sql
CREATE TABLE supplier_stock_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id VARCHAR(100) NOT NULL REFERENCES suppliers(id),
    sku VARCHAR(100) NOT NULL,
    brand VARCHAR(100),
    
    -- Данные остатков
    stock_data JSONB NOT NULL, -- {"stock": 10, "price": 227.97, "warehouses": [...]}
    
    -- TTL
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(supplier_id, sku, brand)
);

CREATE INDEX idx_supplier_cache_expires ON supplier_stock_cache(expires_at);
CREATE INDEX idx_supplier_cache_lookup ON supplier_stock_cache(supplier_id, sku);
```

#### 9. sync_logs (логи синхронизации)
```sql
CREATE TABLE sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_type VARCHAR(50) NOT NULL, -- 'orders', 'stock', 'supplier'
    source VARCHAR(100) NOT NULL, -- 'ozon', 'mikado', etc.
    status VARCHAR(50) NOT NULL, -- 'success', 'failed', 'partial'
    records_processed INTEGER DEFAULT 0,
    records_failed INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    duration_ms INTEGER
);

CREATE INDEX idx_sync_logs_type ON sync_logs(sync_type);
CREATE INDEX idx_sync_logs_source ON sync_logs(source);
CREATE INDEX idx_sync_logs_started ON sync_logs(started_at);
```

#### 10. audit_logs (аудит изменений)
```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name VARCHAR(100) NOT NULL,
    record_id UUID NOT NULL,
    action VARCHAR(20) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
    old_data JSONB,
    new_data JSONB,
    user_id UUID REFERENCES users(id),
    ip_address INET,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_table_record ON audit_logs(table_name, record_id);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
```

### Redis структуры

#### Кэширование остатков
```
Key: stock:product:{product_id}:warehouse:{warehouse_id}
Value: {quantity: 10, updated_at: "2025-01-20T10:00:00Z"}
TTL: 300 секунд (5 минут)
```

#### Rate limiting для API маркетплейсов
```
Key: rate_limit:ozon:{user_id}
Value: {count: 5, reset_at: 1642680000}
TTL: 60 секунд
```

#### Кэш остатков поставщиков
```
Key: supplier_stock:{supplier_id}:{sku}:{brand}
Value: {stock: 10, price: 227.97, warehouses: [...]}
TTL: 3600 секунд (1 час)
```

#### Сессии пользователей
```
Key: session:{session_id}
Value: {user_id: "uuid", role: "admin", expires_at: 1642680000}
TTL: 86400 секунд (24 часа)
```

#### Очереди задач синхронизации
```
Queue: sync:orders:ozon
Queue: sync:stock:suppliers
Queue: sync:prices:marketplaces
```

---

## 🏛️ Архитектурные Best Practices

### 1. Архитектурный подход: Layered Architecture

```
┌─────────────────────────────────────┐
│   Presentation Layer (Controllers)  │  ← HTTP запросы, валидация
├─────────────────────────────────────┤
│   Business Logic Layer (Services)   │  ← Бизнес-логика, оркестрация
├─────────────────────────────────────┤
│   Data Access Layer (Repositories)  │  ← Абстракция БД, запросы
├─────────────────────────────────────┤
│   Infrastructure Layer              │  ← БД, внешние API, очереди
└─────────────────────────────────────┘
```

**Преимущества:**
- Разделение ответственности
- Легкое тестирование (моки репозиториев)
- Возможность замены слоев

### 2. Типы слоёв

#### Controllers (Presentation Layer)
```javascript
// controllers/ProductController.js
class ProductController {
  constructor(productService) {
    this.productService = productService;
  }
  
  async getProducts(req, res) {
    try {
      const { page = 1, limit = 50, search } = req.query;
      const products = await this.productService.getProducts({ page, limit, search });
      res.json({ ok: true, data: products });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }
  
  async createProduct(req, res) {
    try {
      const productData = req.body;
      const product = await this.productService.createProduct(productData);
      res.status(201).json({ ok: true, data: product });
    } catch (error) {
      res.status(400).json({ ok: false, message: error.message });
    }
  }
}
```

**Ответственность:**
- Валидация входных данных
- Обработка HTTP запросов/ответов
- Вызов сервисов

#### Services (Business Logic Layer)
```javascript
// services/ProductService.js
class ProductService {
  constructor(productRepository, stockService, cacheService) {
    this.productRepository = productRepository;
    this.stockService = stockService;
    this.cacheService = cacheService;
  }
  
  async getProducts({ page, limit, search }) {
    // Бизнес-логика: проверка кэша, агрегация данных
    const cacheKey = `products:${page}:${limit}:${search}`;
    const cached = await this.cacheService.get(cacheKey);
    if (cached) return cached;
    
    const products = await this.productRepository.find({ page, limit, search });
    
    // Обогащение данными об остатках
    for (const product of products) {
      product.totalStock = await this.stockService.getTotalStock(product.id);
    }
    
    await this.cacheService.set(cacheKey, products, 300); // 5 минут
    return products;
  }
  
  async createProduct(productData) {
    // Валидация бизнес-правил
    if (!productData.sku) {
      throw new Error('SKU обязателен');
    }
    
    // Проверка уникальности
    const existing = await this.productRepository.findBySku(productData.sku);
    if (existing) {
      throw new Error('Товар с таким SKU уже существует');
    }
    
    // Создание товара
    const product = await this.productRepository.create(productData);
    
    // Инвалидация кэша
    await this.cacheService.deletePattern('products:*');
    
    return product;
  }
}
```

**Ответственность:**
- Бизнес-логика и правила
- Оркестрация вызовов репозиториев
- Кэширование
- Транзакции

#### Repositories (Data Access Layer)
```javascript
// repositories/ProductRepository.js
class ProductRepository {
  constructor(db) {
    this.db = db;
  }
  
  async find({ page, limit, search }) {
    let query = this.db('products').select('*');
    
    if (search) {
      query = query.whereRaw(
        "to_tsvector('russian', name) @@ plainto_tsquery('russian', ?)",
        [search]
      );
    }
    
    const offset = (page - 1) * limit;
    return query.limit(limit).offset(offset);
  }
  
  async findBySku(sku) {
    return this.db('products').where({ sku }).first();
  }
  
  async create(productData) {
    const [product] = await this.db('products')
      .insert(productData)
      .returning('*');
    return product;
  }
  
  async update(id, updates) {
    const [product] = await this.db('products')
      .where({ id })
      .update({ ...updates, updated_at: this.db.fn.now() })
      .returning('*');
    return product;
  }
}
```

**Ответственность:**
- Абстракция от БД
- SQL запросы
- Маппинг данных

### 3. Кэширование (Redis)

#### Стратегии кэширования:

**1. Cache-Aside (Lazy Loading)**
```javascript
async getProduct(id) {
  // 1. Проверяем кэш
  const cached = await redis.get(`product:${id}`);
  if (cached) return JSON.parse(cached);
  
  // 2. Загружаем из БД
  const product = await this.repository.findById(id);
  
  // 3. Сохраняем в кэш
  await redis.setex(`product:${id}`, 300, JSON.stringify(product));
  
  return product;
}
```

**2. Write-Through**
```javascript
async updateProduct(id, data) {
  // 1. Обновляем БД
  const product = await this.repository.update(id, data);
  
  // 2. Обновляем кэш
  await redis.setex(`product:${id}`, 300, JSON.stringify(product));
  
  return product;
}
```

**3. Write-Behind (Write-Back)**
```javascript
async updateProduct(id, data) {
  // 1. Обновляем кэш немедленно
  await redis.setex(`product:${id}`, 300, JSON.stringify(data));
  
  // 2. Асинхронно обновляем БД через очередь
  await queue.add('update-product', { id, data });
}
```

**Что кэшировать:**
- ✅ Остатки товаров (TTL: 5 минут)
- ✅ Список товаров с пагинацией (TTL: 5 минут)
- ✅ Остатки поставщиков (TTL: 1 час)
- ✅ Настройки маркетплейсов (TTL: 1 час)
- ✅ Категории (TTL: 24 часа)
- ❌ Не кэшировать: критические операции (списание остатков)

### 4. Очереди сообщений (RabbitMQ / Kafka)

#### RabbitMQ (рекомендуется для начала)

**Использование:**
- Синхронизация заказов с маркетплейсами
- Синхронизация остатков поставщиков
- Отправка уведомлений
- Генерация отчетов

**Архитектура:**
```
Producer → Exchange → Queue → Consumer
```

**Пример:**
```javascript
// producer.js
const amqp = require('amqplib');

async function syncOrders(marketplace) {
  const connection = await amqp.connect('amqp://localhost');
  const channel = await connection.createChannel();
  
  const queue = 'sync-orders';
  await channel.assertQueue(queue, { durable: true });
  
  channel.sendToQueue(queue, Buffer.from(JSON.stringify({
    marketplace,
    timestamp: Date.now()
  })), { persistent: true });
  
  await channel.close();
  await connection.close();
}

// consumer.js
async function startOrderSyncWorker() {
  const connection = await amqp.connect('amqp://localhost');
  const channel = await connection.createChannel();
  
  const queue = 'sync-orders';
  await channel.assertQueue(queue, { durable: true });
  channel.prefetch(1); // Обрабатывать по одному сообщению
  
  channel.consume(queue, async (msg) => {
    const { marketplace } = JSON.parse(msg.content.toString());
    
    try {
      await syncMarketplaceOrders(marketplace);
      channel.ack(msg);
    } catch (error) {
      console.error('Sync failed:', error);
      // Retry или dead letter queue
      channel.nack(msg, false, true); // requeue
    }
  });
}
```

**Kafka (для масштаба)**

**Когда использовать:**
- Высокий объем событий (>100k/сек)
- Требуется replay событий
- Множество потребителей
- Долгосрочное хранение событий

**Пример:**
```javascript
const { Kafka } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'erp-system',
  brokers: ['localhost:9092']
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'order-sync-group' });

// Producer
await producer.send({
  topic: 'orders',
  messages: [{
    key: orderId,
    value: JSON.stringify(orderData)
  }]
});

// Consumer
await consumer.subscribe({ topic: 'orders' });
await consumer.run({
  eachMessage: async ({ topic, partition, message }) => {
    const order = JSON.parse(message.value.toString());
    await processOrder(order);
  }
});
```

### 5. Обработка ошибок

#### Централизованный error handler
```javascript
// middleware/errorHandler.js
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

function errorHandler(err, req, res, next) {
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      ok: false,
      message: err.message
    });
  }
  
  // Логируем неожиданные ошибки
  console.error('Unexpected error:', err);
  
  res.status(500).json({
    ok: false,
    message: 'Внутренняя ошибка сервера'
  });
}

// Использование
app.use(errorHandler);
```

#### Retry механизм
```javascript
async function retryOperation(fn, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(delay * Math.pow(2, i)); // Exponential backoff
    }
  }
}
```

### 6. Безопасность и аутентификация

#### JWT токены
```javascript
// auth/jwt.js
const jwt = require('jsonwebtoken');

function generateTokens(user) {
  const accessToken = jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  
  const refreshToken = jwt.sign(
    { userId: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  
  // Сохраняем refresh token в Redis
  redis.setex(`refresh:${user.id}`, 7 * 24 * 60 * 60, refreshToken);
  
  return { accessToken, refreshToken };
}

// middleware/auth.js
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ ok: false, message: 'Токен не предоставлен' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ ok: false, message: 'Недействительный токен' });
    }
    req.user = user;
    next();
  });
}

// middleware/authorize.js
function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, message: 'Доступ запрещен' });
    }
    next();
  };
}

// Использование
app.get('/api/products', authenticateToken, productController.getProducts);
app.delete('/api/products/:id', authenticateToken, authorize('admin'), productController.deleteProduct);
```

#### Хеширование паролей
```javascript
const bcrypt = require('bcrypt');

async function hashPassword(password) {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}
```

### 7. Работа с большими объёмами данных

#### Пагинация
```javascript
async function getProducts({ page = 1, limit = 50 }) {
  const offset = (page - 1) * limit;
  
  const [products, total] = await Promise.all([
    db('products').limit(limit).offset(offset),
    db('products').count('* as total').first()
  ]);
  
  return {
    data: products,
    pagination: {
      page,
      limit,
      total: parseInt(total.total),
      totalPages: Math.ceil(total.total / limit)
    }
  };
}
```

#### Cursor-based pagination (для больших данных)
```javascript
async function getProducts({ cursor, limit = 50 }) {
  let query = db('products').limit(limit + 1);
  
  if (cursor) {
    query = query.where('id', '>', cursor);
  }
  
  const products = await query.orderBy('id');
  const hasMore = products.length > limit;
  
  if (hasMore) {
    products.pop();
  }
  
  return {
    data: products,
    nextCursor: hasMore ? products[products.length - 1].id : null
  };
}
```

#### Batch processing
```javascript
async function syncAllSupplierStocks(supplierId) {
  const products = await db('products').select('sku', 'brand');
  const batchSize = 100;
  
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    
    await Promise.all(
      batch.map(product => syncSupplierStock(supplierId, product.sku, product.brand))
    );
    
    // Задержка между батчами для rate limiting
    await sleep(1000);
  }
}
```

### 8. Методы оптимизации API

#### 1. Индексы БД
```sql
-- Составные индексы для частых запросов
CREATE INDEX idx_orders_marketplace_status ON orders(marketplace, status);
CREATE INDEX idx_stock_product_warehouse ON stock(product_id, warehouse_id);

-- Частичные индексы
CREATE INDEX idx_active_products ON products(id) WHERE quantity > 0;
```

#### 2. Connection pooling
```javascript
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  database: 'erp',
  user: 'postgres',
  password: 'password',
  max: 20, // максимум соединений
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});
```

#### 3. Query optimization
```javascript
// Плохо: N+1 queries
const orders = await db('orders').select('*');
for (const order of orders) {
  order.items = await db('order_items').where('order_id', order.id);
}

// Хорошо: один запрос с JOIN
const orders = await db('orders')
  .select('orders.*', 'order_items.*')
  .leftJoin('order_items', 'orders.id', 'order_items.order_id');
```

#### 4. Compression
```javascript
const compression = require('compression');
app.use(compression());
```

#### 5. Rate limiting
```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // максимум 100 запросов
  store: new RedisStore({ client: redisClient })
});

app.use('/api/', limiter);
```

---

## 📈 Масштабирование

### Вертикальное масштабирование
- Увеличение RAM для кэша и БД
- Увеличение CPU для обработки запросов
- SSD для быстрого I/O

### Горизонтальное масштабирование

#### 1. Load Balancing
```
                    ┌─────────────┐
                    │ Load Balancer│
                    │  (Nginx)     │
                    └──────┬───────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
   │ App 1   │       │ App 2   │       │ App 3   │
   └────┬────┘       └────┬────┘       └────┬────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                    ┌──────▼──────┐
                    │  PostgreSQL │
                    │  (Primary)  │
                    └─────────────┘
```

#### 2. Read Replicas
```
Primary (Write) ──> Replica 1 (Read)
                 └─> Replica 2 (Read)
                 └─> Replica 3 (Read)
```

#### 3. Database Sharding (для очень больших объемов)
```
Shard 1: products 1-1000000
Shard 2: products 1000001-2000000
Shard 3: products 2000001-3000000
```

#### 4. Caching Layer
```
App ──> Redis Cluster ──> PostgreSQL
```

---

## 🔄 Механизмы синхронизации с поставщиками

### Архитектура синхронизации

```
┌──────────────┐
│   Scheduler  │  (Cron / Bull)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Queue      │  (RabbitMQ)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Workers    │  (синхронизация)
└──────┬───────┘
       │
   ┌───┴───┐
   │       │
   ▼       ▼
┌─────┐ ┌─────┐
│Redis│ │PostgreSQL│
└─────┘ └─────┘
```

### Реализация

#### 1. Планировщик задач (Bull / node-cron)
```javascript
const Bull = require('bull');
const supplierSyncQueue = new Bull('supplier-sync', {
  redis: { host: 'localhost', port: 6379 }
});

// Планирование синхронизации каждые 4 часа
supplierSyncQueue.add('sync-all', {}, {
  repeat: { cron: '0 */4 * * *' } // каждые 4 часа
});

// Обработчик
supplierSyncQueue.process('sync-all', async (job) => {
  const suppliers = await db('suppliers').where('is_active', true);
  
  for (const supplier of suppliers) {
    await syncSupplierStock(supplier.id);
  }
});
```

#### 2. Rate Limiting для API поставщиков
```javascript
async function syncSupplierStock(supplierId, sku, brand) {
  const rateLimitKey = `rate_limit:${supplierId}`;
  const current = await redis.incr(rateLimitKey);
  
  if (current === 1) {
    await redis.expire(rateLimitKey, 60); // окно 60 секунд
  }
  
  if (current > 10) { // максимум 10 запросов в минуту
    throw new Error('Rate limit exceeded');
  }
  
  // Запрос к API поставщика
  const stockData = await fetchSupplierAPI(supplierId, sku, brand);
  
  // Кэширование
  await redis.setex(
    `supplier_stock:${supplierId}:${sku}:${brand}`,
    3600,
    JSON.stringify(stockData)
  );
  
  // Сохранение в БД
  await db('supplier_stock_cache').insert({
    supplier_id: supplierId,
    sku,
    brand,
    stock_data: stockData,
    expires_at: new Date(Date.now() + 3600000)
  }).onConflict(['supplier_id', 'sku', 'brand']).merge();
}
```

#### 3. Обработка ошибок и retry
```javascript
supplierSyncQueue.process('sync-supplier', async (job) => {
  const { supplierId, sku, brand } = job.data;
  
  try {
    await syncSupplierStock(supplierId, sku, brand);
  } catch (error) {
    // Retry с exponential backoff
    if (job.attemptsMade < 3) {
      throw error; // Bull автоматически повторит
    }
    
    // Логируем критическую ошибку
    await db('sync_logs').insert({
      sync_type: 'supplier',
      source: supplierId,
      status: 'failed',
      error_message: error.message
    });
  }
});
```

---

## 📦 Работа со складом и остатками

### Транзакции для списания остатков

```javascript
async function reserveStock(productId, warehouseId, quantity) {
  return db.transaction(async (trx) => {
    // 1. Блокируем строку для обновления (SELECT FOR UPDATE)
    const stock = await trx('stock')
      .where({ product_id: productId, warehouse_id: warehouseId })
      .forUpdate()
      .first();
    
    if (!stock || stock.quantity < quantity) {
      throw new Error('Недостаточно остатков');
    }
    
    // 2. Списываем остатки
    await trx('stock')
      .where({ product_id: productId, warehouse_id: warehouseId })
      .decrement('quantity', quantity);
    
    // 3. Создаем запись о резервировании
    await trx('stock_reservations').insert({
      product_id: productId,
      warehouse_id: warehouseId,
      quantity,
      reserved_at: new Date()
    });
    
    // 4. Инвалидируем кэш
    await redis.del(`stock:product:${productId}:warehouse:${warehouseId}`);
    
    return { success: true };
  });
}
```

### Агрегация остатков

```javascript
async function getTotalStock(productId) {
  // Проверяем кэш
  const cached = await redis.get(`stock:total:${productId}`);
  if (cached) return parseInt(cached);
  
  // Запрос к БД
  const result = await db('stock')
    .where('product_id', productId)
    .sum('quantity as total')
    .first();
  
  const total = parseInt(result.total) || 0;
  
  // Кэшируем на 5 минут
  await redis.setex(`stock:total:${productId}`, 300, total);
  
  return total;
}
```

### Real-time обновления через WebSocket

```javascript
const io = require('socket.io')(server);

io.on('connection', (socket) => {
  socket.on('subscribe:stock', (productId) => {
    socket.join(`stock:${productId}`);
  });
});

// При обновлении остатков
async function updateStock(productId, warehouseId, quantity) {
  await db('stock')
    .where({ product_id: productId, warehouse_id: warehouseId })
    .update({ quantity });
  
  // Отправляем обновление всем подписчикам
  io.to(`stock:${productId}`).emit('stock:updated', {
    productId,
    warehouseId,
    quantity
  });
}
```

---

## ⚠️ Риски и проблемы

### Риски при выборе неправильной БД

#### 1. MongoDB для транзакционных данных
**Проблема:**
- Потеря данных при конкурентных обновлениях остатков
- Нет гарантий ACID для критических операций

**Решение:**
- Использовать PostgreSQL для остатков
- MongoDB только для логов и событий

#### 2. Только Redis для хранения данных
**Проблема:**
- Потеря данных при перезапуске (если не настроен persistence)
- Нет сложных запросов

**Решение:**
- Redis только для кэша и временных данных
- PostgreSQL для постоянного хранения

#### 3. Отсутствие индексов
**Проблема:**
- Медленные запросы при росте данных
- Блокировки таблиц

**Решение:**
- Создавать индексы для частых запросов
- Мониторить slow queries

#### 4. N+1 queries
**Проблема:**
- Множественные запросы к БД
- Высокая нагрузка

**Решение:**
- Использовать JOIN и eager loading
- DataLoader для GraphQL

### Риски архитектуры

#### 1. Монолит без разделения на слои
**Проблема:**
- Сложность тестирования
- Сложность масштабирования

**Решение:**
- Четкое разделение на слои
- Dependency Injection

#### 2. Отсутствие кэширования
**Проблема:**
- Высокая нагрузка на БД
- Медленные ответы API

**Решение:**
- Redis для кэширования
- Стратегии инвалидации

#### 3. Синхронная синхронизация
**Проблема:**
- Блокировка запросов
- Таймауты

**Решение:**
- Асинхронная обработка через очереди
- Background workers

---

## 🚀 Дополнительные улучшения

### 1. Мониторинг и логирование
- **Prometheus + Grafana** для метрик
- **ELK Stack** (Elasticsearch, Logstash, Kibana) для логов
- **Sentry** для отслеживания ошибок

### 2. CI/CD
- **GitHub Actions / GitLab CI** для автоматического деплоя
- Автоматические тесты перед деплоем
- Blue-green deployment

### 3. API версионирование
```
/api/v1/products
/api/v2/products
```

### 4. Документация API
- **Swagger/OpenAPI** для документации
- Автогенерация из кода

### 5. Тестирование
- Unit тесты (Jest)
- Integration тесты
- E2E тесты (Playwright)

---

## 📝 Что стоит сделать на первом шаге

### Фаза 1: Миграция на PostgreSQL (1-2 недели)

1. **Установка и настройка PostgreSQL**
   ```bash
   # Docker
   docker run -d \
     --name postgres \
     -e POSTGRES_PASSWORD=password \
     -e POSTGRES_DB=erp \
     -p 5432:5432 \
     postgres:15
   ```

2. **Создание схемы БД**
   - Создать все таблицы по схеме выше
   - Настроить индексы
   - Настроить constraints

3. **Миграция данных из JSON**
   ```javascript
   // scripts/migrate.js
   const products = JSON.parse(fs.readFileSync('data/products.json'));
   for (const product of products) {
     await db('products').insert({
       id: product.id,
       sku: product.sku,
       name: product.name,
       // ... остальные поля
     });
   }
   ```

4. **Создание Repository слоя**
   - ProductRepository
   - OrderRepository
   - StockRepository

### Фаза 2: Добавление Redis (1 неделя)

1. **Установка Redis**
   ```bash
   docker run -d --name redis -p 6379:6379 redis:7
   ```

2. **Реализация кэширования**
   - Кэш для остатков
   - Кэш для списка товаров
   - Rate limiting

### Фаза 3: Рефакторинг в слои (2-3 недели)

1. **Создание Service слоя**
   - ProductService
   - OrderService
   - StockService

2. **Создание Controller слоя**
   - ProductController
   - OrderController

3. **Добавление валидации**
   - Joi / Yup для валидации

### Фаза 4: Аутентификация (1 неделя)

1. **Реализация JWT**
   - Генерация токенов
   - Middleware для проверки
   - Refresh tokens

2. **Создание таблицы users**
   - Миграция пользователей

### Фаза 5: Очереди (2 недели)

1. **Установка RabbitMQ**
   ```bash
   docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
   ```

2. **Реализация воркеров**
   - Синхронизация заказов
   - Синхронизация остатков поставщиков

### Фаза 6: Мониторинг и оптимизация (ongoing)

1. **Настройка мониторинга**
   - Prometheus
   - Grafana dashboards

2. **Оптимизация запросов**
   - Анализ slow queries
   - Добавление индексов

---

## ✅ Вывод

### Рекомендуемая архитектура:

**Backend:** Модульный монолит (Layered Architecture)
- Готовность к выделению микросервисов
- Простота разработки и деплоя
- Возможность горизонтального масштабирования

**База данных:** PostgreSQL + Redis
- PostgreSQL: основное хранилище с ACID транзакциями
- Redis: кэш, rate limiting, очереди, сессии

**Очереди:** RabbitMQ (для начала)
- Асинхронная синхронизация
- Обработка фоновых задач

**API:** REST + WebSocket
- REST для CRUD операций
- WebSocket для real-time обновлений

### Ключевые преимущества:

1. ✅ **Масштабируемость:** Горизонтальное масштабирование через load balancer и read replicas
2. ✅ **Надежность:** ACID транзакции, репликация, бэкапы
3. ✅ **Производительность:** Кэширование, индексы, connection pooling
4. ✅ **Гибкость:** JSONB для гибких данных, возможность миграции к микросервисам
5. ✅ **Безопасность:** JWT аутентификация, хеширование паролей, rate limiting

### Следующие шаги:

1. Начать с миграции на PostgreSQL
2. Добавить Redis для кэширования
3. Рефакторинг в слоистую архитектуру
4. Внедрить аутентификацию
5. Добавить очереди для синхронизации
6. Настроить мониторинг

---

**Документ подготовлен:** 2025-01-20  
**Версия:** 1.0

