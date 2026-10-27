<#
.SYNOPSIS
  Installiert `keylessmodels2dsh` in DSH Desktop für Windows (v0.12.1+, @deepseek-ai/dsh 0.2.1-rc.2).

.DESCRIPTION
  Unterstützt die exakte Windows-Architektur von `dataelement/dsh-desktop`:
    - DSH_HOME:        %APPDATA%\dsh-desktop\harness
    - Aktives Profil:  %APPDATA%\dsh-desktop\harness\profiles\web (inkl. .generations-Auflösung)
    - Gebündeltes pnpm: %APPDATA%\dsh-desktop\harness\.desktop-bin\pnpm.cmd (nutzt DSH Desktop.exe
                        mit ELECTRON_RUN_AS_NODE=1 — KEIN globales Node.js auf Windows nötig!)

  Schritte:
    1. Erkennt `%APPDATA%\dsh-desktop\harness` (oder benutzerdefiniertes `-DshHome`).
    2. Erzeugt ein sauberes lokales Paketarchiv (`keylessmodels2dsh-*.tgz`) oder nutzt den lokalen Pfad.
    3. Installiert das Plugin mit dem von DSH Desktop mitgelieferten `pnpm.cmd` (oder globalem `pnpm`)
       direkt in `profiles\web`.
    4. Trägt `keylessmodels2dsh: {}` idempotent unter `plugins:` in `profiles\web\dsh.yml` ein
       (mit automatischem Backup `dsh.yml.bak`).

.PARAMETER DshHome
  Optionaler Pfad zum Harness-Verzeichnis (Standard: `$env:APPDATA\dsh-desktop\harness`).

.PARAMETER RestartDesktop
  Beendet laufende `DSH Desktop`-Prozesse sauber und startet DSH Desktop neu, damit das Plugin sofort aktiv ist.
#>
[CmdletBinding()]
param(
  [string]$DshHome = "",
  [switch]$RestartDesktop
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  keylessmodels2dsh — Windows Installer für DSH Desktop     " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$PluginRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PackageJsonPath = Join-Path $PluginRoot "package.json"
if (-not (Test-Path $PackageJsonPath)) {
  throw "package.json wurde unter '$PluginRoot' nicht gefunden."
}

# 1. DSH_HOME ermitteln (%APPDATA%\dsh-desktop\harness hat Vorrang für DSH Desktop unter Windows)
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
    throw "DSH Desktop Harness-Verzeichnis nicht gefunden ('$DesktopHarness'). Bitte starten Sie DSH Desktop mindestens einmal vor der Installation."
  }
}

$WebProfileDir = Join-Path $DshHome "profiles\web"
if (-not (Test-Path $WebProfileDir)) {
  throw "Das Web-Profil '$WebProfileDir' existiert noch nicht. Bitte öffnen Sie DSH Desktop einmal kurz, damit das Profil initialisiert wird."
}

# Symlink / Junction auf reale Generation auflösen (wichtig für DSH Desktop `profiles\.generations`)
$ResolvedProfileDir = (Get-Item $WebProfileDir).FullName
$TargetItem = Get-Item $WebProfileDir -Force
if ($TargetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
  if ($TargetItem.Target) {
    $TargetCandidate = $TargetItem.Target
    if ($TargetCandidate -is [array]) { $TargetCandidate = $TargetCandidate[0] }
    if (-not [IO.Path]::IsPathRooted($TargetCandidate)) {
      $TargetCandidate = Join-Path (Split-Path $WebProfileDir -Parent) $TargetCandidate
    }
    if (Test-Path $TargetCandidate) {
      $ResolvedProfileDir = (Resolve-Path $TargetCandidate).Path
    }
  }
}

Write-Host "[1/4] Gefundenes DSH-Profil: $ResolvedProfileDir" -ForegroundColor Green

# 2. Passendes `pnpm` ermitteln (1. DSH Desktop `.desktop-bin\pnpm.cmd`, 2. System-pnpm)
$DesktopBinDir = Join-Path $DshHome ".desktop-bin"
$DesktopPnpm = Join-Path $DesktopBinDir "pnpm.cmd"
$PnpmCmd = $null

