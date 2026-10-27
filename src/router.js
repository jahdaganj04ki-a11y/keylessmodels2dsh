/**
 * Multi-provider Keyless Pool, Cooldown State Machine, Concurrency/Burst Limiter,
 * and Smart Auto-Router (`auto`, `auto-coding`, `auto-fast`, `auto-reasoning`, `auto-vision`).
 *
 * @module src/router.js
 */

import {
  BUILTIN_PROVIDERS,
  PROVIDER_ROUTE_PREFIX,
  UNIFIED_ROUTE,
  VIRTUAL_MODELS,
  findVirtualModel,
  normalizeModelEntry,
} from './providers.js'
import { ERROR_CODES } from './stream.js'

/**
 * Sanitize and normalize a user-defined custom keyless provider entry.
 *
 * @param {Record<string, any>} raw
 * @returns {Record<string, any> | null}
 */
export function normalizeCustomProvider(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
  const baseUrl = String(raw.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!id || !baseUrl || !/^https?:\/\//i.test(baseUrl)) return null

  const wire = ['openai', 'ollama', 'chatjimmy'].includes(raw.wire) ? raw.wire : 'openai'
  const staticModels = Array.isArray(raw.staticModels)
    ? raw.staticModels
        .map((m) => (typeof m === 'string' ? m.trim() : String(m?.id ?? '').trim()))
        .filter(Boolean)
        .map((m) => ({ id: m, tools: wire === 'openai' }))
    : []

  const headers = {}
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [k, v] of Object.entries(raw.headers)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
        headers[k.trim()] = v.trim()
      }
    }
  }

  return {
    id,
    name: String(raw.name || id).trim(),
    shortName: String(raw.shortName || raw.name || id).trim().slice(0, 18),
    category: 'custom',
    wire,
    enabledByDefault: raw.enabled !== false,
    autoEligible: raw.autoEligible !== false && wire === 'openai',
    baseUrl,
    modelsPath:
      raw.modelsPath === null
        ? null
        : typeof raw.modelsPath === 'string' && raw.modelsPath.trim()
          ? raw.modelsPath.trim()
          : wire === 'ollama'
            ? '/api/tags'
            : '/models',
    chatPath:
      typeof raw.chatPath === 'string' && raw.chatPath.trim()
        ? raw.chatPath.trim()
        : wire === 'ollama'
          ? '/api/generate'
          : '/chat/completions',
    headers,
    freeRule: { type: 'all-chat' },
    concurrency: Math.max(1, Math.min(16, Math.floor(Number(raw.concurrency) || 2))),
    minIntervalMs: Math.max(0, Math.floor(Number(raw.minIntervalMs) || 0)),
    rateLimitNote: String(raw.rateLimitNote || 'Benutzerdefinierter Keyless-Endpunkt'),
    privacyNote: String(raw.privacyNote || baseUrl),
    website: baseUrl,
    priority: Math.max(1, Math.min(120, Math.floor(Number(raw.priority) || 85))),
    staticModels,
  }
}

export class KeylessRouterPool {
  /**
   * @param {{ stores: ReturnType<import('./store.js').createPluginStores>; logger?: any }} options
   */
  constructor({ stores, logger }) {
    this.stores = stores
    this.logger = logger
    /** @type {Map<string, { active: number; lastStartedAt: number; queue: Array<() => void> }>} */
    this.gates = new Map()
    /** @type {Map<string, string>} sessionOrIntentKey -> compositeId */
    this.stickyChoices = new Map()
  }

  getSettings() {
    return this.stores.settings.get()
  }

  getRuntimeState() {
    return this.stores.runtimeState.get()
  }

