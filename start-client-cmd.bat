@echo off
title ERP Client (port 3000)
cd /d "%~dp0client"
echo Starting ERP client at http://localhost:3000 ...
echo.
cmd /c "npm start"
pause
