<#
  Rebuild the desktop app and the Windows capture helper after pulling new code.
  Close Open-Recorder first (the running app locks the helper .exe). NuGet / dotnet caches are kept inside the
  repository (.cache\), so nothing is written to your user profile.

  Usage (PowerShell, from the repository root):  .\scripts\update-local.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$running = Get-Process -Name 'win-helper' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$root*" }
if ($running) {
  Write-Host 'Open-Recorder is still running (its capture helper is in use). Close the Open-Recorder windows and the tray icon, then run this again.' -ForegroundColor Yellow
  exit 1
}

$env:NUGET_PACKAGES = Join-Path $root '.cache\nuget'
$env:DOTNET_CLI_HOME = Join-Path $root '.cache\dotnet'
Write-Host '1/2  Building the capture helper (win-helper)…' -ForegroundColor Cyan
Push-Location (Join-Path $root 'backend\native\win-helper')
try { dotnet build -c Release -nologo -v q } finally { Pop-Location }

Write-Host '2/2  Building the desktop app…' -ForegroundColor Cyan
Push-Location (Join-Path $root 'frontend\desktop')
try { npm run build } finally { Pop-Location }

Write-Host ''
Write-Host 'Done. Start Open-Recorder with:' -ForegroundColor Green
Write-Host "  cd $root\frontend\desktop"
Write-Host '  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue'
Write-Host '  npx electron .'
