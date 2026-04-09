# 🚀 Быстрый старт после подготовки проекта

## 1. Установка зависимостей

```bash
cd server
npm install
```

## 2. Настройка окружения

Скопируйте `.env.example` в `.env`:

```bash
cp .env.example .env
```

Отредактируйте `.env` файл с вашими настройками:

```env
# Обязательные настройки
NODE_ENV=development
PORT=3001
CLIENT_URL=http://localhost:3000

# База данных PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=erp_system
DB_USER=postgres
DB_PASSWORD=your_password
USE_POSTGRESQL=true
```

## 3. Запуск сервера

### Development режим (с автоперезагрузкой):
```bash
npm run dev
```

### Production режим:
```bash
npm start
```

## 4. Проверка работы

### Health Check:
```bash
curl http://localhost:3001/health
```

### Тесты:
```bash
# Все тесты
npm test

# Только API тесты
npm run test:api

# Тесты в watch режиме
npm run test:watch
```

## 5. Логи

Логи находятся в папке `logs/`:
- `app-YYYY-MM-DD.log` - общие логи
- `error-YYYY-MM-DD.log` - только ошибки
- `exceptions-YYYY-MM-DD.log` - необработанные исключения
- `rejections-YYYY-MM-DD.log` - необработанные rejections

## 6. Структура проекта

```
server/
├── src/
│   ├── config/          # Конфигурация (index.js, database.js)
│   ├── controllers/     # HTTP контроллеры
│   ├── services/        # Бизнес-логика
│   ├── repositories/    # Доступ к данным
│   ├── routes/          # API маршруты
│   ├── middleware/      # Express middleware
│   │   ├── errorHandler.js    # Обработка ошибок
│   │   ├── requestLogger.js   # Логирование запросов
│   │   └── security.js        # Безопасность (Helmet, CORS, Rate Limit)
│   ├── validators/      # Валидаторы запросов (Zod)
│   └── utils/           # Утилиты (logger.js)
├── tests/               # Тесты (Jest + Supertest)
├── logs/                # Логи (автоматически создается)
└── server.js            # Точка входа
```

## 7. Основные endpoints

- `GET /health` - Health check
- `GET /api/products` - Список товаров
- `POST /api/products` - Создать товар (с валидацией)
- `PUT /api/products/:id` - Обновить товар (с валидацией)
- `DELETE /api/products/:id` - Удалить товар
- `GET /api/orders` - Список заказов
- `POST /api/orders/sync-fbs` - Синхронизация заказов (с rate limit)

## 8. Безопасность

- ✅ Helmet - защита от уязвимостей
- ✅ CORS - ограничен только разрешенными доменами
- ✅ Rate Limiting - 100 req/15min (prod), 1000 req/15min (dev)
- ✅ Валидация всех входных данных через Zod
- ✅ Parameterized SQL queries (защита от SQL injection)

## 9. Мониторинг

- Все запросы логируются через Morgan + Winston
- Ошибки логируются в отдельный файл
- Health check endpoint для мониторинга состояния
- Логи БД запросов в development режиме

## 10. Troubleshooting

### Порт уже занят:
```bash
# Windows
netstat -ano | findstr :3001
taskkill /PID <PID> /F

# Linux/Mac
lsof -ti:3001 | xargs kill
```

### База данных не подключается:
1. Проверьте, что PostgreSQL запущен
2. Проверьте настройки в `.env`
3. Проверьте логи: `logs/error-*.log`

### Тесты не проходят:
1. Убедитесь, что сервер не запущен (или используйте другой порт для тестов)
2. Проверьте подключение к БД
3. Запустите `npm run test:system` для диагностики

---

**Готово! Проект полностью подготовлен к разработке.** 🎉
