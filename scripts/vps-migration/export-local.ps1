# Export PostgreSQL dump + server/uploads (+ optional data/) for VPS migration.
# Run from repo root:  .\scripts\vps-migration\export-local.ps1
#
# pg_dump: in PATH, or set $env:PG_BIN to PostgreSQL "bin" folder, or $env:PG_DUMP to full path to pg_dump.exe.

$ErrorActionPreference = "Stop"

function Resolve-PgDumpExe {
  if ($env:PG_DUMP -and (Test-Path -LiteralPath $env:PG_DUMP)) {
    return $env:PG_DUMP
  }
  if ($env:PG_BIN) {
    $cand = Join-Path $env:PG_BIN "pg_dump.exe"
    if (Test-Path -LiteralPath $cand) { return $cand }
  }
  $cmd = Get-Command pg_dump.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command pg_dump -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $roots = @(
    ${env:ProgramFiles},
    ${env:ProgramFiles(x86)},
    "C:\Program Files",
    "C:\Program Files (x86)"
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($root in $roots) {
    $pgRoot = Join-Path $root "PostgreSQL"
    if (-not (Test-Path $pgRoot)) { continue }
    $found = Get-ChildItem -Path $pgRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object {
        $exe = Join-Path $_.FullName "bin\pg_dump.exe"
        if (Test-Path -LiteralPath $exe) { $exe }
      } | Sort-Object -Descending | Select-Object -First 1
    if ($found) { return $found }
  }
  return $null
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$OutDir = Join-Path $PSScriptRoot "out\export-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

function Read-DotEnv {
  param([string]$path)
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  Get-Content -LiteralPath $path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { return }
    $i = $line.IndexOf('=')
    if ($i -lt 1) { return }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim()
    if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    if ($v.Length -ge 2 -and $v.StartsWith("'") -and $v.EndsWith("'")) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $map[$k] = $v
  }
  return $map
}

$envFile = Join-Path $RepoRoot ".env"
if (-not (Test-Path $envFile)) {
  $envFile = Join-Path $RepoRoot "server\.env"
}
$cfg = Read-DotEnv $envFile

$dbHost = if ($cfg['DB_HOST']) { $cfg['DB_HOST'] } else { 'localhost' }
$dbPort = if ($cfg['DB_PORT']) { $cfg['DB_PORT'] } else { '5432' }
$dbName = if ($cfg['DB_NAME']) { $cfg['DB_NAME'] } else { 'erp_system' }
$dbUser = if ($cfg['DB_USER']) { $cfg['DB_USER'] } else { 'admin' }
$dbPass = $cfg['DB_PASSWORD']
if (-not $dbPass) { $dbPass = '' }

$pgDumpExe = Resolve-PgDumpExe
if (-not $pgDumpExe) {
  Write-Error @'
pg_dump.exe not found.

Options:
  1) Install PostgreSQL for Windows and re-run the script (bin is usually in PATH), or
  2) In this PowerShell session set the folder that contains pg_dump.exe, e.g.:
       $env:PG_BIN = "C:\Program Files\PostgreSQL\16\bin"
     then run the script again, or
  3) Full path to the executable:
       $env:PG_DUMP = "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe"
'@
}

$dumpFile = Join-Path $OutDir "erp_system.dump"
$env:PGPASSWORD = $dbPass
try {
  & $pgDumpExe -h $dbHost -p $dbPort -U $dbUser -d $dbName -Fc -f $dumpFile
}
finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

if (-not (Test-Path $dumpFile) -or (Get-Item $dumpFile).Length -eq 0) {
  Write-Error 'Dump missing or empty. Check DB_* in .env and PostgreSQL connection.'
}

$uploads = Join-Path $RepoRoot "server\uploads"
if (Test-Path $uploads) {
  $tarGz = Join-Path $OutDir "server-uploads.tar.gz"
  Push-Location $RepoRoot
  try {
    tar -czf $tarGz -C "server" "uploads"
  }
  finally {
    Pop-Location
  }
  Write-Host "Uploads archive: $tarGz"
}
else {
  Write-Host 'Folder server\uploads not found - skipped.'
}

$dataDir = Join-Path $RepoRoot "data"
if (Test-Path $dataDir) {
  $dataTar = Join-Path $OutDir "data.tar.gz"
  Push-Location $RepoRoot
  try {
    tar -czf $dataTar "data"
  }
  finally {
    Pop-Location
  }
  Write-Host "Data archive: $dataTar"
}

Write-Host ""
Write-Host "Done. Export folder:"
Write-Host "  $OutDir"
Write-Host ""
Write-Host "Copy to VPS (replace VPS_IP with your server IP):"
Write-Host ('  scp "{0}\erp_system.dump" root@VPS_IP:/root/erm-migration/' -f $OutDir)
if (Test-Path (Join-Path $OutDir "server-uploads.tar.gz")) {
  Write-Host ('  scp "{0}\server-uploads.tar.gz" root@VPS_IP:/root/erm-migration/' -f $OutDir)
}
if (Test-Path (Join-Path $OutDir "data.tar.gz")) {
  Write-Host ('  scp "{0}\data.tar.gz" root@VPS_IP:/root/erm-migration/' -f $OutDir)
}
