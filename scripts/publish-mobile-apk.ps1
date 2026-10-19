# Выкладывает APK в data/mobile-app на VPS (или локально).
# Пример:
#   .\scripts\publish-mobile-apk.ps1 -ApkPath "$env:TEMP\erm.apk" -Version 1.0.0 -VersionCode 15
#   .\scripts\publish-mobile-apk.ps1 -ApkUrl "https://expo.dev/artifacts/eas/....apk" -VersionCode 15 -Remote

param(
  [string]$ApkPath = "",
  [string]$ApkUrl = "",
  [string]$Version = "1.0.0",
  [int]$VersionCode = 0,
  [switch]$Remote,
  [string]$RemoteHost = "root@45.80.68.230",
  [string]$RemoteDataDir = "/opt/erm/data/mobile-app"
)

$ErrorActionPreference = "Stop"

if (-not $ApkPath -and -not $ApkUrl) {
  throw "Укажите -ApkPath или -ApkUrl"
}

$local = $ApkPath
if ($ApkUrl) {
  $local = Join-Path $env:TEMP "erm-warehouse-publish.apk"
  Write-Host "Downloading $ApkUrl ..."
  curl.exe -sL -m 300 -o $local $ApkUrl
}
if (-not (Test-Path $local)) { throw "APK not found: $local" }
$size = (Get-Item $local).Length
if ($size -lt 1000000) { throw "File too small ($size), not an APK" }

$meta = @{
  version = $Version
  versionCode = $VersionCode
  updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  fileName = "latest.apk"
} | ConvertTo-Json

$metaFile = Join-Path $env:TEMP "erm-mobile-app-meta.json"
Set-Content -Path $metaFile -Value $meta -Encoding utf8

if ($Remote) {
  Write-Host "Uploading to $RemoteHost:$RemoteDataDir ..."
  ssh $RemoteHost "mkdir -p $RemoteDataDir"
  scp -o StrictHostKeyChecking=accept-new $local "${RemoteHost}:${RemoteDataDir}/latest.apk"
  scp -o StrictHostKeyChecking=accept-new $metaFile "${RemoteHost}:${RemoteDataDir}/meta.json"
  ssh $RemoteHost "chmod 644 $RemoteDataDir/latest.apk $RemoteDataDir/meta.json; ls -la $RemoteDataDir"
  Write-Host "Done. Check https://dttrade.ru/api/mobile-app"
} else {
  $repoRoot = Split-Path $PSScriptRoot -Parent
  $dir = Join-Path $repoRoot "data\mobile-app"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item $local (Join-Path $dir "latest.apk") -Force
  Copy-Item $metaFile (Join-Path $dir "meta.json") -Force
  Write-Host "Saved to $dir"
}
