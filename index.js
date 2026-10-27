/**
 * `keylessmodels2dsh` — Host Entry Point for DeepSeek Harness & DSH Desktop (`v0.12.1+`).
 *
 * Unifies all verified zero-key free LLM providers (Kilo Gateway, Kilo OpenRouter,
 * OVHcloud EU, Vireonix, ch.at, LLM7, Rewind AI, Free.ai, VLM Run, BlockRun,
 * Pollinations, ChatJimmy, mlvoca, AI Horde, Stillworks Live Shelf, and local
 * zero-key Ollama / LM Studio / llama.cpp / Jan servers) behind native DSH routes
 * with smart multi-provider failover.
 *
 * Only `llm` is declared in root `inject` so headless/CLI compositions without a
 * web server still mount all keyless models cleanly.
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAttributionUserAgent, FALLBACK_USER_AGENT } from './adapter/kernel.js'
import { DATA_DIR_NAME, createPluginStores, resolveDshHome } from './src/store.js'
import { KeylessRouterPool } from './src/router.js'
import { KeylessModelsAdapter } from './src/adapter.js'
import {
  refreshEnabledCatalogs,
  scanLocalZeroKeyServers,
  syncStillworksLiveShelf,
} from './src/discovery.js'
import { registerManagementRoutes } from './src/api.js'
import { startLocalForwardProxy } from './src/forward.js'

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')
    return String(JSON.parse(raw).version || '1.0.0')
  } catch {
    return '1.0.0'
  }
}

export const name = 'keylessmodels2dsh'
export const version = readPackageVersion()

/** Root service requirement — keeps headless compositions functional without `webServer`. */
export const inject = ['llm']

/**
 * Mount the `keylessmodels2dsh` host plugin onto a Cordis / DeepSeek Harness context.
 *
 * @param {any} ctx
 * @param {Record<string, any>} [config]
 * @returns {() => void} disposer
 */
