/**
 * Multi-protocol streaming & error classifier for `@deepseek-ai/dsh-llm@0.2.1-rc.2`.
 *
 * Translates:
 *   - OpenAI Chat Completions SSE (`data: {...}`, `: KILO PROCESSING`, CRLF/LF/CR)
 *   - OpenAI single-JSON responses (when an upstream ignores `stream: true` or sends SSE under `application/json`)
 *   - Inline `<think>...</think>` blocks inside `content` -> native DSH `reasoning-delta` + `reasoning` blocks
 *   - ChatJimmy raw text + `<|stats|>{...}<|/stats|>` trailer
 *   - Ollama `/api/generate` & `/api/chat` NDJSON streams
 *
 * Enforces DSH `0.2.1-rc.2` `StreamChunk` invariants:
 *   - Distinct block indices (`REASONING_INDEX = 0`, `TEXT_INDEX = 1000`, `TOOL_BASE_INDEX = 100000 + i`)
 *   - Non-empty string `id` (`ToolCallId`) on EVERY `tool-call-delta` chunk
 *   - Deterministic `block-start` -> `*-delta` -> `block-end` lifecycle before `usage` / `finish`
 *
 * @module src/stream.js
 */

export const REASONING_INDEX = 0
export const TEXT_INDEX = 1000
export const TOOL_BASE_INDEX = 100000

export const ERROR_CODES = Object.freeze({
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA',
  AUTH: 'AUTH',
  CONTEXT_OVERFLOW: 'CONTEXT_WINDOW_EXCEEDED',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  TIMEOUT: 'TIMEOUT',
  SERVER: 'SERVER',
  TRANSPORT: 'TRANSPORT',
  INVALID_ARGS: 'INVALID_ARGS',
  ABORTED: 'ABORTED',
})

/**
 * Structured upstream error carrying DSH-compatible `code`, `status`, and `providerRetryAfterMs`.
 */
export class KeylessUpstreamError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ status?: number; providerRetryAfterMs?: number; providerId?: string; modelId?: string; cause?: unknown }} [opts]
   */
  constructor(message, code, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'KeylessUpstreamError'
    this.code = code
    if (opts.status !== undefined) this.status = opts.status
    const retryMs = opts.providerRetryAfterMs ?? opts.retryAfterMs
    if (retryMs !== undefined) {
      this.providerRetryAfterMs = retryMs
      this.retryAfterMs = retryMs
    }
    if (opts.providerId !== undefined) this.providerId = opts.providerId
    if (opts.modelId !== undefined) this.modelId = opts.modelId
  }

  toFailure() {
    return {
      message: this.message,
      code: this.code,
      ...(typeof this.status === 'number' ? { status: this.status } : {}),
      ...(typeof this.providerRetryAfterMs === 'number' && this.providerRetryAfterMs > 0
        ? { providerRetryAfterMs: this.providerRetryAfterMs }
        : {}),
    }
  }
}

/**
 * Parse `Retry-After` HTTP header (delta-seconds or HTTP-date) into milliseconds.
 *
 * @param {string | null | undefined} raw
 * @returns {number | undefined}
 */
export function parseRetryAfterMs(raw) {
  if (!raw || typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const ms = Math.ceil(Number(trimmed) * 1000)
    return ms > 0 && Number.isFinite(ms) ? ms : undefined
  }
  const dateMs = Date.parse(trimmed) - Date.now()
  return Number.isFinite(dateMs) && dateMs > 0 ? Math.ceil(dateMs) : undefined
}

/**
 * Extract structured `(code, message)` from diverse upstream JSON/text error bodies.
 *
 * @param {string} bodyText
 * @param {number} [status]
 * @returns {{ errorCode: string | null; message: string }}
 */
