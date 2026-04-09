# Скрипт для перезапуска сервера с закрытием старых окон

Write-Host "Stopping all Node.js processes..." -ForegroundColor Yellow
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "Starting ERP Server..." -ForegroundColor Green
$serverPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$serverPath'; Write-Host 'ERP Server - ' -NoNewline; Get-Date -Format 'yyyy-MM-dd HH:mm:ss'; Write-Host ''; node server.js"

Write-Host "Server restart initiated. Check the new PowerShell window." -ForegroundColor Cyan

