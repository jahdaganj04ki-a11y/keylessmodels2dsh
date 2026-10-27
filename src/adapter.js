/**
 * Core `@deepseek-ai/dsh-llm@0.2.1-rc.2` `LlmAdapter` implementation for `keylessmodels2dsh`.
 *
 * Implements the complete structural `LlmAdapter` contract without importing runtime
 * classes from `@deepseek-ai/dsh-llm` (avoiding duplicate singleton identity and
 * `autoInstallPeers: false` resolution errors in DSH Desktop `v0.12.1`).
 *
 * @module src/adapter.js
 */

import { UNIFIED_ROUTE, VIRTUAL_MODELS } from './providers.js'
import {
  buildOpenAiTools,
  buildReasoningMetadata,
  buildReasoningWirePatch,
  normalizeContentBlocks,
  toOpenAiChatMessages,
  toPlainTextMessages,
} from './messages.js'
import {
  ERROR_CODES,
  KeylessUpstreamError,
  classifyHttpError,
  parseRetryAfterMs,
  readChatJimmyResponseChunks,
  readOllamaResponseChunks,
  readOpenAiResponseChunks,
} from './stream.js'

const DEFAULT_IDLE_TIMEOUT_MS = 90_000

const FALLBACK_IMAGE_PRICING = Object.freeze({
  priceImages(images) {
    return (images ?? []).map((img) =>
      img?.offloaded === true
        ? { visualTokens: 0, text: `[offloaded image: ${img?.attachment?.name ?? 'image'}]` }
        : { visualTokens: 768, text: '' },
    )
  },
})

const FLAT_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 600,
  maxDelayMs: 8_000,
  jitterRatio: 0.15,
})

/**
 * Does a chunk commit the turn to this candidate (visible answer text or named tool call)?
 *
 * @param {Record<string, any>} chunk
 * @returns {boolean}
 */
function chunkCommitsTurn(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim().length > 0) {
    return true
  }
  if (chunk.type === 'tool-call-delta') {
    return true
  }
  return false
}

/**
 * Check if any message in the request carries an un-offloaded `image` block.
 *
 * @param {readonly any[] | undefined} messages
 * @returns {boolean}
 */
function requestHasImages(messages) {
  if (!Array.isArray(messages)) return false
  for (const msg of messages) {
    for (const block of normalizeContentBlocks(msg?.content)) {
      if (block.type === 'image' && block.offloaded !== true) return true
    }
  }
  return false
}

/**
 * Check if the request declares any tools (`tools` or `toolHistory`).
 *
 * @param {Record<string, any>} options
 * @returns {boolean}
 */
function requestHasTools(options) {
  if (Array.isArray(options?.tools) && options.tools.length > 0) return true
  const th = options?.toolHistory
  if (th && typeof th === 'object' && !Array.isArray(th)) {
    if (Array.isArray(th.tools) && th.tools.length > 0) return true
    if (Array.isArray(th.updates) && th.updates.some((u) => Array.isArray(u?.additions) && u.additions.length > 0)) {
      return true
    }
  }
  return false
}

export class KeylessModelsAdapter {
  /**
   * @param {{
   *   pool: import('./router.js').KeylessRouterPool;
   *   getUserAgent: () => string;
   *   fetchImpl?: typeof fetch;
   *   resolveImage?: (attachment: any) => string | undefined;
   *   idleTimeoutMs?: number;
   *   logger?: any;
   * }} deps
   */
  constructor(deps) {
    this.pool = deps.pool
    this.getUserAgent = deps.getUserAgent
    this.fetchImpl = deps.fetchImpl
    this.resolveImage = deps.resolveImage
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.logger = deps.logger
  }

  /**
   * @param {string} provider
   */
  providerInfo(provider) {
    return {
      id: provider,
      name: this.pool.routeDisplayName(provider),
    }
  }

  /**
   * @param {string} _provider
   */
  providerRetryPolicy(_provider) {
    return FLAT_RETRY_POLICY
  }

  /**
   * Synchronous visual token estimator required for smooth attachment spill accounting.
   */
  imageRequestPricing(_provider, _model) {
    return FALLBACK_IMAGE_PRICING
  }

