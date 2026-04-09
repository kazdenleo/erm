@echo off
echo Updating WB Warehouses Cache...
cd /d "%~dp0"
node update-wb-warehouses-cache.js
echo WB Warehouses Cache update completed.
pause
