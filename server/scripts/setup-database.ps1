# Скрипт для создания базы данных PostgreSQL
# Использование: .\scripts\setup-database.ps1

Write-Host "=== PostgreSQL Database Setup ===" -ForegroundColor Cyan

# Проверка наличия PostgreSQL
$psqlPath = Get-Command psql -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source

if (-not $psqlPath) {
    Write-Host "PostgreSQL не найден в PATH!" -ForegroundColor Red
    Write-Host "Пожалуйста, установите PostgreSQL и добавьте его в PATH" -ForegroundColor Yellow
    Write-Host "Скачать можно здесь: https://www.postgresql.org/download/windows/" -ForegroundColor Yellow
    exit 1
}

Write-Host "PostgreSQL найден: $psqlPath" -ForegroundColor Green

# Параметры подключения (можно изменить)
$env:PGHOST = "localhost"
$env:PGPORT = "5432"
$env:PGUSER = "postgres"
$env:PGPASSWORD = Read-Host "Введите пароль для пользователя postgres" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($env:PGPASSWORD)
$env:PGPASSWORD = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)

$DB_NAME = "erp_system"

Write-Host "`nСоздание базы данных '$DB_NAME'..." -ForegroundColor Cyan

# Проверка существования базы данных
$dbExists = psql -U postgres -lqt | Select-String -Pattern "^\s*$DB_NAME\s"

if ($dbExists) {
    Write-Host "База данных '$DB_NAME' уже существует" -ForegroundColor Yellow
    $response = Read-Host "Удалить и пересоздать? (y/N)"
    if ($response -eq "y" -or $response -eq "Y") {
        Write-Host "Удаление базы данных..." -ForegroundColor Yellow
        psql -U postgres -c "DROP DATABASE IF EXISTS $DB_NAME;"
    } else {
        Write-Host "Пропускаем создание базы данных" -ForegroundColor Green
        exit 0
    }
}

# Создание базы данных
$createDbQuery = "CREATE DATABASE $DB_NAME;"
try {
    psql -U postgres -c $createDbQuery
    Write-Host "База данных '$DB_NAME' успешно создана!" -ForegroundColor Green
} catch {
    Write-Host "Ошибка при создании базы данных: $_" -ForegroundColor Red
    exit 1
}

# Очистка пароля из переменных окружения
$env:PGPASSWORD = ""

Write-Host "`n=== Setup завершен ===" -ForegroundColor Green
Write-Host "Не забудьте обновить файл .env с правильными параметрами подключения!" -ForegroundColor Yellow