  /**
   * List models advertised for `provider` in DSH Desktop's Model Picker.
   *
   * @param {string} provider
   */
  async listModels(provider) {
    const settings = this.pool.getSettings()
    if (settings.enabled === false) return []

    if (provider === UNIFIED_ROUTE) {
      const virtualItems = VIRTUAL_MODELS.map((vm) => ({
        provider,
        id: vm.id,
        name: vm.name,
        description: vm.description,
        inputModalities: vm.vision ? ['text', 'image'] : ['text'],
      }))

      const concreteItems = this.pool.buildCatalog().map((entry) => {
        const statusBadge = entry.health.coolingDown
          ? ` ⏳ Cooldown (${Math.ceil(entry.health.cooldownRemainingMs / 1000)}s)`
          : typeof entry.health.ttftMs === 'number'
            ? ` · ⚡ ${entry.health.ttftMs}ms`
            : ''
        return {
          provider,
          id: entry.compositeId,
          name: entry.name,
          description: `${entry.description}${statusBadge}`,
          inputModalities: entry.vision ? ['text', 'image'] : ['text'],
        }
      })

      return [...virtualItems, ...concreteItems]
    }

    // Per-provider route `keyless-<providerId>`
    const pid = provider.replace(/^keyless-/, '')
    const entries = this.pool.buildCatalog().filter((e) => e.providerId === pid)
    return entries.map((entry) => ({
      provider,
      id: entry.modelId,
      name: entry.shortLabel,
      description: entry.description,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
    }))
  }

