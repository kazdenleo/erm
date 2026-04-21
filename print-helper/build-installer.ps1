Param(
  [string]$InnoSetupCompiler = ""
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

Write-Host "== Build Print Helper exe ==" -ForegroundColor Cyan
npm install
npm run build:exe

$iscc = $InnoSetupCompiler
if (-not $iscc) {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { $iscc = $c; break }
  }
}

if (-not $iscc -or -not (Test-Path $iscc)) {
  throw "ISCC.exe not found. Install Inno Setup 6 or pass -InnoSetupCompiler."
}

Write-Host "== Build installer (.exe) ==" -ForegroundColor Cyan
& $iscc ".\installer\erm-print-helper.iss"

Write-Host ""
Write-Host "Done. Installer is in print-helper\\installer\\Output\\" -ForegroundColor Green

