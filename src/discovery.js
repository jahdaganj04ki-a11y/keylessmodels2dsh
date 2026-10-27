/**
 * Live Model Catalog Discovery, Stillworks Live Keyless Shelf Sync,
 * Local Zero-Key Server Auto-Scanner, and Lightweight On-Demand Endpoint Prober.
 *
 * Never mutates or wraps `globalThis.fetch` (preserving `dsh-experimental-inspector`
 * compatibility in DSH Desktop `v0.12.1`).
 *
 * @module src/discovery.js
 */

import {
  STILLWORKS_SHELF_URL,
  extractRawModelList,
  isFreeOnProvider,
  normalizeModelEntry,
} from './providers.js'
import { classifyHttpError, readChatJimmyResponseChunks, readOllamaResponseChunks, readOpenAiResponseChunks } from './stream.js'

const CATALOG_TIMEOUT_MS = 12_000
const LOCAL_SCAN_TIMEOUT_MS = 1_800
const PROBE_TIMEOUT_MS = 18_000

/**
 * Fetch the live `/models` (or `/api/tags`) listing of a single provider.
 *
 * @param {Record<string, any>} provider
 * @param {{ fetchImpl?: typeof fetch; userAgent?: string; timeoutMs?: number; signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean; models: any[]; error?: string }>}
 */
export async function discoverProviderModels(provider, opts = {}) {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch
  const modelsUrl =
    typeof provider.modelsUrl === 'string' && provider.modelsUrl.length > 0
      ? provider.modelsUrl
      : provider.modelsPath
        ? `${provider.baseUrl.replace(/\/+$/, '')}${provider.modelsPath}`
        : null

  if (!modelsUrl) {
    return {
      ok: true,
      models: (provider.staticModels ?? [])
        .map((m) => normalizeModelEntry(provider, m))
        .filter(Boolean),
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CATALOG_TIMEOUT_MS)
  timer.unref?.()
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const headers = {
      Accept: 'application/json',
      ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}),
      ...(provider.headers ?? {}),
    }
    const res = await fetchFn(modelsUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })

    const text = await res.text()
    if (!res.ok) {
      return { ok: false, models: [], error: `HTTP ${res.status}: ${text.slice(0, 160)}` }
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, models: [], error: 'Ungültiges JSON von /models' }
    }

    const rawItems = extractRawModelList(parsed)
    const kept = []
    for (const raw of rawItems) {
      const obj = typeof raw === 'string' ? { id: raw } : raw
      if (!obj || typeof obj !== 'object') continue
      // Ollama `/api/tags` uses `name` instead of `id`
      if (!obj.id && typeof obj.name === 'string') obj.id = obj.name
      if (!isFreeOnProvider(provider, obj)) continue
      const normalized = normalizeModelEntry(provider, obj)
      if (normalized) {
        kept.push({
          id: normalized.modelId,
          name: normalized.shortLabel,
          contextWindow: normalized.contextWindow,
          maxTokens: normalized.maxTokens,
          vision: normalized.vision,
          tools: normalized.tools,
          reasoning: normalized.reasoning,
          reasoningCannotDisable: normalized.reasoningCannotDisable,
        })
      }
    }

    return { ok: true, models: kept }
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Refresh live catalogs across all enabled cloud providers (or a specified subset).
 *
 * @param {import('./router.js').KeylessRouterPool} pool
 * @param {{ providerIds?: string[]; fetchImpl?: typeof fetch; userAgent?: string; onUpdated?: () => void }} [opts]
 */
export async function refreshEnabledCatalogs(pool, opts = {}) {
  const targets = pool
    .listProviders()
    .filter((p) =>
      opts.providerIds ? opts.providerIds.includes(p.id) : p.enabled && p.category !== 'local',
    )

  const summary = []
  await Promise.allSettled(
    targets.map(async (provider) => {
      if (!provider.modelsUrl && !provider.modelsPath) {
        summary.push({ providerId: provider.id, ok: true, count: provider.staticModels?.length ?? 0, staticOnly: true })
        return
      }
      const res = await discoverProviderModels(provider, {
        fetchImpl: opts.fetchImpl,
        userAgent: opts.userAgent,
      })
      if (res.ok && res.models.length > 0) {
        pool.stores.runtimeState.edit((draft) => {
          draft.discoveredModels ??= {}
          draft.discoveredModels[provider.id] = res.models
        })
      }
      summary.push({
        providerId: provider.id,
        ok: res.ok,
        count: res.models.length,
        ...(res.error ? { error: res.error } : {}),
      })
    }),
  )

  opts.onUpdated?.()
  return summary
}