if (Test-Path $DesktopPnpm) {
  $PnpmCmd = $DesktopPnpm
  $env:PATH = "$DesktopBinDir;$env:PATH"
  Write-Host "[2/4] Nutze DSH Desktops integriertes pnpm: $DesktopPnpm" -ForegroundColor Green
} else {
  $SysPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($SysPnpm) {
    $PnpmCmd = $SysPnpm.Source
    Write-Host "[2/4] Nutze globales pnpm: $PnpmCmd" -ForegroundColor Green
  } else {
    throw "Weder '$DesktopPnpm' noch ein globales 'pnpm' gefunden. Bitte starten Sie DSH Desktop einmal oder installieren Sie Node.js/pnpm."
  }
}

# 3. Sauberes Tarball erzeugen und im Profil installieren (vermeidet Datei-Sperren unter NTFS)
$StageDir = Join-Path $DshHome "cache\keylessmodels2dsh-pkg"
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
Get-ChildItem -Path $StageDir -Filter "keylessmodels2dsh-*.tgz" -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "[3/4] Packe und installiere keylessmodels2dsh in das DSH-Profil..." -ForegroundColor Cyan
Push-Location $PluginRoot
try {
  & $PnpmCmd pack --pack-destination $StageDir | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm pack ist mit Exit-Code $LASTEXITCODE fehlgeschlagen."
  }
} finally {
  Pop-Location
}

$Tarball = Get-ChildItem -Path $StageDir -Filter "keylessmodels2dsh-*.tgz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Tarball) {
  throw "Konnte kein Paketarchiv unter '$StageDir' erstellen."
}

& $PnpmCmd --dir $ResolvedProfileDir add $Tarball.FullName --prefer-offline
if ($LASTEXITCODE -ne 0) {
  throw "pnpm add in '$ResolvedProfileDir' fehlgeschlagen (Exit-Code $LASTEXITCODE)."
}

# 4. `dsh.yml` idempotent um `keylessmodels2dsh: {}` unter `plugins:` ergänzen
$DshYmlPath = Join-Path $ResolvedProfileDir "dsh.yml"
Write-Host "[4/4] Aktualisiere Konfiguration: $DshYmlPath" -ForegroundColor Cyan

if (Test-Path $DshYmlPath) {
  Copy-Item -Path $DshYmlPath -Destination "$DshYmlPath.bak" -Force
  $RawYml = Get-Content -Path $DshYmlPath -Raw -Encoding UTF8
  if ($RawYml -notmatch '(?m)^\s*keylessmodels2dsh\s*:') {
    if ($RawYml -match '(?m)^plugins\s*:\s*\{\s*\}') {
      $UpdatedYml = [regex]::Replace($RawYml, '(?m)^plugins\s*:\s*\{\s*\}', "plugins:`n  keylessmodels2dsh: {}")
    } elseif ($RawYml -match '(?m)^plugins\s*:') {
      $UpdatedYml = [regex]::Replace($RawYml, '(?m)^plugins\s*:\s*\r?\n', "plugins:`n  keylessmodels2dsh: {}`n")
    } else {
      $Trimmed = $RawYml.TrimEnd()
      $UpdatedYml = "$Trimmed`n`nplugins:`n  keylessmodels2dsh: {}`n"
    }
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($DshYmlPath, $UpdatedYml, $Utf8NoBom)
  }
} else {
  $InitialYml = "plugins:`n  keylessmodels2dsh: {}`n"
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($DshYmlPath, $InitialYml, $Utf8NoBom)
}

# Optionaler Neustart von DSH Desktop
$DesktopExe = Join-Path $env:LOCALAPPDATA "Programs\dsh-desktop\DSH Desktop.exe"
if ($RestartDesktop) {
  Get-Process -Name "DSH Desktop" -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  if (Test-Path $DesktopExe) {
    Start-Process -FilePath $DesktopExe
    Write-Host "DSH Desktop wurde neu gestartet." -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "Installation erfolgreich abgeschlossen!" -ForegroundColor Green
Write-Host "  1. Starten Sie DSH Desktop neu (oder klicken Sie in Einstellungen -> Plugins auf Neu laden)."
Write-Host "  2. Wählen Sie im Modellwähler unter 'Keyless Free Models' sofort 'auto', 'auto-coding' oder ein Einzelmodell (z. B. kilo/..., ovh/..., vireonix/...)."
Write-Host "  3. Öffnen Sie Einstellungen -> Keyless Free Models für Live-Status, Modell-Tests & lokalen Proxy."
Write-Host ""
