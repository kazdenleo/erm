# Настройка кэширования Wildberries

## Описание

Система кэширования загружает все категории и комиссии Wildberries один раз в день и сохраняет их на сервере. Это решает проблему с ошибкой 429 (Too Many Requests) и ускоряет работу приложения.

## Файлы системы кэширования

- `update-wb-cache.js` - основной скрипт обновления кэша
- `update-wb-cache.bat` - batch файл для Windows Task Scheduler
- `data/wbCategoriesCache.json` - кэш категорий WB
- `data/wbCommissionsCache.json` - кэш комиссий WB

## Настройка автоматического обновления

### Windows Task Scheduler

1. Откройте **Планировщик заданий Windows** (Task Scheduler)
2. Создайте новую задачу:
   - **Имя**: "WB Cache Update"
   - **Триггер**: Ежедневно в 02:00
   - **Действие**: Запуск программы `update-wb-cache.bat`
   - **Рабочая папка**: Путь к папке с приложением

### Linux/Mac Cron

Добавьте в crontab:
```bash
# Обновление кэша WB каждый день в 02:00
0 2 * * * cd /path/to/your/app && node update-wb-cache.js
```

## Ручное обновление кэша

### Через API
```bash
curl -X POST http://localhost:3001/api/wb-cache/refresh
```

### Через скрипт
```bash
node update-wb-cache.js
```

### Через batch файл (Windows)
```cmd
update-wb-cache.bat
```

## Проверка статуса кэша

```bash
curl http://localhost:3001/api/wb-cache/status
```

Ответ:
```json
{
  "data": {
    "categories": {
      "exists": true,
      "size": 7139,
      "lastModified": "2025-01-27T10:30:00.000Z"
    },
    "commissions": {
      "exists": true,
      "size": 7139,
      "lastModified": "2025-01-27T10:30:00.000Z"
    }
  }
}
```

## Логи

Все операции кэширования логируются в консоль сервера с префиксом `[WB Cache]`.

## Преимущества

1. **Нет ошибок 429** - API запросы делаются только один раз в день
2. **Быстрая работа** - данные берутся из локального кэша
3. **Надежность** - приложение работает даже если WB API недоступен
4. **Актуальность** - данные обновляются ежедневно

## Устранение проблем

### Кэш не обновляется
1. Проверьте наличие API ключа WB в `data/wildberries.json`
2. Проверьте права доступа к папке `data/`
3. Запустите ручное обновление: `node update-wb-cache.js`

### Ошибка 429 при обновлении
1. Увеличьте задержки между запросами в `update-wb-cache.js`
2. Запустите обновление в нерабочее время (ночью)

### Приложение не видит кэш
1. Перезапустите сервер
2. Проверьте наличие файлов `wbCategoriesCache.json` и `wbCommissionsCache.json`
3. Проверьте права доступа к файлам кэша
