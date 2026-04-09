# Инструкция по миграции на PostgreSQL

## Шаг 1: Подготовка

### 1.1 Резервная копия данных

Резервная копия JSON файлов создана в `server/data_backup/`

### 1.2 Установка PostgreSQL

**Windows:**
1. Скачайте PostgreSQL с официального сайта: https://www.postgresql.org/download/windows/
2. Установите PostgreSQL (запомните пароль для пользователя postgres)
3. Добавьте PostgreSQL в PATH (обычно это делается автоматически)

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install postgresql postgresql-contrib
```

**Mac:**
```bash
brew install postgresql
brew services start postgresql
```

### 1.3 Создание базы данных

**Windows (PowerShell):**
```powershell
cd server
.\scripts\setup-database.ps1
```

**Linux/Mac:**
```bash
cd server
bash scripts/setup-database.sh
```

**Или вручную:**
```bash
# Подключитесь к PostgreSQL
psql -U postgres

# Создайте базу данных
CREATE DATABASE erp_system;

# Выйдите
\q
```

### 1.4 Настройка переменных окружения

1. Скопируйте `.env.example` в `.env`:
   ```bash
   cp .env.example .env
   ```

2. Отредактируйте `.env` и укажите правильные параметры:
   ```env
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=erp_system
   DB_USER=postgres
   DB_PASSWORD=ваш_пароль
   ```

### 1.5 Установка зависимостей

```bash
cd server
npm install
```

## Шаг 2: Применение миграций

```bash
cd server
npm run migrate
```

Проверка статуса миграций:
```bash
npm run migrate:status
```

## Шаг 3: Импорт данных

```bash
cd server
npm run import
```

## Шаг 4: Проверка

1. Проверьте подключение к БД:
   ```bash
   psql -U postgres -d erp_system -c "SELECT COUNT(*) FROM products;"
   ```

2. Запустите сервер:
   ```bash
   npm run dev
   ```

3. Проверьте API:
   ```bash
   curl http://localhost:3001/api/products
   ```

## Устранение проблем

### Ошибка подключения к БД

1. Проверьте, запущен ли PostgreSQL:
   - Windows: Проверьте службу "postgresql-x64-XX"
   - Linux: `sudo systemctl status postgresql`
   - Mac: `brew services list`

2. Проверьте параметры в `.env`

3. Проверьте права доступа пользователя:
   ```sql
   GRANT ALL PRIVILEGES ON DATABASE erp_system TO postgres;
   ```

### Ошибки миграций

Если миграция не применилась:
1. Проверьте логи ошибок
2. Убедитесь, что база данных пустая или используйте `DROP DATABASE` и создайте заново
3. Проверьте права пользователя

### Ошибки импорта

1. Убедитесь, что миграции применены
2. Проверьте формат JSON файлов
3. Проверьте логи импорта

## Откат изменений

Если нужно откатить миграцию:

1. Удалите базу данных:
   ```sql
   DROP DATABASE erp_system;
   ```

2. Восстановите данные из резервной копии:
   ```bash
   cp -r data_backup/*.json data/
   ```

3. Переключите приложение обратно на файловое хранилище (если настроено)

