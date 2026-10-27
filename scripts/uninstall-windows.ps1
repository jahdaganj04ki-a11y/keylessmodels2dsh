<#
.SYNOPSIS
  Deinstalliert `keylessmodels2dsh` sauber aus DSH Desktop unter Windows.

.PARAMETER DshHome
  Optionaler Pfad zum Harness-Verzeichnis (Standard: `$env:APPDATA\dsh-desktop\harness`).

.PARAMETER PurgeData
  Löscht zusätzlich die gespeicherten Einstellungen und den Katalog-Cache unter `data\keylessmodels2dsh`.
#>
[CmdletBinding()]
param(
  [string]$DshHome = "",
  [switch]$PurgeData
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DesktopHarness = Join-Path $env:APPDATA "dsh-desktop\harness"
  $CliHarness = Join-Path $env:USERPROFILE ".dsh"
  if (Test-Path $DesktopHarness) {
    $DshHome = $DesktopHarness
  } elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME) -and (Test-Path $env:DSH_HOME)) {
    $DshHome = $env:DSH_HOME
  } elseif (Test-Path $CliHarness) {
    $DshHome = $CliHarness
  } else {
    Write-Host "Kein DSH-Verzeichnis gefunden — nichts zu entfernen." -ForegroundColor Yellow
    exit 0
  }
}

$WebProfileDir = Join-Path $DshHome "profiles\web"
if (Test-Path $WebProfileDir) {
  $ResolvedProfileDir = (Resolve-Path $WebProfileDir).Path
  $DshYmlPath = Join-Path $ResolvedProfileDir "dsh.yml"

  if (Test-Path $DshYmlPath) {
    $Lines = Get-Content -Path $DshYmlPath -Encoding UTF8
    $Filtered = $Lines | Where-Object { $_ -notmatch '^\s*keylessmodels2dsh\s*:' }
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($DshYmlPath, (($Filtered -join "`n") + "`n"), $Utf8NoBom)
    Write-Host "Eintrag aus $DshYmlPath entfernt." -ForegroundColor Green
  }

  $DesktopBinDir = Join-Path $DshHome ".desktop-bin"
  $DesktopPnpm = Join-Path $DesktopBinDir "pnpm.cmd"
  $PnpmCmd = if (Test-Path $DesktopPnpm) { $DesktopPnpm } else { (Get-Command pnpm -ErrorAction SilentlyContinue).Source }

  if ($PnpmCmd) {
    $env:PATH = "$DesktopBinDir;$env:PATH"
    & $PnpmCmd --dir $ResolvedProfileDir remove keylessmodels2dsh 2>$null | Out-Null
    Write-Host "npm-Paket keylessmodels2dsh aus Profil entfernt." -ForegroundColor Green
  }
}

if ($PurgeData) {
  $DataDir = Join-Path $DshHome "data\keylessmodels2dsh"
  if (Test-Path $DataDir) {
    Remove-Item -Path $DataDir -Recurse -Force
    Write-Host "Plugin-Datenverzeichnis gelöscht: $DataDir" -ForegroundColor Green
  }
}

Write-Host "Deinstallation abgeschlossen. Bitte starten Sie DSH Desktop neu." -ForegroundColor Cyan