export function extractErrorDetail(bodyText, status) {
  const raw = String(bodyText ?? '').trim()
  if (!raw) return { errorCode: null, message: status ? `HTTP ${status}` : 'Empty error response' }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const errObj = parsed.error
      let code = parsed.error_type ?? parsed.code ?? null
      let msg = parsed.message ?? parsed.detail ?? null
      if (errObj && typeof errObj === 'object') {
        code = errObj.code ?? errObj.type ?? code
        const inner = errObj.error
        msg = errObj.message ?? (typeof inner === 'string' ? inner : null) ?? msg
      } else if (typeof errObj === 'string') {
        msg = errObj
      }
      const cleanMsg = String(msg || raw).slice(0, 400)
      return { errorCode: code ? String(code) : null, message: cleanMsg }
    }
  } catch {
    // Plain text or HTML error page
  }
  const strippedHtml = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return { errorCode: null, message: (strippedHtml || raw).slice(0, 300) }
}

/**
 * Classify an HTTP status + body into a `KeylessUpstreamError`.
 *
 * @param {number} status
 * @param {string} bodyText
 * @param {{ retryAfterMs?: number; providerId?: string; modelId?: string }} [meta]
 * @returns {KeylessUpstreamError}
 */
export function classifyHttpError(status, bodyText, meta = {}) {
  const { errorCode, message } = extractErrorDetail(bodyText, status)
  const combined = `${errorCode ?? ''} ${message}`
  const prefix = meta.providerId ? `[${meta.providerId}] ` : ''

  if (
    /\bcontext[\s_-]*(?:length|window)|maximum\s+context|too\s+(?:long|large)\s+for.*(?:context|model)/i.test(
      combined,
    ) ||
    status === 413
  ) {
    return new KeylessUpstreamError(`${prefix}${message}`, ERROR_CODES.CONTEXT_OVERFLOW, {
      status,
      providerId: meta.providerId,
      modelId: meta.modelId,
    })
  }

  if (/PAID_MODEL_AUTH_REQUIRED/i.test(combined)) {
    return new KeylessUpstreamError(
      `${prefix}Modell ist nicht im kostenlosen Pool enthalten (${message})`,
      ERROR_CODES.AUTH,
      { status, providerId: meta.providerId, modelId: meta.modelId },
    )
  }

  if (status === 429 || /rate[\s_-]*limit|too\s+many\s+requests|daily[\s_-]*limit/i.test(combined)) {
    let retryMs = meta.retryAfterMs
    if (!retryMs) {
      const m = /retry\s+after\s+(\d+(?:\.\d+)?)\s*s/i.exec(message)
      if (m) retryMs = Math.ceil(Number(m[1]) * 1000)
    }
    return new KeylessUpstreamError(`${prefix}${message}`, ERROR_CODES.RATE_LIMIT, {
      status: status || 429,
      providerRetryAfterMs: retryMs,
      providerId: meta.providerId,
      modelId: meta.modelId,
    })
  }

  if (status === 402 || /\binsufficient[\s_-]*(?:quota|credits?|balance)|cake\s+credits/i.test(combined)) {
    // Note: Pollinations returns 402 when anonymous rate limit (1 req / 15s) is exceeded!
    const isPollinationsRate = meta.providerId === 'pollinations' && status === 402
    return new KeylessUpstreamError(
      `${prefix}${message}`,
      isPollinationsRate ? ERROR_CODES.RATE_LIMIT : ERROR_CODES.QUOTA,
      {
        status,
        providerRetryAfterMs: isPollinationsRate ? 15000 : meta.retryAfterMs,
        providerId: meta.providerId,
        modelId: meta.modelId,
      },
    )
  }

  if (status === 401 || status === 403) {
    return new KeylessUpstreamError(`${prefix}${message}`, ERROR_CODES.AUTH, {
      status,
      providerId: meta.providerId,
      modelId: meta.modelId,
    })
  }

  if (status === 408 || status === 504) {
    return new KeylessUpstreamError(`${prefix}${message}`, ERROR_CODES.TIMEOUT, {
      status,
      providerId: meta.providerId,
      modelId: meta.modelId,
    })
  }

  if (status >= 500 || status === 404) {
    return new KeylessUpstreamError(`${prefix}${message}`, ERROR_CODES.SERVER, {
      status,
      providerId: meta.providerId,
      modelId: meta.modelId,
    })
  }

  return new KeylessUpstreamError(`${prefix}${message}`, ERROR_CODES.INVALID_ARGS, {
    status,
    providerId: meta.providerId,
    modelId: meta.modelId,
  })
}