  /**
   * Resolve exact metadata for `(provider, model)` per `LlmRuntime.normalizeModelInfo`.
   *
   * @param {string} provider
   * @param {string} model
   */
  async resolveModel(provider, model) {
    const settings = this.pool.getSettings()
    const ceilingCap = Math.max(512, Math.floor(Number(settings.defaultMaxTokens) || 8192))
    const target = this.pool.resolveTarget(provider, model)

    if (target.kind === 'virtual') {
      const vm = target.virtual
      const reasoning = buildReasoningMetadata(vm)
      return {
        provider,
        id: model,
        name: vm.name,
        description: vm.description,
        inputModalities: vm.vision ? ['text', 'image'] : ['text'],
        context: { contextWindow: Math.max(4096, Math.floor(vm.contextWindow)) },
        defaultMaxTokens: Math.max(512, Math.min(Math.floor(vm.maxTokens), ceilingCap)),
        ...(reasoning ? { reasoning } : {}),
      }
    }

    if (target.kind === 'concrete' && target.entry) {
      const entry = target.entry
      const reasoning = buildReasoningMetadata(entry)
      return {
        provider,
        id: model,
        name: provider === UNIFIED_ROUTE ? entry.name : entry.shortLabel,
        description: entry.description,
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
        context: { contextWindow: Math.max(2048, Math.floor(entry.contextWindow)) },
        defaultMaxTokens: Math.max(512, Math.min(Math.floor(entry.maxTokens), ceilingCap)),
        ...(reasoning ? { reasoning } : {}),
      }
    }

    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 131072 },
      defaultMaxTokens: ceilingCap,
    }
  }

  /**
   * Bind model resolution and stream dispatch for one turn.
   *
   * @param {string} provider
   * @param {string} model
   */
  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Stream a model turn with immediate cancellation when the consumer closes the iterator.
   *
   * @param {Record<string, any>} options
   * @returns {AsyncIterable<any>}
   */
  stream(options) {
    const controller = new AbortController()
    const callerSignal = options?.signal
    const onCallerAbort = () => controller.abort(callerSignal?.reason)
    if (callerSignal?.aborted) {
      controller.abort(callerSignal.reason)
    } else {
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    }

    const gen = this.runTurn({ ...options, signal: controller.signal }, callerSignal)
    const cleanup = () => callerSignal?.removeEventListener('abort', onCallerAbort)

    return {
      [Symbol.asyncIterator]() {
        return this
      },
      async next(val) {
        try {
          const step = await gen.next(val)
          if (step.done) cleanup()
          return step
        } catch (err) {
          cleanup()
          throw err
        }
      },
      async return(val) {
        controller.abort()
        cleanup()
        return gen.return(val)
      },
      async throw(err) {
        controller.abort(err)
        cleanup()
        return gen.throw(err)
      },
    }
  }

  /**
   * @param {Record<string, any>} options
   * @param {AbortSignal | undefined} callerSignal
   */
  async *runTurn(options, callerSignal) {
    const settings = this.pool.getSettings()
    if (settings.enabled === false) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'Keyless Free Models ist in den Plugin-Einstellungen deaktiviert.',
            code: ERROR_CODES.AUTH,
          },
        },
      }
      return
    }

    const target = this.pool.resolveTarget(options.provider, options.model)
    const needsVision = requestHasImages(options.messages)
    const needsTools = requestHasTools(options)
    const sessionId = options.sessionId ? String(options.sessionId) : undefined

    if (target.kind === 'virtual') {
      const effectiveVirtual =
        needsVision && !target.virtual.vision
          ? VIRTUAL_MODELS.find((v) => v.id === 'auto-vision') ?? target.virtual
          : target.virtual

      const candidates = this.pool.rankCandidates({
        virtual: effectiveVirtual,
        needsTools,
        needsVision,
        sessionId,
      })

      if (candidates.length === 0) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: 'Kein aktivierter Keyless-Provider verfügbar. Bitte aktivieren Sie mindestens einen Provider in Einstellungen → Keyless Free Models.',
              code: ERROR_CODES.SERVER,
            },
          },
        }
        return
      }

      yield* this.executeCandidateChain(options, candidates, {
        requestedModel: options.model,
        virtualId: effectiveVirtual.id,
        sessionId,
        callerSignal,
      })
      return
    }

    if (target.kind === 'concrete' && target.provider && target.entry) {
      if (settings.fallbackOnConcreteModel429 === true) {
        const candidates = this.pool.rankCandidates({
          needsTools,
          needsVision,
          sessionId,
          primaryEntry: target.entry,
        })
        yield* this.executeCandidateChain(options, candidates, {
          requestedModel: options.model,
          sessionId,
          callerSignal,
        })
        return
      }

      yield* this.executeCandidateChain(options, [target.entry], {
        requestedModel: options.model,
        sessionId,
        callerSignal,
      })
      return
    }

    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `Unbekanntes Keyless-Modell "${options.model}". Bitte wählen Sie ein Modell aus der Liste oder "auto".`,
          code: ERROR_CODES.INVALID_ARGS,
        },
      },
    }
  }

  /**
   * Execute an ordered candidate chain with buffered pre-commit failover.
   *
   * Chunks before the first visible text token or tool-call delta (such as
   * `block-start` for reasoning and `reasoning-delta`s) stay buffered until
   * commitment or clean completion. If an upstream fails mid-thinking (e.g. 429/503),
   * the buffered partial attempt is discarded cleanly and the next provider takes over!
   *
   * @param {Record<string, any>} options
   * @param {Record<string, any>[]} candidates
   * @param {{ requestedModel: string; virtualId?: string; sessionId?: string; callerSignal?: AbortSignal }} ctxInfo
   */
  async *executeCandidateChain(options, candidates, ctxInfo) {
    /** @type {string[]} */
    const failureSummaries = []
    let lastError = null

    for (let attemptIdx = 0; attemptIdx < candidates.length; attemptIdx += 1) {
      if (ctxInfo.callerSignal?.aborted || options.signal?.aborted) {
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: { message: 'Anfrage vom Benutzer abgebrochen.', code: ERROR_CODES.ABORTED },
          },
        }
        return
      }

      const candidate = candidates[attemptIdx]
      const provider = this.pool.getProvider(candidate.providerId)
      if (!provider) continue

      const turnStartedAt = Date.now()
      /** @type {any[]} */
      const heldChunks = []
      let committed = false
      /** @type {number | undefined} */
      let ttftMs
      /** @type {any} */
      let observedUsage = null

      try {
        for await (const chunk of this.dispatchSingleUpstream(options, provider, candidate)) {
          if (
            ttftMs === undefined &&
            (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')
          ) {
            ttftMs = Date.now() - turnStartedAt
          }
          if (chunk.type === 'usage') {
            observedUsage = chunk.usage
          }

          if (committed) {
            yield chunk
            continue
          }

          heldChunks.push(chunk)
          if (chunkCommitsTurn(chunk) || chunk.type === 'finish') {
            committed = true
            for (const buffered of heldChunks) yield buffered
            heldChunks.length = 0
          }
        }

        // Clean completion!
        if (!committed && heldChunks.length > 0) {
          for (const buffered of heldChunks) yield buffered
          heldChunks.length = 0
        }

        const latencyMs = Date.now() - turnStartedAt
        this.pool.recordSuccess({
          compositeId: candidate.compositeId,
          providerId: provider.id,
          requestedModel: ctxInfo.requestedModel,
          ttftMs,
          latencyMs,
          usage: observedUsage,
          failoverAttempts: attemptIdx,
        })
        if (ctxInfo.virtualId) {
          this.pool.rememberStickyChoice(ctxInfo.sessionId, ctxInfo.virtualId, candidate.compositeId)
        }
        return
      } catch (error) {
        const latencyMs = Date.now() - turnStartedAt
        if (ctxInfo.callerSignal?.aborted || error?.name === 'AbortError') {
          yield {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: { message: 'Anfrage abgebrochen.', code: ERROR_CODES.ABORTED },
            },
          }
          return
        }

        const upstreamErr =
          error instanceof KeylessUpstreamError
            ? error
            : new KeylessUpstreamError(
                `[${provider.id}] ${error instanceof Error ? error.message : String(error)}`,
                ERROR_CODES.TRANSPORT,
                { providerId: provider.id, modelId: candidate.modelId, cause: error },
              )

        lastError = upstreamErr
        const isLastCandidate = attemptIdx === candidates.length - 1 || committed
        this.pool.recordFailure({
          compositeId: candidate.compositeId,
          providerId: provider.id,
          requestedModel: ctxInfo.requestedModel,
          error: upstreamErr,
          latencyMs,
          finalTurnFailure: isLastCandidate,
        })

        // Do not fail over if chunks were already committed to the user stream or on context overflow
        if (committed || upstreamErr.code === ERROR_CODES.CONTEXT_OVERFLOW) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: upstreamErr.toFailure(),
            },
          }
          return
        }

        failureSummaries.push(`${candidate.compositeId} (${upstreamErr.code}: ${upstreamErr.message})`)
        this.logger?.warn?.(
          `keylessmodels2dsh: failover (${attemptIdx + 1}/${candidates.length}) past ${candidate.compositeId} -> ${upstreamErr.code}`,
        )
      }
    }

    const finalFailure = lastError
      ? {
          ...lastError.toFailure(),
          message:
            candidates.length > 1
              ? `Alle ${candidates.length} geprüften Keyless-Kandidaten fehlgeschlagen: ${failureSummaries.join(' | ')}`
              : lastError.message,
        }
      : {
          message: 'Kein Keyless-Kandidat konnte die Anfrage beantworten.',
          code: ERROR_CODES.SERVER,
        }

    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: finalFailure,
      },
    }
  }

  /**
   * Perform one HTTP request against a single concrete `(provider, entry)` and stream chunks.
   *
   * @param {Record<string, any>} options
   * @param {Record<string, any>} provider
   * @param {Record<string, any>} entry
   */
  async *dispatchSingleUpstream(options, provider, entry) {
    const fetchFn = this.fetchImpl ?? globalThis.fetch
    const releaseSlot = await this.pool.acquireProviderSlot(provider, options.signal)

    const idleController = new AbortController()
    let idleTimedOut = false
    let idleTimer = setTimeout(() => {
      idleTimedOut = true
      idleController.abort(new Error('stream idle timeout'))
    }, this.idleTimeoutMs)
    idleTimer.unref?.()

    const touchIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        idleController.abort(new Error('stream idle timeout'))
      }, this.idleTimeoutMs)
      idleTimer.unref?.()
    }

    const mergedController = new AbortController()
    const onEitherAbort = () => mergedController.abort()
    if (options.signal?.aborted || idleController.signal.aborted) {
      mergedController.abort()
    } else {
      options.signal?.addEventListener('abort', onEitherAbort, { once: true })
      idleController.signal.addEventListener('abort', onEitherAbort, { once: true })
    }

    try {
      const chatUrl = `${provider.baseUrl.replace(/\/+$/, '')}${provider.chatPath}`
      const wantStream = provider.noStream !== true
      const headers = {
        'Content-Type': 'application/json',
        Accept: provider.wire === 'openai' && wantStream ? 'text/event-stream' : 'application/json',
        'User-Agent': this.getUserAgent(),
        ...(provider.headers ?? {}),
      }

      const maxTokens =
        typeof options.maxTokens === 'number' && options.maxTokens > 0
          ? Math.min(Math.floor(options.maxTokens), entry.maxTokens || 16384)
          : undefined

      let body
      if (provider.wire === 'chatjimmy') {
        const plainMessages = toPlainTextMessages(options.messages, options.system)
        body = {
          chatOptions: {
            selectedModel: entry.modelId,
            ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          },
          messages: plainMessages,
          stream: true,
        }
      } else if (provider.wire === 'ollama') {
        const plainMessages = toPlainTextMessages(options.messages, options.system)
        if (provider.chatPath.includes('/api/chat')) {
          body = {
            model: entry.modelId,
            messages: plainMessages,
            stream: wantStream,
            options: {
              ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
              ...(maxTokens !== undefined ? { num_predict: maxTokens } : {}),
            },
          }
        } else {
          const prompt = plainMessages
            .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
            .concat(['ASSISTANT:'])
            .join('\n\n')
          body = {
            model: entry.modelId,
            prompt,
            stream: wantStream,
            options: {
              ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
              ...(maxTokens !== undefined ? { num_predict: maxTokens } : {}),
            },
          }
        }
      } else {
        const wireMessages = toOpenAiChatMessages(options.messages, options.system, {
          supportsVision: entry.vision === true,
          supportsTools: entry.tools !== false,
          resolveImage: this.resolveImage,
        })
        const wireTools =
          entry.tools !== false ? buildOpenAiTools(options.tools, options.toolHistory) : undefined
        const reasoningPatch = buildReasoningWirePatch(provider, entry, options.reasoningEffort)

        body = {
          model: entry.modelId,
          messages: wireMessages,
          stream: wantStream,
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
          ...(Array.isArray(options.stop) && options.stop.length > 0 ? { stop: options.stop } : {}),
          ...(wireTools !== undefined ? { tools: wireTools } : {}),
          ...reasoningPatch,
        }
      }

      let response
      try {
        response = await fetchFn(chatUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: mergedController.signal,
        })
      } catch (err) {
        if (idleTimedOut) {
          throw new KeylessUpstreamError(
            `[${provider.id}] Zeitüberschreitung beim Verbindungsaufbau (${Math.round(this.idleTimeoutMs / 1000)}s)`,
            ERROR_CODES.TIMEOUT,
            { providerId: provider.id, modelId: entry.modelId, cause: err },
          )
        }
        if (options.signal?.aborted) throw err
        throw new KeylessUpstreamError(
          `[${provider.id}] Netzwerkfehler: ${err instanceof Error ? err.message : String(err)}`,
          ERROR_CODES.TRANSPORT,
          { providerId: provider.id, modelId: entry.modelId, cause: err },
        )
      }

      touchIdle()

      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
        const errText = await response.text().catch(() => '')
        throw classifyHttpError(response.status, errText, {
          retryAfterMs,
          providerId: provider.id,
          modelId: entry.modelId,
        })
      }

      const meta = {
        providerId: provider.id,
        modelId: entry.modelId,
        onActivity: touchIdle,
      }

      try {
        if (provider.wire === 'chatjimmy') {
          yield* readChatJimmyResponseChunks(response, meta)
        } else if (provider.wire === 'ollama') {
          yield* readOllamaResponseChunks(response, meta)
        } else {
          yield* readOpenAiResponseChunks(response, meta)
        }
      } catch (streamErr) {
        if (idleTimedOut) {
          throw new KeylessUpstreamError(
            `[${provider.id}] Stream hing länger als ${Math.round(this.idleTimeoutMs / 1000)}s ohne Daten`,
            ERROR_CODES.TIMEOUT,
            { providerId: provider.id, modelId: entry.modelId, cause: streamErr },
          )
        }
        throw streamErr
      }
    } finally {
      clearTimeout(idleTimer)
      options.signal?.removeEventListener('abort', onEitherAbort)
      idleController.signal.removeEventListener('abort', onEitherAbort)
      releaseSlot()
    }
  }
}
