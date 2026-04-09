# ERP System - Модульная архитектура

Система управления товарами, заказами, складами и интеграциями с маркетплейсами.

## 📋 Статус миграции

Проект находится в процессе миграции с монолитной архитектуры на раздельную (Backend + Frontend).

**✅ Завершено:**
- ✅ Структура проекта (server/ + client/)
- ✅ Backend API (модульная архитектура: routes → controllers → services → repositories)
- ✅ Frontend на React (базовые страницы: Товары, Склады, Поставщики, Заказы, Остатки, Интеграции)
- ✅ Миграция модулей: Products, Warehouses, Suppliers, Orders (чтение + синхронизация), Stock Levels, Integrations

**🚧 В разработке:**
- ⏳ Полная миграция всех функций из старого `index.html`
- ⏳ Тестирование всех модулей
- ⏳ Документация API

## 🚀 Быстрый старт

### Предварительные требования

- Node.js 16+ 
- npm или yarn

### Установка и запуск

#### 1. Установка зависимостей

```bash
# Backend
cd server
npm install

# Frontend
cd ../client
npm install
```

#### 2. Настройка окружения

**Backend (`server/.env`):**
```env
PORT=3001
NODE_ENV=development
CLIENT_URL=http://localhost:3000
API_TIMEOUT=30000
LOG_LEVEL=debug
```

**Frontend (`client/.env`):**
```env
REACT_APP_API_URL=http://localhost:3001/api
PORT=3000
```

#### 3. Запуск приложения

**Вариант 1: Запуск в отдельных терминалах**

```bash
# Терминал 1: Backend
cd server
npm run dev

# Терминал 2: Frontend
cd client
npm start
```

**Вариант 2: Использование npm scripts (если настроены)**

```bash
# В корне проекта (если есть package.json с scripts)
npm run dev  # Запустит оба сервера одновременно
```

### Доступ к приложению

- **Frontend:** http://localhost:3000
- **Backend API:** http://localhost:3001/api
- **Health Check:** http://localhost:3001/health

## 📁 Структура проекта

```
.
├── server/                 # Backend (Node.js + Express)
│   ├── src/
│   │   ├── config/        # Конфигурация (CORS, env)
│   │   ├── routes/        # API маршруты
│   │   ├── controllers/   # HTTP контроллеры
│   │   ├── services/      # Бизнес-логика
│   │   ├── repositories/  # Слой доступа к данным
│   │   ├── middleware/    # Express middleware
│   │   └── utils/         # Утилиты (storage, etc.)
│   ├── data/              # JSON файлы с данными
│   ├── server.js          # Точка входа
│   └── package.json
│
├── client/                # Frontend (React)
│   ├── src/
│   │   ├── components/    # React компоненты
│   │   ├── pages/         # Страницы приложения
│   │   ├── services/      # API сервисы (axios)
│   │   ├── hooks/         # Custom React Hooks
│   │   └── App.js         # Главный компонент
│   ├── public/
│   └── package.json
│
├── data/                  # Общие данные (используются обоими проектами)
├── server.js              # Старый монолитный сервер (legacy)
├── index.html             # Старый фронтенд (legacy)
└── README.md              # Этот файл
```

## 🔧 API Endpoints

### Health Check
- `GET /health` - Проверка здоровья сервера

### Products
- `GET /api/products` - Получить все товары
- `POST /api/products` - Создать товар
- `PUT /api/products/:id` - Обновить товар
- `DELETE /api/products/:id` - Удалить товар
- `PUT /api/products/all/replace` - Заменить все товары

### Warehouses
- `GET /api/warehouses` - Получить все склады
- `POST /api/warehouses` - Создать склад
- `PUT /api/warehouses/:id` - Обновить склад
- `DELETE /api/warehouses/:id` - Удалить склад

### Suppliers
- `GET /api/suppliers` - Получить всех поставщиков
- `POST /api/suppliers` - Создать поставщика
- `PUT /api/suppliers/:id` - Обновить поставщика
- `DELETE /api/suppliers/:id` - Удалить поставщика

### Orders
- `GET /api/orders` - Получить все заказы
- `POST /api/orders/sync-fbs` - Синхронизировать FBS заказы (Ozon/WB/YM)
- `POST /api/orders/ozon/:orderId/refresh` - Обновить конкретный заказ Ozon
- `GET /api/orders/:orderId/label` - Получить этикетку заказа
- `GET /api/orders/:orderId/label/status` - Проверить наличие этикетки

### Supplier Stocks
- `GET /api/supplier-stocks?supplier=&sku=&brand=&cities=` - Получить остатки от поставщика
- `POST /api/supplier-stocks/sync` - Синхронизировать остатки всех поставщиков
- `GET /api/supplier-stocks/warehouses?supplier=` - Получить склады поставщика

### Integrations
- `GET /api/integrations/marketplaces/:type` - Получить настройки маркетплейса (ozon/wildberries/yandex)
- `PUT /api/integrations/marketplaces/:type` - Сохранить настройки маркетплейса
- `GET /api/integrations/suppliers/:type` - Получить настройки поставщика (mikado/moskvorechie)
- `PUT /api/integrations/suppliers/:type` - Сохранить настройки поставщика
- `GET /api/integrations/all` - Получить все настройки интеграций

## 📝 Страницы Frontend

- `/` - Главная
- `/products` - Управление товарами
- `/warehouses` - Управление складами
- `/suppliers` - Управление поставщиками
- `/orders` - Управление заказами (с фильтрами и синхронизацией)
- `/stock-levels` - Остатки (основной склад + поставщики)
- `/integrations` - Настройки интеграций (маркетплейсы + поставщики)

## 🔄 Миграция со старой версии

Старый монолитный код находится в:
- `server.js` - старый сервер (legacy)
- `index.html` - старый фронтенд (legacy)

**Рекомендация:** Используйте новый проект (`server/` + `client/`). Старый код сохранён для справки и постепенной миграции.

## 🛠️ Разработка

### Backend

```bash
cd server
npm run dev    # Запуск с автоперезагрузкой (nodemon)
npm start      # Запуск в production режиме
```

### Frontend

```bash
cd client
npm start      # Запуск в режиме разработки (с hot reload)
npm run build  # Сборка для production
```

## 📦 Технологии

**Backend:**
- Node.js + Express.js
- ES Modules (import/export)
- File-based storage (JSON)

**Frontend:**
- React 18
- React Router DOM
- Axios
- CSS Modules

## 📚 Дополнительная документация

- [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) - Детальный план миграции
- [ARCHITECTURE_ANALYSIS.md](./ARCHITECTURE_ANALYSIS.md) - Анализ архитектуры
- [server/README.md](./server/README.md) - Документация Backend
- [client/README.md](./client/README.md) - Документация Frontend

## 🐛 Известные проблемы

- Этикетки заказов: требуется доработка логики загрузки (см. комментарии в коде)
- Некоторые функции из старого `index.html` ещё не мигрированы

## 📄 Лицензия

Проект в разработке.
