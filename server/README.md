# ERP System Backend

Backend API для ERP системы с поддержкой PostgreSQL и Redis.

## 🚀 Быстрый старт

### Требования

- Node.js >= 14.0.0
- PostgreSQL >= 12.0
- Redis (опционально, для кэширования)

### Установка

```bash
# Установка зависимостей
npm install

# Настройка переменных окружения
cp .env.example .env
# Отредактируйте .env файл с вашими настройками
```

### Настройка базы данных

```bash
# Создание базы данных
# Windows PowerShell:
.\scripts\create-db.ps1

# Или вручную через psql:
psql -U postgres -f scripts/create-db-simple.sql

# Применение миграций
npm run migrate

# Импорт данных
npm run import
```

### Запуск

```bash
# Запуск сервера
npm start

# Запуск в режиме разработки (с автоперезагрузкой)
npm run dev
```

## 📋 Доступные команды

```bash
# Запуск сервера
npm start              # Запуск production сервера
npm run dev            # Запуск development сервера с nodemon

# Работа с базой данных
npm run migrate        # Применить миграции
npm run migrate:status # Проверить статус миграций
npm run import         # Импортировать данные из JSON файлов

# Тестирование
npm run test           # Тест системы (БД, репозитории, сервисы)
npm run test:api       # Тест API endpoints (требует запущенный сервер)
```

## 🔧 Конфигурация

Основные переменные окружения (`.env`):

```env
# Server
PORT=3001
NODE_ENV=development
CLIENT_URL=http://localhost:3000

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=erp_system
DB_USER=postgres
DB_PASSWORD=your_password

# Redis (опционально)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Использование PostgreSQL (по умолчанию true)
USE_POSTGRESQL=true
```

## 📡 API Endpoints

### Products
- `GET /api/products` - Получить все товары
- `POST /api/products` - Создать товар
- `PUT /api/products/:id` - Обновить товар
- `DELETE /api/products/:id` - Удалить товар

### Orders
- `GET /api/orders` - Получить все заказы
- `POST /api/orders/sync-fbs` - Синхронизация FBS заказов

### Suppliers
- `GET /api/suppliers` - Получить всех поставщиков
- `POST /api/suppliers` - Создать поставщика
- `PUT /api/suppliers/:id` - Обновить поставщика
- `DELETE /api/suppliers/:id` - Удалить поставщика

### Warehouses
- `GET /api/warehouses` - Получить все склады
- `POST /api/warehouses` - Создать склад
- `PUT /api/warehouses/:id` - Обновить склад
- `DELETE /api/warehouses/:id` - Удалить склад

### Supplier Stocks
- `GET /api/supplier-stocks?supplier=&sku=&brand=&cities=` - Получить остатки
- `POST /api/supplier-stocks/sync` - Синхронизация остатков
- `GET /api/supplier-stocks/warehouses?supplier=` - Получить склады поставщика

### Integrations
- `GET /api/integrations/all` - Получить все интеграции
- `GET /api/integrations/marketplaces/:type` - Получить настройки маркетплейса
- `PUT /api/integrations/marketplaces/:type` - Сохранить настройки маркетплейса
- `GET /api/integrations/suppliers/:type` - Получить настройки поставщика
- `PUT /api/integrations/suppliers/:type` - Сохранить настройки поставщика

### Health Check
- `GET /health` - Проверка состояния сервера
- `GET /api/test` - Тестовый endpoint

## 🗄️ Структура базы данных

Система использует PostgreSQL с нормализованной схемой (3NF):

- **products** - Товары
- **orders** - Заказы
- **suppliers** - Поставщики
- **warehouses** - Склады
- **supplier_stocks** - Остатки поставщиков
- **integrations** - Настройки интеграций
- **brands** - Бренды
- **categories** - Категории
- **barcodes** - Штрихкоды товаров
- **product_skus** - SKU товаров для маркетплейсов
- **product_links** - Связи товаров с маркетплейсами

## 🏗️ Архитектура

```
server/
├── src/
│   ├── config/          # Конфигурация (БД, Redis, env)
│   ├── controllers/     # HTTP контроллеры
│   ├── services/        # Бизнес-логика
│   ├── repositories/    # Доступ к данным
│   ├── routes/          # API маршруты
│   ├── middleware/      # Express middleware
│   └── utils/           # Утилиты
├── scripts/
│   ├── migrations/      # SQL миграции
│   ├── import/          # Скрипты импорта данных
│   └── test-*.js        # Тестовые скрипты
└── data/                # JSON файлы (старое хранилище)
```

## 🔄 Миграция данных

Система поддерживает работу как с PostgreSQL, так и со старым файловым хранилищем. Переключение осуществляется через переменную окружения `USE_POSTGRESQL`.

### Импорт данных

```bash
# Импорт всех данных из JSON файлов
npm run import

# Или отдельные импорты:
node scripts/import/01_import_brands.js
node scripts/import/03_import_products.js
# и т.д.
```

## 🧪 Тестирование

```bash
# Тест системы (БД, репозитории, сервисы)
npm run test

# Тест API (требует запущенный сервер)
npm start              # В одном терминале
npm run test:api       # В другом терминале
```

## 📝 Миграции

```bash
# Применить все миграции
npm run migrate

# Проверить статус миграций
npm run migrate:status
```

Миграции находятся в `scripts/migrations/sql/` и применяются автоматически в порядке номеров.

## 🔐 Безопасность

- Все SQL запросы используют параметризованные запросы (защита от SQL injection)
- Подключение к БД через connection pooling
- Переменные окружения для чувствительных данных

## 📊 Производительность

- Connection pooling для PostgreSQL (максимум 20 соединений)
- Многоуровневое кэширование (Redis → PostgreSQL → файловый кэш)
- Индексы на ключевых полях (SKU, barcode, supplier_id, stock_id)

## 🐛 Отладка

Логирование запросов к БД включено в режиме development. Для отключения установите `NODE_ENV=production`.

## 📚 Дополнительная документация

- [План миграции](POSTGRESQL_MIGRATION_PLAN.md)
- [Статус миграции](MIGRATION_STATUS.md)
- [Быстрый старт БД](QUICK_START.md)

## 🤝 Поддержка

При возникновении проблем:

1. Проверьте логи сервера
2. Убедитесь, что PostgreSQL запущен и доступен
3. Проверьте переменные окружения в `.env`
4. Запустите `npm run test` для диагностики

## 📄 Лицензия

ISC