/**
 * Streaming `<think>...</think>` splitter that safely handles tags split across chunk boundaries.
 */
export class ThinkTagSplitter {
  constructor() {
    this.mode = 'initial' // 'initial' | 'thinking' | 'text'
    this.buffer = ''
  }

  /**
   * @param {string} piece
   * @returns {{ reasoning: string; text: string }}
   */
  push(piece) {
    if (!piece) return { reasoning: '', text: '' }
    this.buffer += piece
    let reasoning = ''
    let text = ''

    if (this.mode === 'initial') {
      const trimmedStart = this.buffer.trimStart()
      if (trimmedStart.length === 0) {
        return { reasoning: '', text: '' }
      }
      if ('<think>'.startsWith(trimmedStart) && trimmedStart.length < 7) {
        return { reasoning: '', text: '' }
      }
      if (trimmedStart.startsWith('<think>')) {
        this.mode = 'thinking'
        this.buffer = trimmedStart.slice(7).replace(/^\r?\n/, '')
      } else {
        this.mode = 'text'
      }
    }

    if (this.mode === 'thinking') {
      const closeIdx = this.buffer.indexOf('</think>')
      if (closeIdx !== -1) {
        reasoning += this.buffer.slice(0, closeIdx)
        this.buffer = this.buffer.slice(closeIdx + 8).replace(/^\r?\n/, '')
        this.mode = 'text'
      } else {
        // Hold up to 7 trailing chars in case `</think>` is split across chunks
        const safeCut = Math.max(0, this.buffer.length - 7)
        if (safeCut > 0) {
          reasoning += this.buffer.slice(0, safeCut)
          this.buffer = this.buffer.slice(safeCut)
        }
        return { reasoning, text: '' }
      }
    }

    if (this.mode === 'text' && this.buffer.length > 0) {
      text += this.buffer
      this.buffer = ''
    }

    return { reasoning, text }
  }

  /**
   * Flush any remaining buffered characters at end-of-stream.
   *
   * @returns {{ reasoning: string; text: string }}
   */
  flush() {
    if (!this.buffer) return { reasoning: '', text: '' }
    const rem = this.buffer
    this.buffer = ''
    if (this.mode === 'thinking') return { reasoning: rem, text: '' }
    return { reasoning: '', text: rem }
  }
}

/**
 * Tracks opened content blocks (`reasoning`, `text`, `tool-call`) and guarantees:
 *   1. `block-start` before the first delta of each block,
 *   2. a valid non-empty string `id` on EVERY `tool-call-delta`,
 *   3. `block-end` for all opened blocks in deterministic order.
 */
export class DshChunkBuilder {
  constructor() {
    /** @type {Map<number, { type: 'reasoning' | 'text' | 'tool-call'; text: string; id?: string; name?: string }>} */
    this.blocks = new Map()
    /** @type {number[]} */
    this.order = []
  }

  /**
   * @param {string} text
   * @returns {any[]}
   */
  emitReasoning(text) {
    if (!text) return []
    const out = []
    if (!this.blocks.has(REASONING_INDEX)) {
      this.blocks.set(REASONING_INDEX, { type: 'reasoning', text: '' })
      this.order.push(REASONING_INDEX)
      out.push({ type: 'block-start', index: REASONING_INDEX, blockType: 'reasoning' })
    }
    this.blocks.get(REASONING_INDEX).text += text
    out.push({ type: 'reasoning-delta', index: REASONING_INDEX, text })
    return out
  }