/**
 * Scan local Windows/macOS/Linux loopback ports (`127.0.0.1:11434`, `1234`, `8080`, `1337`)
 * for running zero-key servers (Ollama, LM Studio, llama.cpp, Jan).
 *
 * @param {import('./router.js').KeylessRouterPool} pool
 * @param {{ fetchImpl?: typeof fetch; userAgent?: string; onUpdated?: () => void }} [opts]
 */
export async function scanLocalZeroKeyServers(pool, opts = {}) {
  const localProviders = pool.listProviders().filter((p) => p.category === 'local')
  const detected = []

  await Promise.allSettled(
    localProviders.map(async (provider) => {
      const res = await discoverProviderModels(provider, {
        fetchImpl: opts.fetchImpl,
        userAgent: opts.userAgent,
        timeoutMs: LOCAL_SCAN_TIMEOUT_MS,
      })
      pool.stores.runtimeState.edit((draft) => {
        draft.discoveredModels ??= {}
        draft.discoveredModels[provider.id] = res.ok ? res.models : []
      })
      detected.push({
        id: provider.id,
        providerId: provider.id,
        name: provider.name,
        online: res.ok,
        models: res.models.map((m) => m.id),
      })
    }),
  )

  opts.onUpdated?.()
  return detected
}

/**
 * Synchronize live-verified keyless endpoints from Stillworks (`GET /api/llm/up`).
 * Maps matching hosts onto built-in providers and imports any brand-new working keyless hosts!
 *
 * @param {import('./router.js').KeylessRouterPool} pool
 * @param {{ fetchImpl?: typeof fetch; userAgent?: string; onUpdated?: () => void }} [opts]
 */
