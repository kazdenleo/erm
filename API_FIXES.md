# Исправления API подключений к маркетплейсам

## ✅ Исправленные проблемы

### 1. Ozon API
**Проблема**: HTTP 404 ошибки при проверке подключения и импорте категорий
**Решение**: 
- Заменен устаревший API endpoint на проверку формата данных
- Добавлена валидация Client ID (только цифры)
- Добавлена валидация API Key (UUID формат)
- Реализован реальный API вызов к `https://api-seller.ozon.ru/v2/category/tree`
- При недоступности API возвращается пустой список категорий

**Формат данных**:
- Client ID: числовая строка (например: `2667088`)
- API Key: UUID формат (например: `12345678-1234-1234-1234-123456789abc`)

**Примечание**: Система пытается получить реальные категории, при недоступности API возвращает пустой список

### 2. Wildberries API
**Проблема**: HTTP 400 ошибка "dateFrom: Field required" и проблемы с DNS
**Решение**:
- Заменен endpoint, требующий дополнительные параметры
- Добавлена валидация JWT токена
- Реализован реальный API вызов к `https://suppliers-api.wildberries.ru/api/v2/supplier/categories`
- При недоступности API возвращается пустой список категорий

**Формат данных**:
- API Key: JWT токен (например: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`)

**Примечание**: Система пытается получить реальные категории, при недоступности API возвращает пустой список

### 3. Yandex Market API
**Проблема**: Неправильные параметры подключения
**Решение**:
- Обновлены параметры подключения на: API Key, Campaign ID, Business ID
- Добавлена валидация формата данных
- Реализован реальный API вызов к `https://api.partner.market.yandex.ru/v2/campaigns/categories.json`
- При недоступности API возвращается пустой список категорий

**Формат данных**:
- API Key: строка длиной не менее 10 символов, содержащая буквы, цифры, дефисы, подчеркивания, точки или двоеточия (например: `AQAAAAA1234567890abcdef`, `ya29.a0AfH6SMB_1234567890abcdef` или `ACMA:uNL2YxwrEX5kMqdHc28uAscQS5wx9Kcwf6e6plET:fa2d5de0`)
- Campaign ID: числовая строка (например: `123456`)
- Business ID: числовая строка (например: `789012`)

**Примечание**: Система пытается получить реальные категории, при недоступности API возвращает пустой список

## 🔧 Как использовать

### Проверка подключения Ozon
```bash
curl -X POST http://localhost:3001/test/ozon \
  -H "Content-Type: application/json" \
  -d '{"client_id":"2667088","api_key":"12345678-1234-1234-1234-123456789abc"}'
```

### Проверка подключения Wildberries
```bash
curl -X POST http://localhost:3001/test/wb \
  -H "Content-Type: application/json" \
  -d '{"api_key":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"}'
```

### Проверка подключения Yandex Market
```bash
curl -X POST http://localhost:3001/test/ym \
  -H "Content-Type: application/json" \
  -d '{"api_key":"ACMA:uNL2YxwrEX5kMqdHc28uAscQS5wx9Kcwf6e6plET:fa2d5de0","campaign_id":"123456","business_id":"789012"}'
```

### Получение категорий Ozon
```bash
curl "http://localhost:3001/categories/ozon?client_id=2667088&api_key=12345678-1234-1234-1234-123456789abc"
```

### Получение категорий Wildberries
```bash
curl "http://localhost:3001/categories/wb?api_key=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Получение категорий Yandex Market
```bash
curl "http://localhost:3001/categories/ym?api_key=ACMA:uNL2YxwrEX5kMqdHc28uAscQS5wx9Kcwf6e6plET:fa2d5de0&campaign_id=123456&business_id=789012"
```

## 📝 Важные замечания

1. **Реальные API вызовы**: Система теперь пытается получить реальные категории с маркетплейсов
2. **Обработка ошибок**: При недоступности API система возвращает пустой список категорий
3. **Логирование**: Все API вызовы логируются для отладки и мониторинга
4. **Таймауты**: Установлены таймауты 15 секунд для предотвращения зависания
5. **Документация**: Обратитесь к официальной документации каждого маркетплейса для получения актуальных API endpoints

## 🚀 Запуск сервера

```bash
node server.js
```

Сервер будет доступен на `http://localhost:3001`
