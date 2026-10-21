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
  Remove-Item $local -ErrorAction SilentlyContinue
  # Через cmd.exe: иначе PowerShell режет URL по «&» в signed CDN redirect → SignatureDoesNotMatch / битый файл.
  # Без короткого -m: обрыв даёт ZIP без central directory, Android пишет «пакет повреждён».
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    $have = 0
    if (Test-Path $local) { $have = (Get-Item $local).Length }
    Write-Host "download attempt $attempt have=$have"
    $cmd = "curl.exe -L --retry 5 --retry-all-errors --connect-timeout 30 -C - -o `"$local`" `"$ApkUrl`""
    cmd.exe /c $cmd
    if (-not (Test-Path $local)) { continue }
    $have = (Get-Item $local).Length
    if ($have -lt 50000) {
      Remove-Item $local -Force -ErrorAction SilentlyContinue
      continue
    }
    # Проверка ZIP — если ок, выходим; если обрезан — докачиваем дальше.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try {
      $zip = [System.IO.Compression.ZipFile]::OpenRead($local)
      $entries = $zip.Entries.Count
      $hasManifest = $false
      foreach ($e in $zip.Entries) {
        if ($e.FullName -eq 'AndroidManifest.xml') { $hasManifest = $true; break }
      }
      $zip.Dispose()
      if ($entries -ge 10 -and $hasManifest) {
        Write-Host "APK ZIP OK mid-check: $entries entries, $([math]::Round($have/1MB,1)) MB"
        break
      }
    } catch {
      Write-Host "ZIP incomplete, will resume: $($_.Exception.Message)"
    }
  }
  if (-not (Test-Path $local)) { throw "curl download failed" }
}
if (-not (Test-Path $local)) { throw "APK not found: $local" }
$size = (Get-Item $local).Length
if ($size -lt 1000000) { throw "File too small ($size), not an APK" }

# APK = ZIP; без central directory установщик Android пишет «повреждённый пакет».
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($local)
  $entries = $zip.Entries.Count
  $hasManifest = $false
  foreach ($e in $zip.Entries) {
    if ($e.FullName -eq 'AndroidManifest.xml') { $hasManifest = $true; break }
  }
  $zip.Dispose()
  if ($entries -lt 10 -or -not $hasManifest) {
    throw "APK ZIP invalid (entries=$entries hasManifest=$hasManifest)"
  }
  Write-Host "APK ZIP OK: $entries entries, $([math]::Round($size/1MB,1)) MB"
} catch {
  throw "Downloaded file is not a valid APK/ZIP: $($_.Exception.Message)"
}

$metaObj = [ordered]@{
  version = $Version
  versionCode = $VersionCode
  updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  fileName = "latest.apk"
}
$meta = ($metaObj | ConvertTo-Json -Compress)
$metaFile = Join-Path $env:TEMP "erm-mobile-app-meta.json"
# Без BOM — иначе Node JSON.parse падает на сервере.
[System.IO.File]::WriteAllText($metaFile, $meta + "`n")

if ($Remote) {
  Write-Host "Uploading to ${RemoteHost}:${RemoteDataDir} ..."
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