  /**
   * Return all built-in + custom + dynamic Stillworks providers with their effective `enabled` status.
   */
  listProviders() {
    const settings = this.getSettings()
    const rt = this.getRuntimeState()
    const toggles = settings.providerToggles ?? {}

    const list = []
    const seenIds = new Set()

    for (const builtin of BUILTIN_PROVIDERS) {
      seenIds.add(builtin.id)
      const discovered = rt.discoveredModels?.[builtin.id]
      const autoEnabledLocal =
        builtin.category === 'local' && Array.isArray(discovered) && discovered.length > 0
      const enabled =
        typeof toggles[builtin.id] === 'boolean'
          ? toggles[builtin.id]
          : autoEnabledLocal || builtin.enabledByDefault === true
      list.push({ ...builtin, enabled })
    }

    for (const rawCustom of settings.customProviders ?? []) {
      const custom = normalizeCustomProvider(rawCustom)
      if (!custom || seenIds.has(custom.id)) continue
      seenIds.add(custom.id)
      const enabled =
        typeof toggles[custom.id] === 'boolean' ? toggles[custom.id] : custom.enabledByDefault
      list.push({ ...custom, enabled })
    }

    // Dynamic providers imported from Stillworks live shelf that aren't already built-in
    for (const dyn of rt.stillworksModels ?? []) {
      if (!dyn?.providerId || seenIds.has(dyn.providerId)) continue
      seenIds.add(dyn.providerId)
      const enabled = typeof toggles[dyn.providerId] === 'boolean' ? toggles[dyn.providerId] : true
      list.push({
        id: dyn.providerId,
        name: `${dyn.providerName || dyn.providerId} (Stillworks Live)`,
        shortName: dyn.providerName || dyn.providerId,
        category: 'live-shelf',
        wire: dyn.wire === 'ollama' ? 'ollama' : 'openai',
        enabledByDefault: true,
        enabled,
        autoEligible: dyn.wire !== 'ollama',
        baseUrl: dyn.baseUrl,
        modelsPath: dyn.wire === 'ollama' ? '/api/tags' : '/models',
        chatPath: dyn.wire === 'ollama' ? '/api/generate' : '/chat/completions',
        headers: {},
        freeRule: { type: 'all-chat' },
        concurrency: 2,
        minIntervalMs: 500,
        rateLimitNote: 'Automatisch aus dem stündlich geprüften Stillworks-Keyless-Feed synchronisiert',
        privacyNote: dyn.baseUrl,
        website: 'https://stillworks.supercapybara.com',
        priority: 76,
        staticModels: dyn.models ?? [],
      })
    }

    return list
  }

  /**
   * Look up one provider by ID.
   *
   * @param {string} providerId
   */
  getProvider(providerId) {
    return this.listProviders().find((p) => p.id === providerId) ?? null
  }

  /**
   * Compute the DSH provider routes that should currently be registered on `ctx.llm`.
   *
   * @returns {string[]}
   */
  desiredDshRoutes() {
    const settings = this.getSettings()
    const routes = [UNIFIED_ROUTE]
    if (settings.exposePerProviderRoutes === true) {
      for (const provider of this.listProviders()) {
        if (provider.enabled) {
          routes.push(`${PROVIDER_ROUTE_PREFIX}${provider.id}`)
        }
      }
    }
    return routes
  }

  /**
   * Human-readable provider route title for DSH Desktop's Model Picker.
   *
   * @param {string} routeId
   */
  routeDisplayName(routeId) {
    if (routeId === UNIFIED_ROUTE) return 'Keyless Free Models'
    if (routeId.startsWith(PROVIDER_ROUTE_PREFIX)) {
      const pid = routeId.slice(PROVIDER_ROUTE_PREFIX.length)
      const p = this.getProvider(pid)
      if (p) return `Keyless · ${p.shortName || p.name}`
    }
    return routeId
  }

  /**
   * Build the complete catalog of concrete models across all enabled (or all) providers.
   *
   * @param {{ includeDisabledProviders?: boolean; includeHidden?: boolean }} [opts]
   */
  buildCatalog(opts = {}) {
    const settings = this.getSettings()
    const rt = this.getRuntimeState()
    const hiddenSet = new Set(settings.hiddenModels ?? [])
    const out = []
    const seen = new Set()

    for (const provider of this.listProviders()) {
      if (!opts.includeDisabledProviders && !provider.enabled) continue

      const discoveredList = rt.discoveredModels?.[provider.id]
      const rawItems = []

      // Merge live-discovered models first, then static seed models so metadata stays rich
      if (Array.isArray(discoveredList) && discoveredList.length > 0) {
        rawItems.push(...discoveredList)
      }
      if (Array.isArray(provider.staticModels)) {
        rawItems.push(...provider.staticModels)
      }

      const staticById = new Map(
        (provider.staticModels ?? []).map((m) => {
          const obj = typeof m === 'string' ? { id: m } : m
          return [obj.id, obj]
        }),
      )

      for (const item of rawItems) {
        const id = typeof item === 'string' ? item : item?.id
        if (!id) continue
        const staticSeed = staticById.get(id)
        const mergedRaw =
          staticSeed && typeof item === 'object' ? { ...staticSeed, ...item } : item
        const normalized = normalizeModelEntry(provider, mergedRaw)
        if (!normalized) continue
        if (seen.has(normalized.compositeId)) continue
        seen.add(normalized.compositeId)

        if (!opts.includeHidden && hiddenSet.has(normalized.compositeId)) continue

        const health = this.getHealth(normalized.compositeId)
        out.push({
          ...normalized,
          providerEnabled: provider.enabled,
          health,
        })
      }
    }

    return out
  }

