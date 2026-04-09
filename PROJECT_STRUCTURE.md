# Структура проекта после миграции

## 📁 Созданная структура

```
erp-system/
├── server/                          # Backend (Node.js + Express)
│   ├── src/
│   │   ├── config/                  # Конфигурация
│   │   ├── routes/                  # Маршруты API
│   │   ├── controllers/             # Контроллеры
│   │   ├── services/                # Бизнес-логика
│   │   │   ├── marketplaces/        # Сервисы маркетплейсов
│   │   │   └── suppliers/           # Сервисы поставщиков
│   │   ├── models/                  # Модели данных
│   │   ├── repositories/            # Слой доступа к данным
│   │   ├── middleware/              # Middleware
│   │   └── utils/                   # Утилиты
│   ├── data/                        # Данные (JSON файлы)
│   │   ├── products.json
│   │   ├── orders.json
│   │   ├── warehouses.json
│   │   ├── suppliers.json
│   │   ├── ozon.json
│   │   ├── wildberries.json
│   │   ├── yandex.json
│   │   ├── mikado.json
│   │   ├── moskvorechie.json
│   │   ├── supplierStockCache.json
│   │   ├── wbCategoriesCache.json
│   │   ├── wbCommissionsCache.json
│   │   ├── wbWarehousesCache.json
│   │   ├── categoryMappings.json
│   │   ├── warehouseMappings.json
│   │   └── labels/                  # Этикетки заказов
│   │       ├── ozon/
│   │       ├── wildberries/
│   │       └── yandex/
│   └── [package.json, server.js, .env] (будут созданы)
│
└── client/                          # Frontend (React)
    ├── public/                      # Статические файлы
    └── src/
        ├── components/              # React компоненты
        │   ├── common/              # Общие компоненты
        │   ├── layout/              # Компоненты layout
        │   └── forms/               # Формы
        ├── pages/                   # Страницы приложения
        ├── services/                # API сервисы
        ├── hooks/                   # Custom React Hooks
        ├── contexts/                # React Context
        ├── utils/                   # Утилиты
        └── styles/                  # Стили
```

## ✅ Статус создания

### Server структура
- ✅ `server/src/config/` - Конфигурация
- ✅ `server/src/routes/` - Маршруты API
- ✅ `server/src/controllers/` - Контроллеры
- ✅ `server/src/services/` - Бизнес-логика
  - ✅ `server/src/services/marketplaces/` - Сервисы маркетплейсов
  - ✅ `server/src/services/suppliers/` - Сервисы поставщиков
- ✅ `server/src/models/` - Модели данных
- ✅ `server/src/repositories/` - Слой доступа к данным
- ✅ `server/src/middleware/` - Middleware
- ✅ `server/src/utils/` - Утилиты
- ✅ `server/data/` - Данные (скопированы из старого проекта)

### Client структура
- ✅ `client/public/` - Статические файлы
- ✅ `client/src/components/` - React компоненты
  - ✅ `client/src/components/common/` - Общие компоненты
  - ✅ `client/src/components/layout/` - Компоненты layout
  - ✅ `client/src/components/forms/` - Формы
- ✅ `client/src/pages/` - Страницы приложения
- ✅ `client/src/services/` - API сервисы
- ✅ `client/src/hooks/` - Custom React Hooks
- ✅ `client/src/contexts/` - React Context
- ✅ `client/src/utils/` - Утилиты
- ✅ `client/src/styles/` - Стили

## 📋 Следующие шаги

### Фаза 1 (продолжение)
1. ✅ Создание структуры папок
2. ⏭️ Настройка Backend (package.json, базовые файлы)
3. ⏭️ Настройка Frontend (package.json, базовые файлы)

### Фаза 2: Миграция Backend
- Создание слоя хранилища (Repository)
- Создание сервисов (Service)
- Создание контроллеров (Controller)
- Создание роутов (Routes)

### Фаза 3: Миграция Frontend
- Настройка React приложения
- Создание API сервисов
- Создание компонентов
- Создание страниц

---

**Дата создания:** 2025-11-15  
**Статус:** Структура создана, готово к настройке