export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? console
  const dshHome =
    typeof config.dshHome === 'string' && config.dshHome.trim().length > 0
      ? config.dshHome.trim()
      : resolveDshHome()
  const dataDir =
    typeof config.dataDir === 'string' && config.dataDir.trim().length > 0
      ? config.dataDir.trim()
      : path.join(dshHome, DATA_DIR_NAME)

  const stores = createPluginStores({ dataDir, logger })
  if (config.settings && typeof config.settings === 'object') {
    stores.settings.update(config.settings)
  }

  const pool = new KeylessRouterPool({ stores, logger })
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : undefined

  let userAgent = FALLBACK_USER_AGENT
  void resolveAttributionUserAgent(logger).then((ua) => {
    userAgent = ua
  })

  const resolveImage = (attachment) => {
    const attService = ctx?.get?.('attachments')
    if (attService && typeof attService.readDataUrl === 'function') {
      try {
        return attService.readDataUrl(attachment)
      } catch {}
    }
    return undefined
  }

  const adapter = new KeylessModelsAdapter({
    pool,
    getUserAgent: () => userAgent,
    fetchImpl,
    resolveImage,
    idleTimeoutMs: typeof config.idleTimeoutMs === 'number' ? config.idleTimeoutMs : undefined,
    logger,
  })

  /** @type {Array<() => void>} */
  const disposers = []
  let disposed = false

  // 1. Register LLM provider routes on `ctx.llm`
  const llm = ctx?.llm ?? ctx?.get?.('llm')
  /** @type {any} */
  let routeHandle = null

  if (llm && typeof llm.registerAdapter === 'function') {
    try {
      routeHandle = llm.registerAdapter(pool.desiredDshRoutes(), adapter)
      disposers.push(() => {
        try {
          routeHandle?.()
        } catch {}
      })
    } catch (error) {
      logger?.warn?.(
        `keylessmodels2dsh: failed to register LLM adapter routes: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else {
    logger?.warn?.('keylessmodels2dsh: llm service unavailable; adapter was not registered')
  }

  // 2. Manage optional loopback OpenAI-compatible proxy (`127.0.0.1:<port>/v1`)
  /** @type {Awaited<ReturnType<typeof startLocalForwardProxy>> | null} */
  let activeProxy = null
  let activeProxyPort = 0
  let activeProxyKey = ''
  let proxyError = ''

  const reconcileLocalProxy = async () => {
    if (disposed) return
    const s = pool.getSettings()
    if (!s.localProxyEnabled) {
      if (activeProxy) {
        const prev = activeProxy
        activeProxy = null
        activeProxyPort = 0
        await prev.close().catch(() => {})
      }
      proxyError = ''
      return
    }

    const wantPort = Number(s.localProxyPort) || 18788
    const wantKey = String(s.localProxyKey ?? '')
    if (activeProxy && activeProxyPort === wantPort && activeProxyKey === wantKey) {
      return
    }

    if (activeProxy) {
      const prev = activeProxy
      activeProxy = null
      await prev.close().catch(() => {})
    }

    try {
      activeProxy = await startLocalForwardProxy({
        port: wantPort,
        apiKey: wantKey,
        adapter,
        logger,
      })
      activeProxyPort = activeProxy.port
      activeProxyKey = wantKey
      proxyError = ''
    } catch (err) {
      proxyError = err instanceof Error ? err.message : String(err)
      logger?.warn?.(`keylessmodels2dsh: local proxy could not bind port ${wantPort}: ${proxyError}`)
    }
  }

  const notifyTopologyChanged = async () => {
    if (disposed) return
    if (routeHandle && typeof routeHandle.replace === 'function') {
      try {
        routeHandle.replace(pool.desiredDshRoutes())
      } catch (err) {
        logger?.warn?.(
          `keylessmodels2dsh: route replacement warning: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    await reconcileLocalProxy()
  }

  void reconcileLocalProxy()

  disposers.push(() => {
    if (activeProxy) {
      const p = activeProxy
      activeProxy = null
      void p.close().catch(() => {})
    }
  })

  // 3. Mount `/api/keylessmodels2dsh/*` onto `webServer` via non-blocking nested `ctx.inject`
  const mountWebRoutes = (webServer) =>
    registerManagementRoutes(webServer, {
      pool,
      version,
      dshHome,
      getConnection: () => ctx?.get?.('connection'),
      getUserAgent: () => userAgent,
      fetchImpl,
      onTopologyChanged: notifyTopologyChanged,
      getProxyStatus: () => ({
        running: activeProxy !== null,
        ...(activeProxy ? { baseUrl: activeProxy.baseUrl, port: activeProxy.port } : {}),
        ...(proxyError ? { error: proxyError } : {}),
      }),
    })

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const ws = webCtx?.webServer ?? webCtx?.get?.('webServer')
      if (!ws || typeof ws.register !== 'function') return
      const disposeRoutes = mountWebRoutes(ws)
      if (typeof webCtx.effect === 'function') {
        webCtx.effect(() => disposeRoutes, 'keylessmodels2dsh: management HTTP routes')
      } else {
        disposers.push(disposeRoutes)
      }
    })
  } else {
    const ws = ctx?.webServer ?? ctx?.get?.('webServer')
    if (ws && typeof ws.register === 'function') {
      disposers.push(mountWebRoutes(ws))
    }
  }

  // 4. Non-blocking initial background discovery (disable via `config.disableAutoBootNetwork = true` in tests)
  if (config.disableAutoBootNetwork !== true) {
    const bootTimer = setTimeout(async () => {
      if (disposed) return
      const s = pool.getSettings()
      if (s.autoScanLocalServers) {
        await scanLocalZeroKeyServers(pool, {
          fetchImpl,
          userAgent,
          onUpdated: () => void notifyTopologyChanged(),
        }).catch(() => {})
      }
      if (disposed) return
      if (s.syncStillworksShelf) {
        await syncStillworksLiveShelf(pool, {
          fetchImpl,
          userAgent,
          onUpdated: () => void notifyTopologyChanged(),
        }).catch(() => {})
      }
      if (disposed) return
      if (s.autoDiscoverModels) {
        await refreshEnabledCatalogs(pool, {
          fetchImpl,
          userAgent,
          onUpdated: () => void notifyTopologyChanged(),
        }).catch(() => {})
      }
    }, 1200)
    bootTimer.unref?.()
    disposers.push(() => clearTimeout(bootTimer))

    const periodicTimer = setInterval(async () => {
      if (disposed) return
      const s = pool.getSettings()
      if (!s.autoDiscoverModels || !s.enabled) return
      await refreshEnabledCatalogs(pool, {
        fetchImpl,
        userAgent,
        onUpdated: () => void notifyTopologyChanged(),
      }).catch(() => {})
    }, 30 * 60 * 1000)
    periodicTimer.unref?.()
    disposers.push(() => clearInterval(periodicTimer))
  }

  const cleanupAll = () => {
    if (disposed) return
    disposed = true
    for (const d of disposers.splice(0).reverse()) {
      try {
        d()
      } catch {}
    }
    stores.dispose()
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => cleanupAll, 'keylessmodels2dsh: lifecycle')
  }

  return cleanupAll
}

export { KeylessModelsAdapter } from './src/adapter.js'
export { KeylessRouterPool } from './src/router.js'
export { BUILTIN_PROVIDERS, VIRTUAL_MODELS, UNIFIED_ROUTE } from './src/providers.js'