  /**
   * Return current health & cooldown snapshot for a `compositeId` (`provider/model`).
   *
   * @param {string} compositeId
   */
  getHealth(compositeId) {
    const raw = this.getRuntimeState().health?.[compositeId]
    const now = Date.now()
    if (!raw || typeof raw !== 'object') {
      return {
        status: 'untested',
        coolingDown: false,
        cooldownRemainingMs: 0,
        ttftMs: null,
        lastLatencyMs: null,
        successCount: 0,
        failureCount: 0,
        lastError: '',
        lastUsedAt: 0,
      }
    }
    const cooldownUntil = Number(raw.cooldownUntil || 0)
    const coolingDown = cooldownUntil > now
    return {
      status: coolingDown ? 'cooldown' : raw.status || 'healthy',
      coolingDown,
      cooldownUntil,
      cooldownRemainingMs: coolingDown ? cooldownUntil - now : 0,
      ttftMs: typeof raw.ttftMs === 'number' ? raw.ttftMs : null,
      lastLatencyMs: typeof raw.lastLatencyMs === 'number' ? raw.lastLatencyMs : null,
      successCount: Number(raw.successCount || 0),
      failureCount: Number(raw.failureCount || 0),
      lastError: String(raw.lastError || ''),
      lastErrorCode: String(raw.lastErrorCode || ''),
      lastUsedAt: Number(raw.lastUsedAt || 0),
    }
  }

  /**
   * Resolve a DSH `(route, model)` pair into either a virtual meta-model or a concrete target.
   *
   * @param {string} route
   * @param {string} requestedModel
   */
  resolveTarget(route, requestedModel) {
    const cleanModel = String(requestedModel ?? '').trim()

    if (route === UNIFIED_ROUTE) {
      const virtual = findVirtualModel(cleanModel)
      if (virtual) {
        return { kind: 'virtual', virtual }
      }
    }

    if (route.startsWith(PROVIDER_ROUTE_PREFIX) && route !== UNIFIED_ROUTE) {
      const pid = route.slice(PROVIDER_ROUTE_PREFIX.length)
      const provider = this.getProvider(pid)
      if (provider) {
        const subModel = cleanModel.startsWith(`${pid}/`)
          ? cleanModel.slice(pid.length + 1)
          : cleanModel
        const catalog = this.buildCatalog({ includeDisabledProviders: true, includeHidden: true })
        const existing = catalog.find((c) => c.compositeId === `${pid}/${subModel}`)
        const entry = existing ?? normalizeModelEntry(provider, { id: subModel })
        return { kind: 'concrete', provider, entry }
      }
    }

    // `provider/model` composite ID on `keyless-free`
    const slashIdx = cleanModel.indexOf('/')
    if (slashIdx > 0) {
      const pid = cleanModel.slice(0, slashIdx)
      const subModel = cleanModel.slice(slashIdx + 1)
      const provider = this.getProvider(pid)
      if (provider) {
        const catalog = this.buildCatalog({ includeDisabledProviders: true, includeHidden: true })
        const existing = catalog.find((c) => c.compositeId === cleanModel)
        const entry = existing ?? normalizeModelEntry(provider, { id: subModel })
        return { kind: 'concrete', provider, entry }
      }
    }

    // Fallback: match bare model ID across enabled catalog
    const catalog = this.buildCatalog({ includeHidden: true })
    const byModelId = catalog.find((c) => c.modelId === cleanModel)
    if (byModelId) {
      const provider = this.getProvider(byModelId.providerId)
      if (provider) return { kind: 'concrete', provider, entry: byModelId }
    }

    const virtualFallback = findVirtualModel(cleanModel)
    if (virtualFallback) return { kind: 'virtual', virtual: virtualFallback }

    return { kind: 'unknown', requestedModel: cleanModel }
  }

