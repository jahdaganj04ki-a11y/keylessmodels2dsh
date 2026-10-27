# keylessmodels2dsh

**Alle verifizierten kostenlosen KI-Modelle ohne API-Key, ohne Account und ohne Registrierung — nativ vereint für [DSH Desktop](https://github.com/dataelement/dsh-desktop) (`v0.12.1+` unter Windows x64, macOS & Linux).**

`keylessmodels2dsh` ist ein speziell für **`@deepseek-ai/dsh@0.2.1-rc.2`** entwickeltes Zero-Dependency-Plugin. Es bündelt **16+ geprüfte Keyless-Provider** (darunter **Kilo Gateway**, **OVHcloud EU**, **Vireonix**, **ch.at**, **LLM7**, **Rewind AI**, **Free.ai**, **VLM Run**, **BlockRun**, **Pollinations**, **ChatJimmy**, **mlvoca**, **UncloseAI**, **AI Horde**, den stündlich geprüften **Stillworks Live-Feed** sowie lokale Zero-Key-Server wie **Ollama / LM Studio / llama.cpp / Jan**) hinter intelligenten Auto-Routern mit automatischem Multi-Provider-Failover.

---

## Highlights

- **Sofort einsatzbereit ohne API-Key**: Direkt nach der Installation erscheint im Modellwähler von DSH Desktop die Gruppe **`Keyless Free Models`** (`keyless-free`).
- **5 intelligente virtuelle Meta-Router**:
  - `keyless-free / auto` — **Keyless Auto (Best Available)**: Wählt automatisch das beste verfügbare Modell mit Session-Stickiness und Echtzeit-Failover.
  - `keyless-free / auto-coding` — **Keyless Auto · Coding & Agent**: Optimiert für Softwareentwicklung, Dateibearbeitung und zuverlässiges Tool-Calling.
  - `keyless-free / auto-fast` — **Keyless Auto · Ultra-Fast**: Maximale Antwortgeschwindigkeit (u. a. Taalas HC1 Silizium, Nemotron Lightning, Step 3.5 Flash).
  - `keyless-free / auto-reasoning` — **Keyless Auto · Deep Reasoning**: Bevorzugt starke Thinking-Modelle und übersetzt sowohl native `reasoning_content`-Felder als auch Inline-`<think>...</think>`-Tags live in aufklappbare DSH-Denkblöcke.
  - `keyless-free / auto-vision` — **Keyless Auto · Vision Multimodal**: Routet Screenshots und Bildanhänge automatisch an kostenlose multimodale Vision-Modelle.
- **Gepuffertes Pre-Commit-Failover**: Trifft ein kostenloser Anbieter auf ein Rate-Limit (`HTTP 429`), einen Serverfehler (`503`) oder bricht noch während der `<think>`-Denkphase ab, verwirft das Plugin den unfertigen Versuch sauber, setzt den Endpunkt temporär auf Cooldown und schaltet innerhalb derselben Anfrage nahtlos auf den nächsten gesunden Anbieter um.
- **Native Einstellungsseite in DSH Desktop (Deutsch / Englisch / Chinesisch)**: Unter **Einstellungen → Keyless Free Models** lassen sich Kataloge live aktualisieren, einzelne Modelle per **1-Klick Ping-Test** prüfen, der **Stillworks Live-Feed** synchronisieren, eigene Keyless-Endpunkte eintragen und ein **lokaler OpenAI-Proxy (`http://127.0.0.1:18788/v1`)** für VS Code, Cursor, Cline oder Aider aktivieren.
- **100 % Windows- & `dsh-desktop v0.12.1`-sicher**:
  - Null externe npm-Abhängigkeiten & null `peerDependencies` (immun gegen den bekannten `autoInstallPeers: false`-Crash beim Start von DSH Desktop).
  - Unterstützt `%APPDATA%\dsh-desktop\harness\profiles\web` inkl. `.generations`-Auflösung und nutzt bei der Windows-Installation direkt das in `DSH Desktop.exe` eingebettete `.desktop-bin\pnpm.cmd` — **kein globales Node.js auf Windows erforderlich**.

---

## Schnellinstallation unter Windows (`DSH Desktop v0.12.1+`)

### Methode 1: Automatischer PowerShell-Installer (Empfohlen)

1. Klonen oder entpacken Sie dieses Repository in einen beliebigen Ordner auf Ihrem Windows-PC.
2. Öffnen Sie **PowerShell** in diesem Ordner und führen Sie aus:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -RestartDesktop
```

Was das Skript automatisch erledigt:
- Erkennt `%APPDATA%\dsh-desktop\harness\profiles\web` (inklusive `.generations`-Junctions).
- Nutzt das von DSH Desktop mitgelieferte `%APPDATA%\dsh-desktop\harness\.desktop-bin\pnpm.cmd` (funktioniert auch komplett **ohne** installiertes Node.js!).
- Erstellt ein lokales Paketarchiv, installiert `keylessmodels2dsh` sauber in das Profil, legt ein Backup `dsh.yml.bak` an, aktiviert `keylessmodels2dsh: {}` unter `plugins:` in `dsh.yml` und startet DSH Desktop auf Wunsch direkt neu.

### Methode 2: Manuelle Installation über das integrierte DSH-pnpm

Falls Sie die Befehle einzeln in PowerShell ausführen möchten:

```powershell
$Harness = "$env:APPDATA\dsh-desktop\harness"
$Pnpm    = "$Harness\.desktop-bin\pnpm.cmd"
$Profile = (Resolve-Path "$Harness\profiles\web").Path

& $Pnpm --dir $Profile add C:\Pfad\zu\keylessmodels2dsh
```

Ergänzen Sie anschließend in `%APPDATA%\dsh-desktop\harness\profiles\web\dsh.yml`:

```yaml
plugins:
  keylessmodels2dsh: {}
```

Starten Sie danach **DSH Desktop** neu.

### Deinstallation unter Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows.ps1 -PurgeData
```

---

## Nutzung in DSH Desktop

1. **Modell auswählen**: Klicken Sie unten im Chat-Eingabefeld von DSH Desktop auf den **Modellwähler** und wählen Sie unter **`Keyless Free Models`**:
   - **`Keyless Auto · Coding & Agent`** (`auto-coding`) für Programmier- und Agentenaufgaben mit Tool-Nutzung,
   - **`Keyless Auto (Best Available)`** (`auto`) für allgemeine Aufgaben,
   - oder gezielt eines der Einzelmodelle wie `kilo/kilo-auto/free`, `kilo/qwen/qwen3.6-plus:free`, `ovh/gpt-oss-120b`, `ovh/Qwen3-Coder-30B-A3B-Instruct`, `vireonix/auto`, `llm7/codestral-latest`, `chatjimmy/llama3.1-8B` usw.
2. **Verwaltung & Live-Diagnose**: Öffnen Sie **Einstellungen → Keyless Free Models**:
   - **Übersicht & Smart-Router**: Live-Zähler, Katalog-Refresh, Stillworks-Feed-Sync, lokaler Server-Scan & Cooldown-Reset.
   - **Provider & Modelle**: Einzelne Provider ein-/ausschalten, Modelle filtern/ausblenden und per **Ping-Test** Latenz (TTFT) prüfen.
   - **Eigener Endpunkt & Proxy**: Eigene Keyless-URLs hinzufügen oder den lokalen OpenAI-kompatiblen Server (`http://127.0.0.1:18788/v1`) für externe Tools einschalten.
   - **Einstellungen & Audit**: Separate Provider-Gruppen (`keyless-kilo`, `keyless-ovh`, …) aktivieren, Failover-Parameter feinjustieren und das letzte Anfrageprotokoll einsehen.

---

## Enthaltene Keyless-Provider im Überblick

| Provider | Standardstatus | Protokoll | Typische Gratis-Modelle |
|---|---|---|---|
| **Kilo Gateway** (`kilo`) | Aktiv | OpenAI SSE | `kilo-auto/free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `qwen/qwen3.6-plus:free`, `minimax/minimax-m2.5:free`, `stepfun/step-3.5-flash:free`, `nvidia/nemotron-3.5-super-vl:free` |
| **Kilo OpenRouter Lane** (`kilo-openrouter`) | Aktiv | OpenAI SSE | `openrouter/free`, alle `:free`-Modelle über Kilos zweite Routing-Spur |
| **OVHcloud AI Endpoints EU** (`ovh`) | Aktiv | OpenAI SSE | `gpt-oss-120b`, `Qwen3.5-397B-A17B`, `Qwen3-Coder-30B-A3B-Instruct`, `Qwen3.8-27B` (Vision), `Meta-Llama-3_3-70B-Instruct` |
| **Vireonix AI** (`vireonix`) | Aktiv | OpenAI SSE | `auto` (bis zu 1M Kontext & Tool-Calling) |
| **ch.at Universal** (`chat`) | Aktiv | OpenAI SSE | `gpt-4o`, `default` |
| **LLM7** (`llm7`) | Aktiv | OpenAI SSE | `codestral-latest`, `deepseek-r1`, `qwen2.5-coder-32b-instruct`, `gpt-4o-mini` |
| **Rewind AI** (`rewind`) | Aktiv | OpenAI SSE | Live entdeckter kostenloser Modellkatalog via `/v1/models` |
| **Free.ai** (`freeai`) | Aktiv | OpenAI SSE | Live entdeckte Gratis-Modelle (`https://api.free.ai/v1`) |
| **VLM Run Agent** (`vlmrun`) | Aktiv | OpenAI SSE | Multimodaler Vision- & Dokument-Agent |
| **BlockRun AI Free** (`blockrun`) | Aktiv | OpenAI SSE | `nvidia/gpt-oss-120b`, `nvidia/deepseek-v4-flash`, `nvidia/step-3.7-flash` |
| **Pollinations Text** (`pollinations`) | Aktiv | OpenAI SSE | `openai`, `openai-fast` (mit automatischem 15s-Intervallschutz) |
| **ChatJimmy (Taalas HC1)** (`chatjimmy`) | Aktiv | Taalas Stream | `llama3.1-8B` (Ultra-Low-Latency Hardware) |
| **mlvoca Free Ollama** (`mlvoca`) | Aktiv | Ollama NDJSON | `deepseek-r1:1.5b`, `tinyllama` |
| **UncloseAI** (`uncloseai`) | Aktiv | OpenAI SSE | `adamo1139/Hermes-3-Llama-3.1-8B-FP8-Dynamic` |
| **Lokale Server** (`ollama-local`, `lmstudio-local`, `llamacpp-local`, `jan-local`) | Auto-Aktiv bei Fund | OpenAI / Ollama | Alle lokal laufenden Modelle auf `127.0.0.1` ohne Konfiguration |
| **AI Horde** (`aihorde`) & **OpenCode Zen** (`opencode`) | Opt-in in UI | OpenAI | Frei zuschaltbar in den Plugin-Einstellungen |

Eine vollständige technische Dokumentation der `dsh-desktop v0.12.1`-Interna sowie die Liste geprüfter und ausgeschlossener Schein-Keyless-Endpunkte finden Sie in [`docs/RESEARCH.md`](./docs/RESEARCH.md).

---

## Entwicklung & Qualitätssicherung

```bash
# Statische Seam-Prüfung + komplette Test-Suite ausführen
npm run check
```

## Lizenz

[MIT](./LICENSE)