export async function syncStillworksLiveShelf(pool, opts = {}) {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  timer.unref?.()

  try {
    const res = await fetchFn(STILLWORKS_SHELF_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} von Stillworks Shelf`)
    }
    const payload = await res.json()
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.endpoints)
        ? payload.endpoints
        : Array.isArray(payload?.items)
          ? payload.items
          : Array.isArray(payload?.data)
            ? payload.data
            : []

    const builtinByHost = new Map()
    for (const p of pool.listProviders()) {
      try {
        builtinByHost.set(new URL(p.baseUrl).hostname.toLowerCase(), p.id)
      } catch {}
    }

    /** @type {Map<string, { providerId: string; providerName: string; baseUrl: string; wire: string; models: any[] }>} */
    const newDynamic = new Map()
    let matchedBuiltins = 0

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const base = String(row.base_url ?? row.baseUrl ?? row.endpoint ?? row.url ?? '')
        .trim()
        .replace(/\/+$/, '')
      const modelId = String(row.model ?? row.model_id ?? row.id ?? '').trim()
      if (!base || !modelId || !/^https?:\/\//i.test(base)) continue

      let hostname = ''
      try {
        hostname = new URL(base).hostname.toLowerCase()
      } catch {
        continue
      }

      const existingPid = builtinByHost.get(hostname)
      if (existingPid) {
        matchedBuiltins += 1
        const latency = Number(row.latency_ms ?? row.ttft_ms ?? 0)
        pool.stores.runtimeState.edit((draft) => {
          draft.discoveredModels ??= {}
          const list = draft.discoveredModels[existingPid] ?? []
          if (!list.some((m) => m.id === modelId)) {
            list.push({ id: modelId, name: modelId, tools: Boolean(row.tools ?? true) })
            draft.discoveredModels[existingPid] = list
          }
          if (latency > 0) {
            draft.health ??= {}
            const cid = `${existingPid}/${modelId}`
            draft.health[cid] = {
              ...(draft.health[cid] ?? {}),
              status: 'healthy',
              cooldownUntil: 0,
              ttftMs: latency,
              lastUsedAt: Date.now(),
            }
          }
        })
        continue
      }

      const slug = `shelf-${hostname.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28)}`
      const wire = String(row.format ?? row.wire ?? 'openai').toLowerCase().includes('ollama')
        ? 'ollama'
        : 'openai'
      let dyn = newDynamic.get(slug)
      if (!dyn) {
        dyn = {
          providerId: slug,
          providerName: String(row.provider ?? row.name ?? hostname),
          baseUrl: base,
          wire,
          models: [],
        }
        newDynamic.set(slug, dyn)
      }
      if (!dyn.models.some((m) => m.id === modelId)) {
        dyn.models.push({
          id: modelId,
          name: modelId,
          tools: Boolean(row.tools ?? wire === 'openai'),
        })
      }
    }

    const dynamicList = [...newDynamic.values()]
    pool.stores.runtimeState.edit((draft) => {
      draft.stillworksModels = dynamicList
      draft.stillworksSyncedAt = Date.now()
    })
    opts.onUpdated?.()

    return {
      ok: true,
      totalRows: rows.length,
      matchedBuiltins,
      newProviders: dynamicList.length,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Lightweight on-demand 1-token chat probe (`max_tokens: 4`) to verify real chat
 * availability and measure TTFT for a specific `provider/model`.
 *
 * Deliberately triggered ONLY on explicit user action in the Settings UI (never
 * on an automatic background loop) so free per-IP quotas are never burned silently!
 *
 * @param {import('./router.js').KeylessRouterPool} pool
 * @param {string} compositeId
 * @param {{ fetchImpl?: typeof fetch; userAgent?: string }} [opts]
 */
export async function probeSingleModel(pool, compositeId, opts = {}) {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch
  const resolved = pool.resolveTarget('keyless-free', compositeId)
  if (resolved.kind !== 'concrete' || !resolved.provider || !resolved.entry) {
    return { ok: false, compositeId, error: `Unbekanntes Modell: ${compositeId}` }
  }

  const { provider, entry } = resolved
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  timer.unref?.()

  try {
    const chatUrl = `${provider.baseUrl.replace(/\/+$/, '')}${provider.chatPath}`
    const headers = {
      'Content-Type': 'application/json',
      Accept: provider.wire === 'openai' && !provider.noStream ? 'text/event-stream' : 'application/json',
      ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}),
      ...(provider.headers ?? {}),
    }

    let body
    if (provider.wire === 'chatjimmy') {
      body = {
        chatOptions: { selectedModel: entry.modelId, max_tokens: 4, temperature: 0 },
        messages: [{ role: 'user', content: 'Reply OK' }],
        stream: true,
      }
    } else if (provider.wire === 'ollama') {
      body = {
        model: entry.modelId,
        prompt: 'Reply OK',
        stream: false,
        options: { num_predict: 4 },
      }
    } else {
      body = {
        model: entry.modelId,
        messages: [{ role: 'user', content: 'Reply OK' }],
        max_tokens: entry.reasoning ? 64 : 8,
        temperature: 0,
        stream: provider.noStream !== true,
      }
    }

    const res = await fetchFn(chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      const classified = classifyHttpError(res.status, errBody, {
        providerId: provider.id,
        modelId: entry.modelId,
      })
      pool.recordFailure({
        compositeId: entry.compositeId,
        providerId: provider.id,
        requestedModel: entry.compositeId,
        error: classified,
        latencyMs: Date.now() - startedAt,
      })
      return { ok: false, compositeId: entry.compositeId, error: classified.message, code: classified.code }
    }

    let ttftMs = null
    let preview = ''
    const readerGen =
      provider.wire === 'chatjimmy'
        ? readChatJimmyResponseChunks(res, { providerId: provider.id, modelId: entry.modelId })
        : provider.wire === 'ollama'
          ? readOllamaResponseChunks(res, { providerId: provider.id, modelId: entry.modelId })
          : readOpenAiResponseChunks(res, { providerId: provider.id, modelId: entry.modelId })

    for await (const chunk of readerGen) {
      if (
        ttftMs === null &&
        (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')
      ) {
        ttftMs = Date.now() - startedAt
      }
      if (chunk.type === 'text-delta') preview += chunk.text
    }

    const latencyMs = Date.now() - startedAt
    pool.recordSuccess({
      compositeId: entry.compositeId,
      providerId: provider.id,
      requestedModel: entry.compositeId,
      ttftMs: ttftMs ?? latencyMs,
      latencyMs,
    })

    return {
      ok: true,
      compositeId: entry.compositeId,
      ttftMs: ttftMs ?? latencyMs,
      latencyMs,
      preview: preview.trim().slice(0, 80),
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    pool.recordFailure({
      compositeId: entry.compositeId,
      providerId: provider.id,
      requestedModel: entry.compositeId,
      error,
      latencyMs,
    })
    return {
      ok: false,
      compositeId: entry.compositeId,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}
