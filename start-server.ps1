# PowerShell script для запуска сервера
cd $PSScriptRoot\server
Write-Host "=== ERP SERVER ===" -ForegroundColor Cyan
Write-Host "Запуск на порту 3001..." -ForegroundColor Yellow
node server.js
