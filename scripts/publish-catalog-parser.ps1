# Выкладывает установщик парсера в data/catalog-parser на VPS (или локально).
# Пример:
#   .\scripts\publish-catalog-parser.ps1 -SetupPath "C:\Users\kazde\catalog-scraper\dist\SborshikKatalogov-setup.exe" -Version 1.0.0 -Remote
#   .\scripts\publish-catalog-parser.ps1 -Remote

param(
  [string]$SetupPath = "C:\Users\kazde\catalog-scraper\dist\SborshikKatalogov-setup.exe",
  [string]$Version = "1.0.0",
  [switch]$Remote,
  [string]$RemoteHost = "root@137.22.146.136",
  [string]$RemoteDataDir = "/opt/erm/data/catalog-parser"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SetupPath)) {
  throw "Setup not found: $SetupPath"
}
$size = (Get-Item $SetupPath).Length
if ($size -lt 1000000) {
  throw "File too small ($size), not a valid installer"
}

$metaObj = [ordered]@{
  version = $Version
  updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  fileName = "SborshikKatalogov-setup.exe"
}
$meta = ($metaObj | ConvertTo-Json -Compress)
$metaFile = Join-Path $env:TEMP "erm-catalog-parser-meta.json"
# Без BOM — иначе Node JSON.parse падает на сервере.
[System.IO.File]::WriteAllText($metaFile, $meta + "`n")

Write-Host ("Installer: {0:N1} MB  {1}" -f ($size / 1MB), $SetupPath)

if ($Remote) {
  Write-Host "Uploading to ${RemoteHost}:${RemoteDataDir} ..."
  ssh $RemoteHost "mkdir -p $RemoteDataDir"
  scp -o StrictHostKeyChecking=accept-new $SetupPath "${RemoteHost}:${RemoteDataDir}/SborshikKatalogov-setup.exe"
  scp -o StrictHostKeyChecking=accept-new $metaFile "${RemoteHost}:${RemoteDataDir}/meta.json"
  ssh $RemoteHost "chmod 644 $RemoteDataDir/SborshikKatalogov-setup.exe $RemoteDataDir/meta.json; ls -la $RemoteDataDir"
  Write-Host "Done. Check https://dttrade.ru/api/catalog-parser (auth required)"
} else {
  $repoRoot = Split-Path $PSScriptRoot -Parent
  $dir = Join-Path $repoRoot "data\catalog-parser"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item $SetupPath (Join-Path $dir "SborshikKatalogov-setup.exe") -Force
  Copy-Item $metaFile (Join-Path $dir "meta.json") -Force
  Write-Host "Saved to $dir"
}
