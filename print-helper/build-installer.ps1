# ASCII-only script: avoids PowerShell parse errors when file encoding is wrong.
# Requires: Node.js, Inno Setup 6 (ISCC.exe). Install: winget install JRSoftware.InnoSetup
Param(
  [string]$InnoSetupCompiler = ""
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

function Find-Iscc {
  param([string]$Explicit)
  if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
  $dirs = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6",
    "${env:ProgramFiles}\Inno Setup 6",
    "${env:LocalAppData}\Programs\Inno Setup 6"
  )
  foreach ($d in $dirs) {
    $p = Join-Path $d "ISCC.exe"
    if (Test-Path -LiteralPath $p) { return $p }
  }
  # Any "Inno Setup *" under Program Files (custom install path)
  foreach ($root in @("${env:ProgramFiles(x86)}", "${env:ProgramFiles}")) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $innoDirs = Get-ChildItem -Path $root -Directory -Filter "Inno Setup*" -ErrorAction SilentlyContinue
    foreach ($dir in $innoDirs) {
      $p = Join-Path $dir.FullName "ISCC.exe"
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  $cmd = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
  return $null
}

Write-Host "== Build Print Helper exe ==" -ForegroundColor Cyan
npm install
npm run build:exe

$iscc = Find-Iscc -Explicit $InnoSetupCompiler
if (-not $iscc) {
  $msg = @"
ISCC.exe not found (Inno Setup 6 compiler).

Install Inno Setup 6, then re-run this script. Examples:
  winget install --id JRSoftware.InnoSetup -e
Or pass the compiler path:
  .\build-installer.ps1 -InnoSetupCompiler 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
"@
  throw $msg
}

Write-Host "== Build installer (Inno Setup) ==" -ForegroundColor Cyan
Write-Host "Using ISCC: $iscc"
& $iscc ".\installer\erm-print-helper.iss"

Write-Host ""
Write-Host "Done. Output: print-helper\installer\Output\" -ForegroundColor Green