  /**
   * Build an ordered candidate chain for a virtual meta-model (`auto*`) or fallback turn.
   *
   * @param {{
   *   virtual?: Record<string, any> | null;
   *   needsTools?: boolean;
   *   needsVision?: boolean;
   *   sessionId?: string;
   *   primaryEntry?: Record<string, any> | null;
   * }} criteria
   */
  rankCandidates(criteria = {}) {
    const settings = this.getSettings()
    const maxAttempts = Math.max(1, Math.min(12, Number(settings.maxFailoverAttempts) || 5))
    const catalog = this.buildCatalog()
    const byComposite = new Map(catalog.map((c) => [c.compositeId, c]))
    const providersById = new Map(this.listProviders().map((p) => [p.id, p]))

    const eligiblePool = catalog.filter((entry) => {
      const p = providersById.get(entry.providerId)
      if (!p || !p.enabled) return false
      // Unless specifically in `auto-fast` (text-only), only pick autoEligible providers
      if (!p.autoEligible && !(criteria.virtual?.intent === 'fast' && !criteria.needsTools)) {
        return false
      }
      if (criteria.needsVision && !entry.vision) return false
      if (criteria.needsTools && !entry.tools) return false
      return true
    })

    // Fallback if strict capability filter matched nothing (e.g. only custom/local text models enabled)
    const basePool =
      eligiblePool.length > 0
        ? eligiblePool
        : catalog.filter((entry) => providersById.get(entry.providerId)?.enabled)

    const preferredOrder = new Map()
    const prefList = criteria.virtual?.preferred ?? VIRTUAL_MODELS[0].preferred
    prefList.forEach((cid, idx) => preferredOrder.set(cid, idx))

    const stickyKey = `${criteria.sessionId || 'global'}:${criteria.virtual?.id || 'auto'}`
    const stickyId = settings.stickyAutoRouting ? this.stickyChoices.get(stickyKey) : undefined
    const now = Date.now()

    const scoreCandidate = (entry) => {
      let score = entry.priority * 10
      if (preferredOrder.has(entry.compositeId)) {
        score += 1000 - preferredOrder.get(entry.compositeId) * 25
      }
      if (stickyId && entry.compositeId === stickyId && !entry.health.coolingDown) {
        score += 1200
      }
      if (criteria.virtual?.intent === 'reasoning' && entry.reasoning) score += 200
      if (criteria.virtual?.intent === 'vision' && entry.vision) score += 300
      if (entry.health.status === 'healthy') score += 120
      if (typeof entry.health.ttftMs === 'number' && entry.health.ttftMs > 0) {
        score += Math.max(0, 80 - Math.floor(entry.health.ttftMs / 100))
      }

      // Deprioritize providers currently throttled by a long minIntervalMs (e.g., Pollinations 15s)
      const gate = this.gates.get(entry.providerId)
      const provider = providersById.get(entry.providerId)
      if (gate && provider) {
        if (gate.active >= provider.concurrency) score -= 500
        const waitMs = gate.lastStartedAt + provider.minIntervalMs - now
        if (waitMs > 1500) score -= 350
      }

      if (entry.health.coolingDown) {
        score -= 10000 + Math.min(5000, Math.floor(entry.health.cooldownRemainingMs / 1000))
      }
      return score
    }

    const sorted = [...basePool].sort((a, b) => scoreCandidate(b) - scoreCandidate(a))

    // If a concrete primary model was requested with fallback enabled, put it first!
    if (criteria.primaryEntry) {
      const rest = sorted.filter((c) => c.compositeId !== criteria.primaryEntry.compositeId)
      return [criteria.primaryEntry, ...rest].slice(0, maxAttempts)
    }

    // Interleave slightly so we don't try 5 models on the exact same IP-throttled provider in a row
    const picked = []
    const providerCount = new Map()
    const deferred = []
    for (const item of sorted) {
      const count = providerCount.get(item.providerId) ?? 0
      if (count < 2) {
        picked.push(item)
        providerCount.set(item.providerId, count + 1)
      } else {
        deferred.push(item)
      }
    }

    return [...picked, ...deferred].slice(0, maxAttempts)
  }

