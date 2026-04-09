# Скрипт для запуска ERP приложения
# Запускает сервер и клиент в отдельных окнах PowerShell

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $scriptPath "server"
$clientPath = Join-Path $scriptPath "client"

Write-Host "Запуск ERP приложения..." -ForegroundColor Green
Write-Host ""

# Запуск сервера в новом окне
Write-Host "Запуск сервера (порт 3001)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$serverPath'; Write-Host 'ERP Server запущен на http://localhost:3001' -ForegroundColor Green; node server.js"

# Небольшая задержка перед запуском клиента
Start-Sleep -Seconds 2

# Запуск клиента в новом окне
Write-Host "Запуск клиента (порт 3000)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$clientPath'; Write-Host 'ERP Client запущен на http://localhost:3000' -ForegroundColor Green; npm start"

Write-Host ""
Write-Host "Приложение запущено!" -ForegroundColor Green
Write-Host "Сервер: http://localhost:3001" -ForegroundColor Cyan
Write-Host "Клиент: http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Окна терминалов должны открыться автоматически." -ForegroundColor Yellow