  /**
   * @param {string} text
   * @returns {any[]}
   */
  emitText(text) {
    if (!text) return []
    const out = []
    if (!this.blocks.has(TEXT_INDEX)) {
      this.blocks.set(TEXT_INDEX, { type: 'text', text: '' })
      this.order.push(TEXT_INDEX)
      out.push({ type: 'block-start', index: TEXT_INDEX, blockType: 'text' })
    }
    this.blocks.get(TEXT_INDEX).text += text
    out.push({ type: 'text-delta', index: TEXT_INDEX, text })
    return out
  }

  /**
   * @param {number} callSlot
   * @param {{ id?: string; name?: string; argumentsDelta?: string }} delta
   * @returns {any[]}
   */
  emitToolCallDelta(callSlot, delta) {
    const index = TOOL_BASE_INDEX + Math.max(0, Math.floor(callSlot || 0))
    const out = []
    let entry = this.blocks.get(index)
    const isNew = entry === undefined
    if (isNew) {
      entry = {
        type: 'tool-call',
        text: '',
        id: typeof delta.id === 'string' && delta.id.length > 0 ? delta.id : `keyless-call-${callSlot || 0}`,
        name: typeof delta.name === 'string' && delta.name.length > 0 ? delta.name : undefined,
      }
      this.blocks.set(index, entry)
      this.order.push(index)
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
    } else {
      if (typeof delta.id === 'string' && delta.id.length > 0) entry.id = delta.id
      if (typeof delta.name === 'string' && delta.name.length > 0) entry.name = delta.name
    }

    const argsDelta = typeof delta.argumentsDelta === 'string' ? delta.argumentsDelta : ''
    entry.text += argsDelta

    // DSH 0.2.1-rc.2 strictly requires `id` to be a string on EVERY `tool-call-delta`!
    const guaranteedId = entry.id || `keyless-call-${callSlot || 0}`
    entry.id = guaranteedId

    out.push({
      type: 'tool-call-delta',
      index,
      id: guaranteedId,
      ...(typeof delta.name === 'string' && delta.name.length > 0 ? { name: delta.name } : {}),
      argumentsDelta: argsDelta,
    })
    return out
  }

  hasAnswerCommitment() {
    const textBlock = this.blocks.get(TEXT_INDEX)
    if (textBlock && textBlock.text.trim().length > 0) return true
    for (const b of this.blocks.values()) {
      if (b.type === 'tool-call' && b.name) return true
    }
    return false
  }

  hasAnyOutput() {
    for (const b of this.blocks.values()) {
      if (b.type === 'tool-call') return true
      if (b.text.length > 0) return true
    }
    return false
  }

  hasToolCall() {
    for (const b of this.blocks.values()) {
      if (b.type === 'tool-call') return true
    }
    return false
  }

  closeAllBlocks() {
    const out = []
    for (const index of this.order) {
      const entry = this.blocks.get(index)
      if (!entry) continue
      if (entry.type === 'tool-call') {
        const finalArgs = entry.text.trim().length > 0 ? entry.text : '{}'
        out.push({
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: entry.id || `keyless-call-${index - TOOL_BASE_INDEX}`,
            name: entry.name || 'unknown_tool',
            arguments: finalArgs,
          },
        })
      } else {
        out.push({
          type: 'block-end',
          index,
          block: {
            type: entry.type,
            text: entry.text,
          },
        })
      }
    }
    return out
  }
}

