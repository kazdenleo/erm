@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "dist\erm-print-helper.exe" (
  start "" "dist\erm-print-helper.exe"
) else (
  echo Соберите exe: npm install && npm run build:exe
  echo Затем запустите dist\erm-print-helper.exe
  pause
)
