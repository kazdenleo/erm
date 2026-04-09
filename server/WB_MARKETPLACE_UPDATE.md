# Обновление категорий и комиссий Wildberries

## Описание

Система автоматически обновляет категории и комиссии Wildberries каждый день в 1:00 ночи (по московскому времени). Данные сохраняются в базе данных PostgreSQL.

## Компоненты системы

### 1. Миграция базы данных

**Файл:** `server/scripts/migrations/sql/020_create_wb_commissions.sql`

Создает таблицу `wb_commissions` для хранения комиссий WB по категориям.

**Применение миграции:**
```bash
cd server
npm run migrate
```

### 2. Сервис обновления

**Файл:** `server/src/services/wbMarketplace.service.js`

Сервис для:
- Загрузки категорий WB из API (`https://content-api.wildberries.ru/content/v2/object/all`)
- Загрузки комиссий WB из API (`https://common-api.wildberries.ru/api/v1/tariffs/commission`)
- Сохранения данных в БД

### 3. Планировщик задач

**Файл:** `server/src/services/scheduler.service.js`

Автоматически запускает обновление каждый день в 1:00 ночи (МСК).

**Использует:**
- `node-cron` для планирования (если установлен)
- Fallback на `setTimeout` если `node-cron` недоступен

### 4. API Endpoints

**Файл:** `server/src/routes/wbMarketplace.routes.js`

#### POST `/api/wb-marketplace/update`
Ручной запуск обновления категорий и комиссий.

**Пример:**
```bash
curl -X POST http://localhost:3001/api/wb-marketplace/update
```

#### GET `/api/wb-marketplace/commissions`
Получить все комиссии WB.

**Пример:**
```bash
curl http://localhost:3001/api/wb-marketplace/commissions
```

#### GET `/api/wb-marketplace/commissions/:categoryId`
Получить комиссию по ID категории.

**Пример:**
```bash
curl http://localhost:3001/api/wb-marketplace/commissions/12345
```

#### GET `/api/wb-marketplace/scheduler/status`
Получить статус планировщика задач.

**Пример:**
```bash
curl http://localhost:3001/api/wb-marketplace/scheduler/status
```

### 5. Скрипт для ручного запуска

**Файл:** `update-wb-cache.js`

Скрипт для ручного запуска обновления (можно использовать в cron или Task Scheduler).

**Использование:**
```bash
node update-wb-cache.js
```

## Структура данных

### Таблица `wb_commissions`

| Поле | Тип | Описание |
|------|-----|----------|
| id | BIGSERIAL | Первичный ключ |
| category_id | INTEGER | ID категории WB |
| category_name | VARCHAR(500) | Название категории |
| commission_percent | DECIMAL(5,2) | Процент комиссии |
| min_price | DECIMAL(10,2) | Минимальная цена |
| max_price | DECIMAL(10,2) | Максимальная цена |
| delivery_percent | DECIMAL(5,2) | Процент доставки |
| return_percent | DECIMAL(5,2) | Процент возврата |
| raw_data | JSONB | Полные данные из API |
| created_at | TIMESTAMP | Дата создания |
| updated_at | TIMESTAMP | Дата обновления |

### Таблица `categories`

Категории WB сохраняются в таблицу `categories` с `marketplace = 'wb'`.

## Настройка

1. **Применить миграцию:**
   ```bash
   cd server
   npm run migrate
   ```

2. **Настроить API ключ WB:**
   - Перейти в раздел "Интеграции" → "Маркетплейсы" → "Wildberries"
   - Ввести API ключ

3. **Планировщик запускается автоматически** при старте сервера (если PostgreSQL включен)

## Ручной запуск обновления

### Через API:
```bash
curl -X POST http://localhost:3001/api/wb-marketplace/update
```

### Через скрипт:
```bash
node update-wb-cache.js
```

## Логирование

Все операции логируются через Winston logger:
- Успешные операции: `logger.info`
- Ошибки: `logger.error`
- Отладочная информация: `logger.debug`

Логи сохраняются в `server/logs/`.

## Примечания

- Обновление происходит автоматически каждый день в 1:00 ночи (МСК)
- Данные сохраняются в БД, а не в JSON файлы
- При обновлении категории обновляются, а не удаляются и создаются заново
- Комиссии обновляются по `category_id` (UNIQUE constraint)