/**
 * Normalize OpenAI / OpenRouter / Ollama usage counters into DSH `TokenUsage`.
 *
 * @param {Record<string, any> | null | undefined} raw
 * @returns {Record<string, number> | null}
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? raw.prefill_tokens ?? 0)
  const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? raw.decode_tokens ?? 0)
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null

  const cached = Number(
    raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? raw.cached_tokens ?? 0,
  )
  const reasoning = Number(
    raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens ?? 0,
  )
  const safePrompt = Math.max(0, Math.floor(prompt || 0))
  const safeCached = Math.max(0, Math.min(safePrompt, Math.floor(cached || 0)))
  const uncachedInput = Math.max(0, safePrompt - safeCached)
  const safeOutput = Math.max(0, Math.floor(completion || 0))
  const total = Number(raw.total_tokens)

  return {
    inputTokens: uncachedInput,
    outputTokens: safeOutput,
    totalTokens:
      Number.isFinite(total) && total >= safePrompt + safeOutput
        ? Math.floor(total)
        : safePrompt + safeOutput,
    ...(safeCached > 0 ? { cacheReadTokens: safeCached } : {}),
    ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoningTokens: Math.floor(reasoning) } : {}),
  }
}

/**
 * Map upstream `finish_reason` strings onto DSH `FinishReason`.
 *
 * @param {string | null | undefined} rawReason
 * @param {boolean} sawToolCalls
 */
export function mapFinishReason(rawReason, sawToolCalls) {
  if (sawToolCalls || rawReason === 'tool_calls' || rawReason === 'function_call') {
    return { kind: 'tool-calls' }
  }
  if (rawReason === 'length' || rawReason === 'max_tokens') {
    return { kind: 'max-tokens' }
  }
  return { kind: 'stop' }
}

/**
 * Sniff whether the initial bytes of an HTTP 200 body are SSE frames or a JSON document.
 *
 * @param {string} headText
 * @returns {'empty' | 'sse' | 'json'}
 */
export function sniffResponseShape(headText) {
  const trimmed = headText.replace(/^\uFEFF/, '').trimStart()
  if (trimmed.length === 0) return 'empty'
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith(':') ||
    trimmed.startsWith('event:') ||
    trimmed.startsWith('id:') ||
    trimmed.startsWith('retry:')
  ) {
    return 'sse'
  }
  return 'json'
}

/**
 * Read up to `minBytes` (or first non-whitespace line) from a Web `ReadableStream`
 * so we can sniff SSE vs JSON without losing a single byte.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {() => void} [onChunkActivity]
 */
async function readStreamHead(body, onChunkActivity) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let done = false

  while (text.trimStart().length < 16) {
    const res = await reader.read()
    if (res.done) {
      done = true
      break
    }
    onChunkActivity?.()
    if (res.value) text += decoder.decode(res.value, { stream: true })
  }
  if (done) text += decoder.decode()
  return { reader, decoder, text, done }
}

/**
 * Replay sniffed head text followed by remaining decoded stream chunks.
 *
 * @param {{ reader: ReadableStreamDefaultReader<Uint8Array>; decoder: TextDecoder; text: string; done: boolean }} head
 * @param {() => void} [onChunkActivity]
 * @returns {AsyncGenerator<string>}
 */
async function* replayDecodedText(head, onChunkActivity) {
  if (head.text.length > 0) yield head.text
  if (head.done) return
  try {
    while (true) {
      const res = await head.reader.read()
      if (res.done) break
      onChunkActivity?.()
      if (res.value) {
        const piece = head.decoder.decode(res.value, { stream: true })
        if (piece.length > 0) yield piece
      }
    }
    const tail = head.decoder.decode()
    if (tail.length > 0) yield tail
  } finally {
    head.reader.releaseLock?.()
  }
}

/**
 * Parse SSE `data:` payloads from a decoded text generator (handles CRLF, CR, LF, multi-line `data:`, comments).
 *
 * @param {AsyncIterable<string>} textStream
 * @returns {AsyncGenerator<string>}
 */
