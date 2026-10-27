# Tiefenrecherche: `dsh-desktop` (`v0.12.1` Windows) & das Keyless-LLM-Ökosystem (Stand: Oktober 2026)

Dieses Dokument fasst die technische Tiefenanalyse von **`dataelement/dsh-desktop` (`v0.12.1`)**, der zugrundeliegenden Harness-Engine **`@deepseek-ai/dsh@0.2.1-rc.2`** sowie die systematische Prüfung von über 270 öffentlichen LLM-Endpunkten zusammen, auf deren Basis `keylessmodels2dsh` entwickelt wurde.

---

## 1. Architektur von `dsh-desktop` `v0.12.1` unter Windows x64

Das aktuelle offizielle Windows-Release von [`dataelement/dsh-desktop`](https://github.com/dataelement/dsh-desktop) (`v0.12.1`, veröffentlicht am 20.10.2026 als `dsh-desktop-windows-x64-setup.exe`) basiert auf folgendem Stack:

| Komponente | Exakte Version in `v0.12.1` | Bedeutung für Plugins |
|---|---|---|
| `@deepseek-ai/dsh` (+ Core-Pakete) | `0.2.1-rc.2` | V4-Stream-/Tool-Vertrag, striktes `evaluatePluginCompatibility` |
| `@deepseek-ai/cordis` | `4.0.5` | Reaktives Dependency-Injection-System (`inject`, `effect`, Fibers) |
| `@deepseek-ai/schemastery` | `3.18.5` | Konfigurationsvalidierung |
| Electron | `43.0.0` (Node >= 22 ABI) | Unterstützt `ELECTRON_RUN_AS_NODE=1` als eingebettete Node-Laufzeit |
| Gebündeltes `pnpm` | `10.34.5` | Liegt als `.desktop-bin\pnpm.cmd` im Harness-Ordner vor |

### Windows-Dateisystem & Prozessmodell
1. **Speicherort des Harness (`DSH_HOME`)**:
   - Unter Windows nutzt DSH Desktop **nicht** `%USERPROFILE%\.dsh`, sondern standardmäßig:
     ```text
     %APPDATA%\dsh-desktop\harness
     ```
     (also `C:\Users\<Name>\AppData\Roaming\dsh-desktop\harness`).
2. **Aktives Profil & Generationen (`profiles\web` & `profiles\.generations`)**:
   - DSH Desktop verwaltet Profil-Updates atomar über Generationen-Ordner unter `profiles\.generations\<hash>` und verweist über `profiles\web` darauf.
   - Die aktive Plugin-Deklaration liegt in `profiles\web\dsh.yml` unter dem Schlüssel `plugins:`.
3. **Eingebettete Node-/pnpm-Shims (`.desktop-bin`)**:
   - Windows-Nutzer von `DSH Desktop.exe` benötigen **keine** separate Node.js-Installation.
   - DSH Desktop erzeugt unter `%APPDATA%\dsh-desktop\harness\.desktop-bin\` eigene Wrapper (`node.cmd`, `pnpm.cmd`), die `%LOCALAPPDATA%\Programs\dsh-desktop\DSH Desktop.exe` mit `ELECTRON_RUN_AS_NODE=1` aufrufen. Unser PowerShell-Installer (`scripts/install-windows.ps1`) nutzt exakt diesen Mechanismus automatisch.
4. **Loopback-Port & Custom-Electron-Protokoll (`dsh-app://app`)**:
   - Der lokale Harness-Webserver läuft auf `127.0.0.1` (Standardport `43129`).
   - Der Electron-Renderer lädt die Oberfläche über das benutzerdefinierte Schema `dsh-app://app`. Eigene Plugin-HTTP-Routen unter `/api/<plugin>/*` müssen daher im Sicherheits-Fence (`src/trust.js`) `Referer: dsh-app://app/...` zulassen, während externe Cross-Site-Anfragen (`Sec-Fetch-Site: cross-site`) und DNS-Rebinding strikt mit `HTTP 403` abgewiesen werden.

---

## 2. Kritische Plugin-Vertragsregeln in `@deepseek-ai/dsh@0.2.1-rc.2`

Bei der Analyse des Quellcodes von `@deepseek-ai/dsh-llm@0.2.1-rc.2`, `@deepseek-ai/dsh-app-boot@0.2.1-rc.2`, `@deepseek-ai/dsh-client-modules@0.2.1-rc.2` sowie bestehender Community-Plugins (`dsh-our-free-model`, `dsh-kilo-gateway`, `dsh-commandcode-provider`, `bowenliang123/dsh-context#206`) wurden acht entscheidende Fallstricke identifiziert und in `keylessmodels2dsh` gelöst:

1. **Die `autoInstallPeers: false`-Falle (`dsh-context#206`)**:
   - DSH-Profile installieren Pakete mit `autoInstallPeers: false`. Besitzt ein Plugin statische `import`-Anweisungen auf `@deepseek-ai/*` oder externe npm-Pakete bzw. unerfüllte `peerDependencies`, wirft der Loader beim Start `ERR_MODULE_NOT_FOUND` und versetzt DSH Desktop in den Recovery-/Safe-Mode.
   - **Lösung**: `keylessmodels2dsh` hat **null** `dependencies`, **null** `peerDependencies`, keine Lifecycle-Skripte (`postinstall`/`prepare`) und verwendet im Host-Code ausschließlich `node:*`-Builtins. Der Kernel-User-Agent wird in `adapter/kernel.js` rein optional per `await import('@deepseek-ai/dsh-llm')` mit statischem Fallback aufgelöst.
2. **Kein Monkey-Patching von `globalThis.fetch`**:
   - Das offizielle Paket `@deepseek-ai/dsh-experimental-inspector` instrumentiert `globalThis.fetch`. Überschreibt ein Plugin `globalThis.fetch`, entstehen Endlosschleifen oder verlorene Telemetrie-Spans. Alle Netzwerkaufrufe in `keylessmodels2dsh` übergeben `fetchImpl` explizit.
3. **Flaches `providerRetryPolicy`-Objekt**:
   - `LlmRuntime` validiert `providerRetryPolicy()` gegen `RetryPolicySchema`: erwartet wird ein flaches Objekt `{ mode: 'normal', maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio }` (kein verschachteltes `backoff`-Objekt aus älteren `0.1.x`-Versionen).
4. **Disjunkte Block-Indizes & `ToolCallId`-Pflicht auf jedem Delta**:
   - `BlockAssembler` in `@deepseek-ai/dsh-llm@0.2.1-rc.2` verlangt getrennte Index-Bänder (`0` für Reasoning, `1000` für Text, `100000 + slot` für Tool-Calls).
   - Jedes einzelne `tool-call-delta` **muss** ein nicht-leeres `id: string` tragen — viele OpenAI-kompatible Gateways senden `id` jedoch nur im allerersten Chunk und danach `id: undefined` oder `""`. `DshChunkBuilder` (`src/stream.js`) merkt sich die `id` pro Slot und stempelt sie auf jedes Folge-Delta.
5. **V4 `ToolResultMessage` (`role: 'tool'`) & `ToolHistory = { tools, updates }`**:
   - In `0.2.1-rc.2` ist `options.toolHistory` ein Objekt `{ tools, updates }` (kein Array!). Tool-Ergebnisse kommen als Nachrichten mit `role: 'tool'` und `toolCallId`. `src/messages.js` unterstützt sowohl das V4-Format als auch ältere `tool-result`-Content-Blöcke und bereinigt verwaiste Tool-Calls nach abgebrochenen Turns (`repairToolPairing`).
6. **Gepuffertes Pre-Commit-Failover (`src/adapter.js`)**:
   - Bricht ein kostenloser Upstream während der `<think>`-Phase mit `HTTP 429` oder einem Stream-Fehler ab, bevor sichtbarer Antworttext oder ein Tool-Call gesendet wurde, verwirft `KeylessModelsAdapter` die gepufferten Vorab-Chunks spurlos, setzt das Modell auf Cooldown und wechselt innerhalb derselben Anfrage nahtlos zum nächsten gesunden Keyless-Provider.
7. **Live-Aktualisierung des Modellwählers über `handle.replace(routes)`**:
   - `ctx.llm.registerAdapter(routes, adapter)` gibt ein Handle mit `.replace(nextRoutes)` zurück, das `'llm/adapters-updated'` im Harness feuert. Dadurch aktualisiert sich das Modell-Dropdown in DSH Desktop sofort ohne Neustart, sobald Kataloge geladen oder Provider umgeschaltet werden.
8. **Lazy-CJS Client-Modulvertrag (`client.js`)**:
   - Browser-Bundles registrieren sich über `window.__ModuleLoader__.load({ id: 'keylessmodels2dsh', factory(require) { ... } })`, beziehen `react` als Shell-Seed-Modul und deklarieren `"inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"]` in `package.json#dsh.client`.

---

## 3. Systematisches Audit aller Keyless-Provider (Stand: Oktober 2026)

Quellen der Kreuzvalidierung:
- Live-Quellcode von `kilo-gateway`, `dsh-our-free-model`, `keyless-llm`, `freellmpool`, `llmfree`, `free-ai-hub` und `awesome-free-ai-coding`.
- Live-Telemetrie des Projekts **[Stillworks](https://github.com/bon5co/stillworks)** (`stillworks.supercapybara.com/api/llm/up`), das 270 OmniRoute-Provider kontinuierlich ohne API-Key testet.

### A. Integrierte & verifizierte Zero-Key-Provider (16 Kanäle + Live-Feed)

| ID | Provider | Protokoll / Endpunkt | Besonderheiten & Stärken |
|---|---|---|---|
| `kilo` | **Kilo Gateway** | OpenAI · `https://api.kilo.ai/api/gateway` | Auth über statisches `Bearer kilo-anonymous`; liefert `kilo-auto/free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `qwen/qwen3.6-plus:free`, `minimax/minimax-m2.5:free`, `stepfun/step-3.5-flash:free`, Vision (`nemotron-3.5-super-vl:free`) & volles Tool-Calling |
| `kilo-openrouter` | **Kilo OpenRouter Lane** | OpenAI · `https://api.kilo.ai/api/openrouter` | Zweite unabhängige Routing-Spur für `:free`-Modelle bei Gateway-Spitzenlast |
| `ovh` | **OVHcloud AI Endpoints (EU)** | OpenAI · `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | Europäische DSGVO-freundliche Infrastruktur, anonym ohne Header nutzbar (~20 RPM/IP): `gpt-oss-120b`, `Qwen3.5-397B-A17B`, `Qwen3-Coder-30B-A3B-Instruct`, `Qwen3.8-27B` (Vision) |
| `vireonix` | **Vireonix AI** | OpenAI · `https://api.vireonix.com/v1` | Keyless `auto`-Router mit bis zu 1M Kontextfenster und starkem Tool-Calling |
| `chat` | **ch.at Universal** | OpenAI · `https://ch.at/v1` | Minimalistischer Zero-Account-Dienst (`gpt-4o` / `default`) ohne jeglichen Auth-Header |
| `llm7` | **LLM7 Anonymous Gateway** | OpenAI · `https://api.llm7.io/v1` | `Bearer unused` genügt; große Modellvielfalt inkl. `codestral-latest`, `deepseek-r1`, `qwen2.5-coder-32b` & Vision |
| `rewind` | **Rewind AI** | OpenAI · `https://api.rewind-ai.com/v1` | Kostenloses Multi-Modell-Gateway mit Live-`/models`-Katalog |
| `freeai` | **Free.ai** | OpenAI · `https://api.free.ai/v1` | Durch Stillworks im Okt. 2026 als echt keyless verifiziert |
| `vlmrun` | **VLM Run Agent** | OpenAI · `https://agent.vlm.run/v1/openai` | Stark für multimodale Vision- & Dokument-Anfragen; serverseitig in Node/DSH ohne Browser-CORS-Sperre nutzbar |
| `blockrun` | **BlockRun AI Free** | OpenAI · `https://blockrun.ai/api/v1` | Kostenloser Zugriff auf `nvidia/gpt-oss-120b`, `nvidia/deepseek-v4-flash`, `nvidia/step-3.7-flash` u. a. |
| `pollinations` | **Pollinations Legacy Text** | OpenAI · `https://text.pollinations.ai/openai` | Bewusst auf den funktionierenden Legacy-Pfad gesetzt (1 Req / 15s Burst-Schutz integriert) |
| `chatjimmy` | **ChatJimmy (Taalas HC1)** | Custom Stream · `https://chatjimmy.ai` | Spezial-Silizium (~15.000 Tok/s für `llama3.1-8B`), eigener `<|stats|>`-Parser integriert |
| `mlvoca` | **mlvoca Free Ollama** | Ollama · `https://mlvoca.com` | Öffentlicher NDJSON-Endpunkt (`deepseek-r1:1.5b`, `tinyllama`) als ultraleichte Notfallreserve |
| `uncloseai` | **UncloseAI** | OpenAI · `https://hermes.ai.unturf.com/v1` | Öffentlicher Hermes-3-Llama-3.1-8B-Endpunkt |
| `aihorde` | **AI Horde (Community GPU)** | OpenAI · `https://oai.aihorde.net/v1` | Offizieller anonymer Community-Key `0000000000` (Opt-in wegen variabler Queue-Latenz) |
| `opencode` | **OpenCode Zen** | OpenAI · `https://opencode.ai/zen/v1` | Standardmäßig **Opt-in**, da außerhalb von OpenCode häufig `HTTP 403 FreeTierError` / IP-`429` auftritt |
| `*-local` | **Ollama / LM Studio / llama.cpp / Jan** | Loopback `127.0.0.1` | Automatischer lokaler Zero-Key-Portscanner (`11434`, `1234`, `8080`, `1337`) |
| `shelf-*` | **Stillworks Live-Shelf** | Dynamisch · `/api/llm/up` | Importiert neu auftauchende, stündlich getestete Keyless-Hosts automatisch zur Laufzeit |

### B. Bewusst ausgeschlossene „Schein-Keyless“-Dienste (Stand: Oktober 2026)

Viele ältere Listen nennen Endpunkte, die heute **nicht mehr** ohne API-Key oder Bezahlung funktionieren. `keylessmodels2dsh` schließt diese gezielt aus (und dokumentiert sie transparent im Audit-Tab der Einstellungen), damit keine Anfragen in tote Endpunkte laufen:

| Dienst / URL | HTTP-Befund | Grund des Ausschlusses |
|---|---|---|
| `gen.pollinations.ai/v1` | `HTTP 401` | Neues Pollinations-Gateway verlangt zwingend `pk_`/`sk_`-API-Keys (stattdessen wird `text.pollinations.ai/openai` genutzt) |
| `ai.hackclub.com/proxy/v1` | `HTTP 401` | Liefert `200` auf `/models`, blockiert `/chat/completions` aber ohne persönlichen Key |
| `api.naga.ac/v1` & `api.friendli.ai` | `HTTP 401` | `/models` öffentlich lesbar, Chat-Inferenz jedoch strikt authentifiziert |
| `g4f.space/v1` | `HTTP 402` | Verlangt proprietäres Browser-Proof-of-Work-Challenge-Token oder API-Key |
| `api.airforce/v1` | `HTTP 401 / 402` | Kein anonymer Zugriff mehr möglich |
| `inference.liquid.ai/v1` | `HTTP 403` | Öffentlich dokumentierter Demo-Key gesperrt |
| `api.blackbox.ai` | `HTTP 404 / 401` | Öffentliche REST-Route abgeschaltet |
| `keylessai.thryx.workers.dev` | `TLS / Dead` | Cloudflare-Worker offline |
