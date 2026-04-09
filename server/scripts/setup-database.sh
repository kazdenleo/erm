#!/bin/bash
# Скрипт для создания базы данных PostgreSQL (Linux/Mac)
# Использование: bash scripts/setup-database.sh

echo "=== PostgreSQL Database Setup ==="

# Проверка наличия PostgreSQL
if ! command -v psql &> /dev/null; then
    echo "PostgreSQL не найден!"
    echo "Установите PostgreSQL: sudo apt-get install postgresql (Ubuntu/Debian)"
    exit 1
fi

echo "PostgreSQL найден: $(which psql)"

# Параметры подключения
DB_NAME="erp_system"
DB_USER="${DB_USER:-postgres}"

echo ""
read -sp "Введите пароль для пользователя $DB_USER: " DB_PASSWORD
echo ""

export PGPASSWORD="$DB_PASSWORD"

echo "Создание базы данных '$DB_NAME'..."

# Проверка существования базы данных
if psql -U "$DB_USER" -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    echo "База данных '$DB_NAME' уже существует"
    read -p "Удалить и пересоздать? (y/N): " response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        echo "Удаление базы данных..."
        psql -U "$DB_USER" -c "DROP DATABASE IF EXISTS $DB_NAME;"
    else
        echo "Пропускаем создание базы данных"
        unset PGPASSWORD
        exit 0
    fi
fi

# Создание базы данных
if psql -U "$DB_USER" -c "CREATE DATABASE $DB_NAME;"; then
    echo "База данных '$DB_NAME' успешно создана!"
else
    echo "Ошибка при создании базы данных"
    unset PGPASSWORD
    exit 1
fi

unset PGPASSWORD

echo ""
echo "=== Setup завершен ==="
echo "Не забудьте обновить файл .env с правильными параметрами подключения!"