export async function* parseSsePayloads(textStream) {
  let buffer = ''
  /** @type {string[]} */
  let dataLines = []

  const flush = () => {
    if (dataLines.length === 0) return undefined
    const payload = dataLines.join('\n').trim()
    dataLines = []
    return payload.length > 0 && payload !== '[DONE]' ? payload : undefined
  }

  for await (const chunk of textStream) {
    buffer += chunk
    buffer = buffer.replace(/\r\n?/g, '\n')
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line === '') {
        const payload = flush()
        if (payload !== undefined) yield payload
      } else if (line.startsWith('data:')) {
        const val = line.slice(5).replace(/^ /, '')
        if (val.trim() === '[DONE]') {
          const payload = flush()
          if (payload !== undefined) yield payload
          return
        }
        dataLines.push(val)
      }
      nl = buffer.indexOf('\n')
    }
  }

  buffer = buffer.replace(/\r\n?/g, '\n').trim()
  if (buffer.startsWith('data:')) {
    const val = buffer.slice(5).replace(/^ /, '')
    if (val.trim() !== '[DONE]') dataLines.push(val)
  }
  const finalPayload = flush()
  if (finalPayload !== undefined) yield finalPayload
}

/**
 * Consume an OpenAI-compatible HTTP `Response` (SSE or single JSON) and yield DSH `StreamChunk`s.
 *
 * @param {Response} response
 * @param {{ providerId: string; modelId: string; onActivity?: () => void }} meta
 * @returns {AsyncGenerator<any>}
 */
export async function* readOpenAiResponseChunks(response, meta) {
  if (!response.body) {
    throw new KeylessUpstreamError(`[${meta.providerId}] Leerer Antwort-Stream`, ERROR_CODES.EMPTY_RESPONSE, {
      status: response.status,
      providerId: meta.providerId,
      modelId: meta.modelId,
    })
  }

  const head = await readStreamHead(response.body, meta.onActivity)
  const shape = sniffResponseShape(head.text)

  if (shape === 'empty') {
    head.reader.releaseLock?.()
    throw new KeylessUpstreamError(`[${meta.providerId}] Leere Antwort vom Server`, ERROR_CODES.EMPTY_RESPONSE, {
      status: response.status,
      providerId: meta.providerId,
      modelId: meta.modelId,
    })
  }

  const builder = new DshChunkBuilder()
  const splitter = new ThinkTagSplitter()
  /** @type {Record<string, number> | null} */
  let finalUsage = null
  /** @type {string | null} */
  let finishReasonRaw = null

  const feedPayloadObject = function* (obj) {
    if (!obj || typeof obj !== 'object') return
    if (obj.error || (obj.code && !Array.isArray(obj.choices))) {
      throw classifyHttpError(response.status || 502, JSON.stringify(obj), meta)
    }
    if (obj.usage) {
      const normalized = normalizeUsage(obj.usage)
      if (normalized) finalUsage = normalized
    }

    const choices = Array.isArray(obj.choices) ? obj.choices : []
    if (choices.length === 0) return
    const choice = choices[0] ?? {}
    if (choice.finish_reason) finishReasonRaw = String(choice.finish_reason)

    // Handle both streaming `delta` and non-streaming `message`
    const payloadMsg = choice.delta ?? choice.message ?? {}

    const explicitReasoning =
      payloadMsg.reasoning_content ??
      payloadMsg.reasoning ??
      (Array.isArray(payloadMsg.thinking)
        ? payloadMsg.thinking.map((t) => t?.text ?? '').join('')
        : undefined)

    if (typeof explicitReasoning === 'string' && explicitReasoning.length > 0) {
      for (const ch of builder.emitReasoning(explicitReasoning)) yield ch
    }

    let contentStr = ''
    if (typeof payloadMsg.content === 'string') {
      contentStr = payloadMsg.content
    } else if (Array.isArray(payloadMsg.content)) {
      for (const part of payloadMsg.content) {
        if (part?.type === 'thinking' || part?.type === 'reasoning') {
          if (part.text) {
            for (const ch of builder.emitReasoning(String(part.text))) yield ch
          }
        } else if (typeof part?.text === 'string') {
          contentStr += part.text
        }
      }
    }

    if (contentStr.length > 0) {
      const split = splitter.push(contentStr)
      if (split.reasoning) {
        for (const ch of builder.emitReasoning(split.reasoning)) yield ch
      }
      if (split.text) {
        for (const ch of builder.emitText(split.text)) yield ch
      }
    }

    const toolCalls = Array.isArray(payloadMsg.tool_calls) ? payloadMsg.tool_calls : []
    for (let i = 0; i < toolCalls.length; i += 1) {
      const tc = toolCalls[i]
      if (!tc || typeof tc !== 'object') continue
      const slot = typeof tc.index === 'number' ? tc.index : i
      const fn = tc.function ?? {}
      const argsDelta =
        typeof fn.arguments === 'string'
          ? fn.arguments
          : fn.arguments !== undefined
            ? JSON.stringify(fn.arguments)
            : ''
      const chunks = builder.emitToolCallDelta(slot, {
        id: typeof tc.id === 'string' ? tc.id : undefined,
        name: typeof fn.name === 'string' ? fn.name : undefined,
        argumentsDelta: argsDelta,
      })
      for (const ch of chunks) yield ch
    }
  }

  if (shape === 'sse') {
    for await (const dataPayload of parseSsePayloads(replayDecodedText(head, meta.onActivity))) {
      let parsed
      try {
        parsed = JSON.parse(dataPayload)
      } catch {
        continue
      }
      yield* feedPayloadObject(parsed)
    }
  } else {
    let fullText = ''
    for await (const piece of replayDecodedText(head, meta.onActivity)) {
      fullText += piece
    }
    let parsed
    try {
      parsed = JSON.parse(fullText)
    } catch {
      throw new KeylessUpstreamError(
        `[${meta.providerId}] Ungültige JSON-Antwort: ${fullText.slice(0, 180)}`,
        ERROR_CODES.SERVER,
        { status: response.status, providerId: meta.providerId, modelId: meta.modelId },
      )
    }
    yield* feedPayloadObject(parsed)
  }

  const tail = splitter.flush()
  if (tail.reasoning) {
    for (const ch of builder.emitReasoning(tail.reasoning)) yield ch
  }
  if (tail.text) {
    for (const ch of builder.emitText(tail.text)) yield ch
  }

  if (!builder.hasAnyOutput()) {
    throw new KeylessUpstreamError(
      `[${meta.providerId}] Antwort enthielt keinen Text oder Tool-Aufruf (finish_reason=${finishReasonRaw ?? 'none'})`,
      ERROR_CODES.EMPTY_RESPONSE,
      { status: response.status, providerId: meta.providerId, modelId: meta.modelId },
    )
  }

  for (const ch of builder.closeAllBlocks()) yield ch
  if (finalUsage) yield { type: 'usage', usage: finalUsage }
  yield { type: 'finish', reason: mapFinishReason(finishReasonRaw, builder.hasToolCall()) }
}

