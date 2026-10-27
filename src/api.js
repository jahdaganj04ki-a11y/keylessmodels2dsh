/**
 * Host HTTP management API (`/api/keylessmodels2dsh/*`) mounted on `ctx.webServer`.
 *
 * Serves the in-app Settings UI (`client.js`) inside DSH Desktop with live provider
 * state, model discovery, Stillworks shelf sync, local server scanning, 1-click
 * model probing, cooldown reset, and custom keyless provider management.
 *
 * @module src/api.js
 */

import { REJECTED_KEYLESS_CLAIMS, VIRTUAL_MODELS } from './providers.js'
import { normalizeCustomProvider } from './router.js'
import {
  probeSingleModel,
  refreshEnabledCatalogs,
  scanLocalZeroKeyServers,
  syncStillworksLiveShelf,
} from './discovery.js'
import { admitPluginRequest } from './trust.js'

export const API_PREFIX = '/api/keylessmodels2dsh'

const MAX_JSON_BYTES = 256 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_JSON_BYTES) {
        reject(new Error('Payload exceeds limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Build a complete UI snapshot of providers, models, virtual routers, settings, and telemetry.
 *
 * @param {{
 *   pool: import('./router.js').KeylessRouterPool;
 *   version: string;
 *   dshHome: string;
 *   getProxyStatus: () => { running: boolean; baseUrl?: string; error?: string };
 * }} deps
 */
export function buildUiSnapshot(deps) {
  const settings = deps.pool.getSettings()
  const rt = deps.pool.getRuntimeState()
  const providers = deps.pool.listProviders()
  const catalog = deps.pool.buildCatalog({ includeDisabledProviders: true, includeHidden: true })
  const hiddenSet = new Set(settings.hiddenModels ?? [])

  const modelsByProvider = new Map()
  for (const m of catalog) {
    let arr = modelsByProvider.get(m.providerId)
    if (!arr) {
      arr = []
      modelsByProvider.set(m.providerId, arr)
    }
    arr.push({
      ...m,
      hidden: hiddenSet.has(m.compositeId),
    })
  }

  return {
    version: deps.version,
    platform: process.platform,
    dshHome: deps.dshHome,
    settings,
    proxy: deps.getProxyStatus(),
    virtualModels: VIRTUAL_MODELS,
    providers: providers.map((p) => {
      const pModels = modelsByProvider.get(p.id) ?? []
      const healthyCount = pModels.filter((m) => m.health.status === 'healthy' && !m.health.coolingDown).length
      const cooldownCount = pModels.filter((m) => m.health.coolingDown).length
      return {
        id: p.id,
        name: p.name,
        shortName: p.shortName,
        category: p.category,
        wire: p.wire,
        enabled: p.enabled,
        autoEligible: p.autoEligible,
        baseUrl: p.baseUrl,
        rateLimitNote: p.rateLimitNote,
        privacyNote: p.privacyNote,
        website: p.website,
        modelCount: pModels.length,
        healthyCount,
        cooldownCount,
        models: pModels,
      }
    }),
    stillworksSyncedAt: rt.stillworksSyncedAt || 0,
    stats: rt.stats ?? {},
    rejectedClaims: REJECTED_KEYLESS_CLAIMS,
  }
}

/**
 * Register `/api/keylessmodels2dsh/*` routes on `webServer`.
 *
 * @param {any} webServer
 * @param {{
 *   pool: import('./router.js').KeylessRouterPool;
 *   version: string;
 *   dshHome: string;
 *   getConnection: () => any;
 *   getUserAgent: () => string;
 *   fetchImpl?: typeof fetch;
 *   onTopologyChanged: () => Promise<void> | void;
 *   getProxyStatus: () => { running: boolean; baseUrl?: string; error?: string };
 * }} deps
 * @returns {() => void} disposer
 */
export function registerManagementRoutes(webServer, deps) {
  const disposers = []

  const registerExact = (subpath, method, handler) => {
    const fullPath = `${API_PREFIX}${subpath}`
    const dispose = webServer.register({
      kind: 'exact',
      path: fullPath,
      handler: async (req, res) => {
        const rejection = admitPluginRequest(req, deps.getConnection)
        if (rejection !== undefined) {
          sendJson(res, rejection, { error: 'Request rejected by security fence.' })
          return
        }
        if (req.method !== method) {
          sendJson(res, 405, { error: `Method ${req.method} not allowed.` })
          return
        }
        try {
          await handler(req, res)
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  registerExact('/state', 'GET', async (_req, res) => {
    sendJson(res, 200, buildUiSnapshot(deps))
  })

  registerExact('/settings', 'POST', async (req, res) => {
    const body = await readJson(req)
    const allowedPatch = {}

    for (const boolKey of [
      'enabled',
      'exposePerProviderRoutes',
      'autoDiscoverModels',
      'syncStillworksShelf',
      'autoScanLocalServers',
      'stickyAutoRouting',
      'fallbackOnConcreteModel429',
      'localProxyEnabled',
    ]) {
      if (typeof body[boolKey] === 'boolean') allowedPatch[boolKey] = body[boolKey]
    }

    for (const [numKey, min, max] of [
      ['catalogTtlMinutes', 5, 1440],
      ['maxFailoverAttempts', 1, 12],
      ['defaultMaxTokens', 512, 65536],
      ['cooldown429Seconds', 5, 3600],
      ['cooldownAuthSeconds', 30, 86400],
      ['localProxyPort', 1024, 65535],
    ]) {
      if (typeof body[numKey] === 'number' && Number.isFinite(body[numKey])) {
        allowedPatch[numKey] = Math.max(min, Math.min(max, Math.floor(body[numKey])))
      }
    }

    if (typeof body.localProxyKey === 'string') {
      allowedPatch.localProxyKey = body.localProxyKey.trim()
    }

    if (body.providerToggle && typeof body.providerToggle === 'object') {
      const { id, enabled } = body.providerToggle
      if (typeof id === 'string' && typeof enabled === 'boolean') {
        const currentToggles = { ...(deps.pool.getSettings().providerToggles ?? {}) }
        currentToggles[id] = enabled
        allowedPatch.providerToggles = currentToggles
      }
    }

    if (body.modelVisibility && typeof body.modelVisibility === 'object') {
      const { compositeId, hidden } = body.modelVisibility
      if (typeof compositeId === 'string' && typeof hidden === 'boolean') {
        const set = new Set(deps.pool.getSettings().hiddenModels ?? [])
        if (hidden) set.add(compositeId)
        else set.delete(compositeId)
        allowedPatch.hiddenModels = [...set]
      }
    }

    deps.pool.stores.settings.update(allowedPatch)
    deps.pool.stores.settings.flush()
    await deps.onTopologyChanged()
    sendJson(res, 200, { ok: true, state: buildUiSnapshot(deps) })
  })

  registerExact('/refresh', 'POST', async (req, res) => {
    const body = await readJson(req)
    const providerIds = Array.isArray(body.providerIds) ? body.providerIds.map(String) : undefined
    const summary = await refreshEnabledCatalogs(deps.pool, {
      providerIds,
      fetchImpl: deps.fetchImpl,
      userAgent: deps.getUserAgent(),
      onUpdated: () => void deps.onTopologyChanged(),
    })
    deps.pool.stores.runtimeState.flush()
    sendJson(res, 200, { ok: true, summary, state: buildUiSnapshot(deps) })
  })

  registerExact('/scan-local', 'POST', async (_req, res) => {
    const detected = await scanLocalZeroKeyServers(deps.pool, {
      fetchImpl: deps.fetchImpl,
      userAgent: deps.getUserAgent(),
      onUpdated: () => void deps.onTopologyChanged(),
    })
    deps.pool.stores.runtimeState.flush()
    sendJson(res, 200, { ok: true, detected, state: buildUiSnapshot(deps) })
  })

  registerExact('/sync-shelf', 'POST', async (_req, res) => {
    const result = await syncStillworksLiveShelf(deps.pool, {
      fetchImpl: deps.fetchImpl,
      userAgent: deps.getUserAgent(),
      onUpdated: () => void deps.onTopologyChanged(),
    })
    deps.pool.stores.runtimeState.flush()
    sendJson(res, 200, { ...result, state: buildUiSnapshot(deps) })
  })

  registerExact('/probe', 'POST', async (req, res) => {
    const body = await readJson(req)
    const compositeId = String(body.compositeId ?? '').trim()
    if (!compositeId) {
      sendJson(res, 400, { ok: false, error: 'compositeId fehlt.' })
      return
    }
    const probe = await probeSingleModel(deps.pool, compositeId, {
      fetchImpl: deps.fetchImpl,
      userAgent: deps.getUserAgent(),
    })
    deps.pool.stores.runtimeState.flush()
    sendJson(res, 200, { ...probe, state: buildUiSnapshot(deps) })
  })

  registerExact('/reset-cooldowns', 'POST', async (req, res) => {
    const body = await readJson(req)
    const providerId = typeof body.providerId === 'string' && body.providerId ? body.providerId : undefined
    deps.pool.resetCooldowns(providerId)
    deps.pool.stores.runtimeState.flush()
    await deps.onTopologyChanged()
    sendJson(res, 200, { ok: true, state: buildUiSnapshot(deps) })
  })

  registerExact('/custom-provider', 'POST', async (req, res) => {
    const body = await readJson(req)
    if (body.action === 'delete' && typeof body.id === 'string') {
      const next = (deps.pool.getSettings().customProviders ?? []).filter((p) => p.id !== body.id)
      deps.pool.stores.settings.update({ customProviders: next })
      deps.pool.stores.settings.flush()
      await deps.onTopologyChanged()
      sendJson(res, 200, { ok: true, state: buildUiSnapshot(deps) })
      return
    }

    const normalized = normalizeCustomProvider(body.provider ?? body)
    if (!normalized) {
      sendJson(res, 400, {
        ok: false,
        error: 'Ungültiger Custom-Provider (id und http/https baseUrl erforderlich).',
      })
      return
    }
    const existing = (deps.pool.getSettings().customProviders ?? []).filter((p) => p.id !== normalized.id)
    existing.push({
      id: normalized.id,
      name: normalized.name,
      baseUrl: normalized.baseUrl,
      wire: normalized.wire,
      modelsPath: normalized.modelsPath,
      chatPath: normalized.chatPath,
      staticModels: normalized.staticModels.map((m) => m.id),
      headers: normalized.headers,
    })
    deps.pool.stores.settings.update({ customProviders: existing })
    deps.pool.stores.settings.flush()
    await deps.onTopologyChanged()
    sendJson(res, 200, { ok: true, provider: normalized, state: buildUiSnapshot(deps) })
  })

  return () => {
    for (const d of disposers.splice(0).reverse()) {
      try {
        d()
      } catch {}
    }
  }
}
