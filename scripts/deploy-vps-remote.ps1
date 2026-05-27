# Локальный запуск: деплой на VPS по SSH (нужен доступ root@45.80.68.230).
# Использование: .\scripts\deploy-vps-remote.ps1
# При запросе введите пароль SSH.

$ErrorActionPreference = "Stop"
$HostName = if ($env:ERM_VPS_HOST) { $env:ERM_VPS_HOST } else { "45.80.68.230" }
$User = if ($env:ERM_VPS_USER) { $env:ERM_VPS_USER } else { "root" }
$Remote = "${User}@${HostName}"

Write-Host "Deploy to $Remote ..." -ForegroundColor Cyan
ssh $Remote "bash /opt/erm/scripts/deploy-vps.sh"