/**
 * Consume ChatJimmy's raw stream (`text...<|stats|>{json}<|/stats|>`) and yield DSH `StreamChunk`s.
 *
 * @param {Response} response
 * @param {{ providerId: string; modelId: string; onActivity?: () => void }} meta
 */
export async function* readChatJimmyResponseChunks(response, meta) {
  if (!response.body) {
    throw new KeylessUpstreamError(`[${meta.providerId}] Leerer Stream`, ERROR_CODES.EMPTY_RESPONSE, meta)
  }
  const STATS_OPEN = '<|stats|>'
  const TRAILER_RE = /^(.*)<\|stats\|>([\s\S]*?)<\|\/stats\|>\s*$/s

  const head = await readStreamHead(response.body, meta.onActivity)
  const builder = new DshChunkBuilder()
  const splitter = new ThinkTagSplitter()
  let buf = ''
  let holding = false
  let started = false
  const keep = STATS_OPEN.length - 1

  const emitSplit = function* (piece) {
    const split = splitter.push(piece)
    if (split.reasoning) for (const ch of builder.emitReasoning(split.reasoning)) yield ch
    if (split.text) for (const ch of builder.emitText(split.text)) yield ch
  }

  for await (const piece of replayDecodedText(head, meta.onActivity)) {
    buf += piece
    if (holding) continue
    const idx = buf.indexOf(STATS_OPEN)
    let out = ''
    if (idx >= 0) {
      out = buf.slice(0, idx)
      buf = buf.slice(idx)
      holding = true
    } else {
      const cut = Math.max(0, buf.length - keep)
      out = buf.slice(0, cut)
      buf = buf.slice(cut)
    }
    if (!started) out = out.trimStart()
    if (out.length > 0) {
      started = true
      yield* emitSplit(out)
    }
  }

  let statsObj = null
  let tailText = buf
  if (holding) {
    const match = TRAILER_RE.exec(buf)
    if (match) {
      tailText = match[1]
      try {
        statsObj = JSON.parse(match[2])
      } catch {
        statsObj = null
      }
    }
  }

  const cleanTail = started ? tailText.replace(/\s+$/, '') : tailText.trim()
  if (cleanTail.length > 0) {
    yield* emitSplit(cleanTail)
  }

  const rem = splitter.flush()
  if (rem.reasoning) for (const ch of builder.emitReasoning(rem.reasoning)) yield ch
  if (rem.text) for (const ch of builder.emitText(rem.text)) yield ch

  if (!builder.hasAnyOutput()) {
    throw new KeylessUpstreamError(`[${meta.providerId}] Leere ChatJimmy-Antwort`, ERROR_CODES.EMPTY_RESPONSE, meta)
  }

  for (const ch of builder.closeAllBlocks()) yield ch
  const usage = normalizeUsage(statsObj)
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason: mapFinishReason(statsObj?.done_reason, false) }
}

