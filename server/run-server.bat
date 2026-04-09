@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo   Starting Server
echo ========================================
echo.
node server.js
pause

