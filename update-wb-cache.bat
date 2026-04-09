@echo off
REM Batch файл для обновления кэша Wildberries
REM Запускается через Windows Task Scheduler

echo [WB Cache Update] Starting cache update at %date% %time%

cd /d "%~dp0"

REM Проверяем наличие Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [WB Cache Update] Node.js not found. Please install Node.js first.
    exit /b 1
)

REM Запускаем обновление кэша
node update-wb-cache.js

if errorlevel 1 (
    echo [WB Cache Update] Cache update failed
    exit /b 1
) else (
    echo [WB Cache Update] Cache update completed successfully
    exit /b 0
)