/**
 * Consume Ollama NDJSON stream (`/api/generate` or `/api/chat`) and yield DSH `StreamChunk`s.
 *
 * @param {Response} response
 * @param {{ providerId: string; modelId: string; onActivity?: () => void }} meta
 */
export async function* readOllamaResponseChunks(response, meta) {
  if (!response.body) {
    throw new KeylessUpstreamError(`[${meta.providerId}] Leerer Ollama-Stream`, ERROR_CODES.EMPTY_RESPONSE, meta)
  }
  const head = await readStreamHead(response.body, meta.onActivity)
  const builder = new DshChunkBuilder()
  const splitter = new ThinkTagSplitter()
  let buffer = ''
  let finalStats = null

  const processLine = function* (line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      return
    }
    if (obj.error) {
      throw new KeylessUpstreamError(`[${meta.providerId}] ${obj.error}`, ERROR_CODES.SERVER, meta)
    }
    const piece = obj.message?.content ?? obj.response ?? ''
    if (typeof piece === 'string' && piece.length > 0) {
      const split = splitter.push(piece)
      if (split.reasoning) for (const ch of builder.emitReasoning(split.reasoning)) yield ch
      if (split.text) for (const ch of builder.emitText(split.text)) yield ch
    }
    if (obj.done === true) {
      finalStats = obj
    }
  }

  for await (const chunk of replayDecodedText(head, meta.onActivity)) {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      yield* processLine(line)
      nl = buffer.indexOf('\n')
    }
  }
  if (buffer.trim().length > 0) {
    yield* processLine(buffer)
  }

  const tail = splitter.flush()
  if (tail.reasoning) for (const ch of builder.emitReasoning(tail.reasoning)) yield ch
  if (tail.text) for (const ch of builder.emitText(tail.text)) yield ch

  if (!builder.hasAnyOutput()) {
    throw new KeylessUpstreamError(`[${meta.providerId}] Leere Ollama-Antwort`, ERROR_CODES.EMPTY_RESPONSE, meta)
  }

  for (const ch of builder.closeAllBlocks()) yield ch
  if (finalStats && (finalStats.prompt_eval_count || finalStats.eval_count)) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.max(0, Math.floor(finalStats.prompt_eval_count || 0)),
        outputTokens: Math.max(0, Math.floor(finalStats.eval_count || 0)),
        totalTokens: Math.max(
          0,
          Math.floor((finalStats.prompt_eval_count || 0) + (finalStats.eval_count || 0)),
        ),
      },
    }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
