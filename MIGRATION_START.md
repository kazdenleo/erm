# 🚀 Начало миграции: Резервное копирование проекта

## Шаг 1: Создание резервной копии

Перед началом миграции **обязательно создайте резервную копию** текущего проекта.

### Вариант 1: Копирование всего проекта (Рекомендуется)

```bash
# Находимся в директории проекта
cd C:\Users\Денис\testCursor

# Создаем резервную копию
# Windows PowerShell
Copy-Item -Path . -Destination ..\testCursor-backup -Recurse -Exclude node_modules

# Или через Git (если используется)
git add .
git commit -m "Backup before migration"
git branch backup-before-migration
```

### Вариант 2: Создание архива

```bash
# Создаем ZIP архив всего проекта (кроме node_modules)
# Windows
Compress-Archive -Path . -DestinationPath ..\testCursor-backup.zip -Exclude node_modules

# Или используйте 7-Zip, WinRAR
```

### Вариант 3: Git Tag (если используете Git)

```bash
git tag -a v1.0.0-before-migration -m "Backup before migration to separated architecture"
git push origin v1.0.0-before-migration
```

## Шаг 2: Проверка резервной копии

Убедитесь, что резервная копия содержит:
- ✅ `server.js`
- ✅ `index.html`
- ✅ `package.json`
- ✅ `data/` (все JSON файлы)
- ✅ Все конфигурационные файлы
- ❌ `node_modules/` (не нужен в копии)

## Шаг 3: Создание новой структуры проекта

После создания резервной копии создаем новую структуру:

```bash
# Создаем структуру папок
mkdir server
mkdir client
mkdir server\src
mkdir server\src\config
mkdir server\src\routes
mkdir server\src\controllers
mkdir server\src\services
mkdir server\src\models
mkdir server\src\repositories
mkdir server\src\middleware
mkdir server\src\utils
mkdir client\src
mkdir client\src\components
mkdir client\src\pages
mkdir client\src\services
mkdir client\src\hooks
mkdir client\src\contexts
mkdir client\src\utils
mkdir client\src\styles
mkdir client\public
```

## Шаг 4: Копирование данных

```bash
# Копируем данные из старого проекта
Copy-Item -Path data -Destination server\data -Recurse
```

## Следующие шаги

После создания резервной копии и структуры проекта, следуйте плану миграции из файла `MIGRATION_PLAN.md`.

### Фазы миграции:

1. **Фаза 1:** Подготовка и настройка окружения (1-2 дня)
2. **Фаза 2:** Миграция Backend (3-5 дней)
3. **Фаза 3:** Миграция Frontend на React (5-7 дней)
4. **Фаза 4:** Интеграция и тестирование (2-3 дня)

## ⚠️ Важные замечания

1. **Не удаляйте старый проект** до полного завершения миграции
2. **Тестируйте каждый шаг** перед переходом к следующему
3. **Сохраняйте резервные копии** на каждом этапе
4. **Документируйте изменения** для отката при необходимости

## 🆘 В случае проблем

Если что-то пошло не так:
1. Остановите миграцию
2. Восстановите проект из резервной копии
3. Проанализируйте проблему
4. Исправьте ошибки
5. Продолжите миграцию

---

**Создано:** 2025-01-20  
**Статус:** Готово к началу миграции

