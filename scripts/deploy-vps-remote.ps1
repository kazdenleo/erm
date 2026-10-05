# Локальный запуск: деплой на VPS по SSH (нужен доступ root@45.80.68.230).
# Использование: .\scripts\deploy-vps-remote.ps1
# Деплой запускается на сервере через nohup (лог в /tmp) — обрыв SSH его не прерывает.
# Скрипт читает лог короткими SSH-запросами до строки ERM_DEPLOY_EXIT=<код>.
# Опрос без пароля работает только с SSH-ключом.

$ErrorActionPreference = "Continue"
$HostName = if ($env:ERM_VPS_HOST) { $env:ERM_VPS_HOST } else { "45.80.68.230" }
$User = if ($env:ERM_VPS_USER) { $env:ERM_VPS_USER } else { "root" }
$Remote = "${User}@${HostName}"
$TimeoutMin = if ($env:ERM_DEPLOY_TIMEOUT_MIN) { [int]$env:ERM_DEPLOY_TIMEOUT_MIN } else { 30 }
$LogFile = "/tmp/erm-deploy-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
$SshOpts = @('-o', 'ConnectTimeout=60', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4')

function Invoke-Remote([string]$Command, [switch]$WithStderr) {
  # stderr ssh в опросе лога не нужен: его строки сбили бы счётчик прочитанных строк
  if ($WithStderr) { $out = & ssh @SshOpts -n $Remote $Command 2>&1 }
  else { $out = & ssh @SshOpts -n $Remote $Command 2>$null }
  return @{ Code = $LASTEXITCODE; Lines = @($out | ForEach-Object { "$_" }) }
}

Write-Host "Deploy to $Remote (log: $LogFile) ..." -ForegroundColor Cyan

# В удалённой команде без двойных кавычек: PowerShell 5.1 ломает их при передаче в ssh.
$startCmd = 'cd /opt/erm && nohup setsid bash -c ''bash scripts/deploy-vps.sh; echo ERM_DEPLOY_EXIT=$?'' > {0} 2>&1 < /dev/null & echo ERM_DEPLOY_STARTED' -f $LogFile

$started = $false
for ($i = 1; $i -le 5 -and -not $started; $i++) {
  $r = Invoke-Remote $startCmd -WithStderr
  if ($r.Lines -match 'ERM_DEPLOY_STARTED') {
    $started = $true
  } else {
    Write-Host "Запуск не подтверждён (попытка $i): $($r.Lines -join ' ')" -ForegroundColor Yellow
    # Команда могла дойти до сервера, а ответ потеряться — проверяем лог, чтобы не запустить второй деплой.
    $check = Invoke-Remote "test -f $LogFile && echo ERM_LOG_EXISTS"
    if ($check.Lines -match 'ERM_LOG_EXISTS') { $started = $true; break }
    Start-Sleep -Seconds 10
  }
}
if (-not $started) {
  Write-Host "Не удалось запустить деплой по SSH." -ForegroundColor Red
  exit 1
}

$printed = 0
$exitCode = $null
$deadline = (Get-Date).AddMinutes($TimeoutMin)
while ($null -eq $exitCode -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 10
  $r = Invoke-Remote "tail -n +$($printed + 1) $LogFile"
  if ($r.Code -ne 0) {
    Write-Host "  (SSH недоступен, повтор... код $($r.Code))" -ForegroundColor DarkYellow
    continue
  }
  foreach ($line in $r.Lines) {
    if ($line -match '^ERM_DEPLOY_EXIT=(\d+)') {
      $exitCode = [int]$Matches[1]
    } else {
      Write-Host $line
    }
  }
  $printed += $r.Lines.Count
}

if ($null -eq $exitCode) {
  Write-Host "Нет результата за $TimeoutMin мин. Деплой может ещё идти: ssh $Remote tail -f $LogFile" -ForegroundColor Red
  exit 2
}
if ($exitCode -eq 0) {
  Write-Host "Deploy finished OK" -ForegroundColor Green
} else {
  Write-Host "Deploy failed (exit $exitCode). Лог: ssh $Remote cat $LogFile" -ForegroundColor Red
}
exit $exitCode
