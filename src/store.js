/**
 * Durable plugin state store, hardened for Windows NTFS & DSH Desktop (`v0.12.1+`).
 *
 * On Windows, `dataelement/dsh-desktop` runs Harness with `DSH_HOME` set to
 * `%APPDATA%\dsh-desktop\harness` (`<Electron userData>\harness`). Standalone
 * `dsh` CLI installations use `%USERPROFILE%\.dsh` unless `DSH_HOME` is set.
 *
 * File writes coalesce in memory and commit via temp-file + atomic rename with
 * Windows NTFS lock fallback (`EPERM` / `EBUSY` / `EACCES` under Defender or
 * Search Indexer).
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DATA_DIR_NAME = 'keylessmodels2dsh'

/**
 * Resolve the active DSH_HOME directory across DSH Desktop (Windows/macOS/Linux)
 * and standalone DSH CLI installations.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function resolveDshHome(env = process.env, platform = process.platform) {
  const explicit = env.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim()
  }

  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    for (const dirName of ['dsh-desktop', 'DSH Desktop']) {
      const candidate = path.join(appData, dirName, 'harness')
      if (fs.existsSync(candidate)) return candidate
    }
  } else if (platform === 'darwin') {
    const candidate = path.join(os.homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
    if (fs.existsSync(candidate)) return candidate
  } else {
    const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    const candidate = path.join(configHome, 'dsh-desktop', 'harness')
    if (fs.existsSync(candidate)) return candidate
  }

  return path.join(os.homedir(), '.dsh')
}

/** Default user-configurable plugin settings. */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  /** Also register individual `keyless-<provider>` routes alongside `keyless-free`. */
  exposePerProviderRoutes: false,
  /** Enable automatic `/models` catalog refresh on startup and TTL expiry. */
  autoDiscoverModels: true,
  /** Catalog TTL in minutes. */
  catalogTtlMinutes: 30,
  /** Automatically pull live keyless endpoints from Stillworks shelf (`GET /api/llm/up`). */
  syncStillworksShelf: false,
  /** Automatically scan localhost zero-key servers (Ollama, LM Studio, llama.cpp, Jan) on boot. */
  autoScanLocalServers: true,
  /** Stick to the last working candidate inside `auto*` virtual models for session continuity. */
  stickyAutoRouting: true,
  /** Maximum failover attempts across providers in `auto*` or fallback mode before surfacing error. */
  maxFailoverAttempts: 5,
  /** Enable cross-provider fallback even when a concrete `provider/model` hits 429/503 before output. */
  fallbackOnConcreteModel429: false,
  /** Default output token ceiling when DSH omits `maxTokens`. */
  defaultMaxTokens: 8192,
  /** Cooldown seconds after HTTP 429 (Rate Limit) when upstream sends no `Retry-After`. */
  cooldown429Seconds: 180,
  /** Cooldown seconds after HTTP 401/402/403/404 on a specific model/provider. */
  cooldownAuthSeconds: 1800,
  /** Per-provider explicit enable/disable overrides (`{ [providerId]: boolean }`). */
  providerToggles: {},
  /** Hidden composite model IDs (`["kilo/...", ...]`). */
  hiddenModels: [],
  /** User-defined custom keyless endpoints (`[{ id, name, baseUrl, wire, chatPath, modelsPath, staticModels, headers }]`). */
  customProviders: [],
  /** Optional local OpenAI-compatible forward proxy (`127.0.0.1:<port>/v1`) for external tools. */
  localProxyEnabled: false,
  localProxyPort: 18788,
  localProxyKey: 'sk-keyless-dsh-local',
})

/**
 * Write JSON atomically with Windows NTFS `EPERM`/`EBUSY` fallback.
 *
 * @param {string} targetFile
 * @param {unknown} data
 */
export function atomicWriteJsonSync(targetFile, data) {
  const dir = path.dirname(targetFile)
  fs.mkdirSync(dir, { recursive: true })
  const payload = `${JSON.stringify(data, null, 2)}\n`
  const tmpFile = `${targetFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmpFile, payload, 'utf8')
  try {
    fs.renameSync(tmpFile, targetFile)
  } catch (error) {
    const code = /** @type {any} */ (error)?.code
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      // Windows NTFS fallback when an indexer/scanner briefly holds a handle on targetFile
      try {
        fs.copyFileSync(tmpFile, targetFile)
        fs.unlinkSync(tmpFile)
        return
      } catch (inner) {
        try {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
        } catch {}
        throw inner
      }
    }
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
    } catch {}
    throw error
  }
}

export class JsonFileStore {
  /**
   * @param {string} filePath
   * @param {Record<string, any>} defaults
   * @param {{ debounceMs?: number; logger?: any }} [options]
   */
  constructor(filePath, defaults, options = {}) {
    this.filePath = filePath
    this.defaults = structuredClone(defaults)
    this.value = structuredClone(defaults)
    this.debounceMs = options.debounceMs ?? 250
    this.logger = options.logger
    this.dirty = false
    this.disposed = false
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.timer = undefined
    this.load()
  }

  load() {
    if (!fs.existsSync(this.filePath)) return
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8').trim()
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.value = { ...structuredClone(this.defaults), ...parsed }
      }
    } catch (error) {
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
      } catch {}
      this.logger?.warn?.(
        `keylessmodels2dsh: corrupted store backed up (${this.filePath}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  get() {
    return this.value
  }

  /**
   * @param {Record<string, any>} patch
   */
  update(patch) {
    if (this.disposed) return this.value
    this.value = { ...this.value, ...patch }
    this.scheduleFlush()
    return this.value
  }

  /**
   * @param {(draft: Record<string, any>) => Record<string, any> | void} mutator
   */
  edit(mutator) {
    if (this.disposed) return this.value
    const draft = structuredClone(this.value)
    const next = mutator(draft)
    this.value = next !== undefined ? next : draft
    this.scheduleFlush()
    return this.value
  }

  scheduleFlush() {
    this.dirty = true
    if (this.timer !== undefined || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty) return
    try {
      atomicWriteJsonSync(this.filePath, this.value)
      this.dirty = false
    } catch (error) {
      this.logger?.warn?.(
        `keylessmodels2dsh: failed to persist ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  dispose() {
    if (this.disposed) return
    this.flush()
    this.disposed = true
  }
}

/**
 * Create the durable stores used by `keylessmodels2dsh`.
 *
 * @param {{ dataDir: string; logger?: any }} options
 */
export function createPluginStores({ dataDir, logger }) {
  fs.mkdirSync(dataDir, { recursive: true })
  const settings = new JsonFileStore(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS, { logger })
  const runtimeState = new JsonFileStore(
    path.join(dataDir, 'runtime-state.json'),
    {
      discoveredModels: {},
      stillworksModels: [],
      stillworksSyncedAt: 0,
      health: {},
      stats: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        failovers: 0,
        inputTokens: 0,
        outputTokens: 0,
        byProvider: {},
        recentTurns: [],
      },
    },
    { debounceMs: 600, logger },
  )

  return {
    settings,
    runtimeState,
    dispose() {
      settings.dispose()
      runtimeState.dispose()
    },
  }
}