  /**
   * Remember a successful candidate for session stickiness in `auto*` virtual models.
   *
   * @param {string | undefined} sessionId
   * @param {string} virtualId
   * @param {string} compositeId
   */
  rememberStickyChoice(sessionId, virtualId, compositeId) {
    const key = `${sessionId || 'global'}:${virtualId || 'auto'}`
    this.stickyChoices.set(key, compositeId)
    if (this.stickyChoices.size > 200) {
      const oldest = this.stickyChoices.keys().next().value
      if (oldest) this.stickyChoices.delete(oldest)
    }
  }

  /**
   * Acquire a concurrency & `minIntervalMs` burst slot for `provider`, honoring `signal`.
   *
   * @param {Record<string, any>} provider
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<() => void>} release callback
   */
  async acquireProviderSlot(provider, signal) {
    const pid = provider.id
    const maxConcurrency = Math.max(1, Number(provider.concurrency) || 2)
    const minIntervalMs = Math.max(0, Number(provider.minIntervalMs) || 0)

    let gate = this.gates.get(pid)
    if (!gate) {
      gate = { active: 0, lastStartedAt: 0, queue: [] }
      this.gates.set(pid, gate)
    }

    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    if (gate.active >= maxConcurrency) {
      await new Promise((resolve, reject) => {
        const onWake = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve(undefined)
        }
        const onAbort = () => {
          const idx = gate.queue.indexOf(onWake)
          if (idx >= 0) gate.queue.splice(idx, 1)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        gate.queue.push(onWake)
      })
    }

    gate.active += 1

    try {
      if (minIntervalMs > 0) {
        const now = Date.now()
        const waitMs = gate.lastStartedAt + minIntervalMs - now
        if (waitMs > 0) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              signal?.removeEventListener('abort', onAbort)
              resolve(undefined)
            }, waitMs)
            timer.unref?.()
            const onAbort = () => {
              clearTimeout(timer)
              reject(new DOMException('Aborted', 'AbortError'))
            }
            signal?.addEventListener('abort', onAbort, { once: true })
          })
        }
      }
      gate.lastStartedAt = Date.now()
    } catch (error) {
      gate.active = Math.max(0, gate.active - 1)
      const next = gate.queue.shift()
      next?.()
      throw error
    }

    let released = false
    return () => {
      if (released) return
      released = true
      gate.active = Math.max(0, gate.active - 1)
      const next = gate.queue.shift()
      next?.()
    }
  }

  /**
   * Record a successful turn on `compositeId`.
   *
   * @param {{
   *   compositeId: string;
   *   providerId: string;
   *   requestedModel: string;
   *   ttftMs?: number;
   *   latencyMs: number;
   *   usage?: { inputTokens?: number; outputTokens?: number } | null;
   *   failoverAttempts?: number;
   * }} info
   */
  recordSuccess(info) {
    const now = Date.now()
    this.stores.runtimeState.edit((draft) => {
      draft.health ??= {}
      const prev = draft.health[info.compositeId] ?? {}
      const smoothTtft =
        typeof info.ttftMs === 'number' && info.ttftMs > 0
          ? typeof prev.ttftMs === 'number'
            ? Math.round(prev.ttftMs * 0.6 + info.ttftMs * 0.4)
            : Math.round(info.ttftMs)
          : prev.ttftMs ?? null

      draft.health[info.compositeId] = {
        ...prev,
        status: 'healthy',
        cooldownUntil: 0,
        ttftMs: smoothTtft,
        lastLatencyMs: Math.round(info.latencyMs),
        successCount: Number(prev.successCount || 0) + 1,
        failureCount: Number(prev.failureCount || 0),
        lastError: '',
        lastErrorCode: '',
        lastUsedAt: now,
      }

      draft.stats ??= {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        failovers: 0,
        inputTokens: 0,
        outputTokens: 0,
        byProvider: {},
        recentTurns: [],
      }
      const inTok = Number(info.usage?.inputTokens || 0)
      const outTok = Number(info.usage?.outputTokens || 0)
      draft.stats.totalRequests += 1
      draft.stats.successfulRequests += 1
      draft.stats.failovers += Math.max(0, Number(info.failoverAttempts || 0))
      draft.stats.inputTokens += inTok
      draft.stats.outputTokens += outTok

      const pStat = (draft.stats.byProvider[info.providerId] ??= {
        requests: 0,
        successes: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
      })
      pStat.requests += 1
      pStat.successes += 1
      pStat.inputTokens += inTok
      pStat.outputTokens += outTok

      draft.stats.recentTurns = [
        {
          at: now,
          ok: true,
          requestedModel: info.requestedModel,
          resolvedModel: info.compositeId,
          providerId: info.providerId,
          ttftMs: info.ttftMs ?? null,
          latencyMs: Math.round(info.latencyMs),
          inputTokens: inTok,
          outputTokens: outTok,
          failovers: info.failoverAttempts || 0,
        },
        ...(draft.stats.recentTurns ?? []),
      ].slice(0, 40)
    })
  }

  /**
   * Record a provider/model failure and compute appropriate cooldown window.
   *
   * @param {{
   *   compositeId: string;
   *   providerId: string;
   *   requestedModel: string;
   *   error: any;
   *   latencyMs?: number;
   *   finalTurnFailure?: boolean;
   * }} info
   */
  recordFailure(info) {
    const settings = this.getSettings()
    const now = Date.now()
    const code = String(info.error?.code || ERROR_CODES.SERVER)
    const msg = String(info.error?.message || info.error || 'Upstream failure').slice(0, 260)

    let cooldownMs = 30_000
    if (code === ERROR_CODES.RATE_LIMIT) {
      const retryMs = info.error?.providerRetryAfterMs ?? info.error?.retryAfterMs
      cooldownMs =
        typeof retryMs === 'number' && retryMs > 0
          ? Math.min(3600_000, retryMs)
          : Math.max(5_000, Number(settings.cooldown429Seconds || 180) * 1000)
    } else if (code === ERROR_CODES.AUTH || code === ERROR_CODES.QUOTA) {
      cooldownMs = Math.max(30_000, Number(settings.cooldownAuthSeconds || 1800) * 1000)
    } else if (code === ERROR_CODES.CONTEXT_OVERFLOW || code === ERROR_CODES.INVALID_ARGS || code === ERROR_CODES.ABORTED) {
      cooldownMs = 0
    }

    this.stores.runtimeState.edit((draft) => {
      draft.health ??= {}
      const prev = draft.health[info.compositeId] ?? {}
      draft.health[info.compositeId] = {
        ...prev,
        status: cooldownMs > 0 ? 'cooldown' : 'degraded',
        cooldownUntil: cooldownMs > 0 ? now + cooldownMs : 0,
        failureCount: Number(prev.failureCount || 0) + 1,
        lastError: msg,
        lastErrorCode: code,
        lastUsedAt: now,
      }

      draft.stats ??= {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        failovers: 0,
        inputTokens: 0,
        outputTokens: 0,
        byProvider: {},
        recentTurns: [],
      }
      const pStat = (draft.stats.byProvider[info.providerId] ??= {
        requests: 0,
        successes: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
      })
      pStat.requests += 1
      pStat.failures += 1

      if (info.finalTurnFailure) {
        draft.stats.totalRequests += 1
        draft.stats.failedRequests += 1
        draft.stats.recentTurns = [
          {
            at: now,
            ok: false,
            requestedModel: info.requestedModel,
            resolvedModel: info.compositeId,
            providerId: info.providerId,
            latencyMs: Math.round(info.latencyMs || 0),
            errorCode: code,
            error: msg,
          },
          ...(draft.stats.recentTurns ?? []),
        ].slice(0, 40)
      }
    })
  }

  /**
   * Clear active cooldowns across all models or one specific provider.
   *
   * @param {string} [providerId]
   */
  resetCooldowns(providerId) {
    this.stores.runtimeState.edit((draft) => {
      if (!draft.health) return
      for (const [cid, h] of Object.entries(draft.health)) {
        if (providerId && !cid.startsWith(`${providerId}/`)) continue
        if (h && typeof h === 'object') {
          h.cooldownUntil = 0
          if (h.status === 'cooldown') h.status = 'untested'
          h.lastError = ''
          h.lastErrorCode = ''
        }
      }
    })
  }
}
