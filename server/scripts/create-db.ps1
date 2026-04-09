# Простой скрипт для создания базы данных
# Использование: .\scripts\create-db.ps1

Write-Host "=== Создание базы данных erp_system ===" -ForegroundColor Cyan

# Проверка наличия PostgreSQL
$psqlPath = Get-Command psql -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
if (-not $psqlPath) {
    Write-Host "Ошибка: PostgreSQL не найден в PATH!" -ForegroundColor Red
    exit 1
}

Write-Host "PostgreSQL найден: $psqlPath" -ForegroundColor Green

# Запрос пароля
Write-Host "`nВведите пароль для пользователя postgres:" -ForegroundColor Yellow
$password = Read-Host -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
$plainPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
$env:PGPASSWORD = $plainPassword

$DB_NAME = "erp_system"

Write-Host "`nПроверка существования базы данных..." -ForegroundColor Cyan

# Проверка существования базы данных
$dbExists = psql -U postgres -lqt 2>&1 | Select-String -Pattern "^\s*$DB_NAME\s"

if ($dbExists) {
    Write-Host "База данных '$DB_NAME' уже существует!" -ForegroundColor Yellow
    $response = Read-Host "Удалить и пересоздать? (y/N)"
    if ($response -eq "y" -or $response -eq "Y") {
        Write-Host "Удаление базы данных..." -ForegroundColor Yellow
        psql -U postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "База данных удалена" -ForegroundColor Green
        } else {
            Write-Host "Ошибка при удалении базы данных" -ForegroundColor Red
            $env:PGPASSWORD = ""
            exit 1
        }
    } else {
        Write-Host "Пропускаем создание базы данных" -ForegroundColor Green
        $env:PGPASSWORD = ""
        exit 0
    }
}

# Создание базы данных
Write-Host "Создание базы данных '$DB_NAME'..." -ForegroundColor Cyan
$result = psql -U postgres -c "CREATE DATABASE $DB_NAME;" 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✓ База данных '$DB_NAME' успешно создана!" -ForegroundColor Green
    
    # Проверка подключения
    Write-Host "`nПроверка подключения..." -ForegroundColor Cyan
    $testResult = psql -U postgres -d $DB_NAME -c "SELECT current_database(), version();" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Подключение успешно!" -ForegroundColor Green
        Write-Host $testResult
    }
} else {
    Write-Host "`n✗ Ошибка при создании базы данных:" -ForegroundColor Red
    Write-Host $result
    $env:PGPASSWORD = ""
    exit 1
}

# Очистка пароля
$env:PGPASSWORD = ""

Write-Host "`n=== Готово ===" -ForegroundColor Green
Write-Host "База данных '$DB_NAME' готова к использованию!" -ForegroundColor Green
Write-Host "`nНе забудьте обновить файл .env с правильным паролем!" -ForegroundColor Yellow

