/**
 * DeepSeek Harness (`@deepseek-ai/dsh-llm@0.2.1-rc.2`) message, image,
 * reasoning-effort, and `ToolHistory` projection onto keyless wire protocols.
 *
 * Key seam invariants enforced here:
 *   1. `options.toolHistory` is an OBJECT `{ tools, updates }` — never an array.
 *   2. Tool results arrive as `role: 'tool'` (`ToolResultMessage` with `toolCallId`)
 *      in DSH 0.2.x, or legacy `tool-result` blocks in `user` content; both are handled.
 *   3. Interrupted sessions can leave unanswered `tool-call`s or nameless calls in
 *      durable history; `repairToolPairing()` cleans them so upstreams never 400.
 *   4. Vision models receive `image_url` data URLs; text-only models receive a
 *      safe descriptive placeholder instead of triggering HTTP 400 on image parts.
 *
 * @module src/messages.js
 */

/**
 * Normalize message `content` into an array of block objects.
 *
 * @param {unknown} content
 * @returns {Record<string, any>[]}
 */
export function normalizeContentBlocks(content) {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) out.push({ type: 'text', text: part })
    } else if (part && typeof part === 'object') {
      if (part.type === 'input_text' || part.type === 'output_text') {
        out.push({ type: 'text', text: String(part.text ?? '') })
      } else {
        out.push(part)
      }
    }
  }
  return out
}

/**
 * Extract plain text from content blocks.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function extractPlainText(content) {
  const blocks = normalizeContentBlocks(content)
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Extract tool-result records from a message (both V4 `role: 'tool'` and legacy `tool-result`).
 *
 * @param {Record<string, any>} message
 * @returns {{ callId: string; content: Record<string, any>[]; isError: boolean }[]}
 */
function extractToolResults(message) {
  if (!message || typeof message !== 'object') return []
  if (message.role === 'tool') {
    const id = String(message.toolCallId ?? message.source?.callId ?? '').trim()
    if (!id) return []
    return [
      {
        callId: id,
        content: normalizeContentBlocks(message.content),
        isError: message.isError === true,
      },
    ]
  }
  const results = []
  for (const block of normalizeContentBlocks(message.content)) {
    if (block.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? message.source?.callId ?? '').trim()
    if (!id) continue
    results.push({
      callId: id,
      content: normalizeContentBlocks(block.content),
      isError: block.isError === true,
    })
  }
  return results
}

/**
 * Remove unanswered or nameless tool calls and orphaned tool results so strict
 * OpenAI-compatible gateways never reject the conversation with HTTP 400.
 *
 * @param {readonly Record<string, any>[]} messages
 * @returns {Record<string, any>[]}
 */
export function repairToolPairing(messages) {
  const list = Array.isArray(messages) ? messages : []
  const answeredIds = new Set()
  for (const msg of list) {
    for (const res of extractToolResults(msg)) {
      answeredIds.add(res.callId)
    }
  }

  const validCallIds = new Set()
  const repaired = []

  for (const msg of list) {
    if (!msg || typeof msg !== 'object') continue
    const results = extractToolResults(msg)
    if (results.length > 0) {
      if (msg.role === 'tool') {
        if (validCallIds.has(results[0].callId)) repaired.push(msg)
        continue
      }
      const keptIds = new Set(results.filter((r) => validCallIds.has(r.callId)).map((r) => r.callId))
      const blocks = normalizeContentBlocks(msg.content)
      const filtered = blocks.filter(
        (b) => b.type !== 'tool-result' || keptIds.has(String(b.toolCallId ?? msg.source?.callId ?? '').trim()),
      )
      if (filtered.length > 0) repaired.push({ ...msg, content: filtered })
      continue
    }

    if (msg.role === 'tool') continue

    if (msg.role !== 'assistant') {
      repaired.push(msg)
      continue
    }

    const blocks = normalizeContentBlocks(msg.content)
    const toolBlocks = blocks.filter((b) => b.type === 'tool-call')
    const validCalls = toolBlocks.filter((b) => {
      const id = String(b.id ?? '').trim()
      const name = String(b.name ?? '').trim()
      return id.length > 0 && name.length > 0 && answeredIds.has(id)
    })

    for (const call of validCalls) {
      validCallIds.add(String(call.id).trim())
    }

    if (validCalls.length === toolBlocks.length) {
      if (validCalls.length > 0 || blocks.some((b) => (b.type === 'text' || b.type === 'reasoning') && b.text)) {
        repaired.push(msg)
      }
      continue
    }

    const nonToolBlocks = blocks.filter((b) => b.type !== 'tool-call')
    if (validCalls.length === 0) {
      if (nonToolBlocks.some((b) => b.type === 'text' && b.text)) {
        repaired.push({ ...msg, content: nonToolBlocks })
      }
      continue
    }

    const validSet = new Set(validCalls)
    repaired.push({
      ...msg,
      content: blocks.filter((b) => b.type !== 'tool-call' || validSet.has(b)),
    })
  }

  return repaired
}

/**
 * Encode `Uint8Array` or `Buffer` bytes to base64 safely without call-stack overflow.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function uint8ToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  }
  const chunks = []
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + step)))
  }
  return btoa(chunks.join(''))
}

/**
 * Resolve an `ImageBlock` attachment into a base64 `data:` URL when available.
 *
 * @param {Record<string, any>} block
 * @param {(attachment: any) => string | undefined} [resolveAttachment]
 * @returns {string | undefined}
 */
export function resolveImageDataUrl(block, resolveAttachment) {
  if (!block || block.offloaded === true) return undefined
  const attachment = block.attachment
  if (!attachment || typeof attachment !== 'object') return undefined

  if (typeof resolveAttachment === 'function') {
    const resolved = resolveAttachment(attachment)
    if (typeof resolved === 'string' && resolved.length > 0) return resolved
  }

  const version = attachment.version ?? attachment
  const mediaType = version.mediaType ?? attachment.mediaType ?? 'image/png'
  const bytes = version.data ?? version.bytes
  if (bytes instanceof Uint8Array) {
    return `data:${mediaType};base64,${uint8ToBase64(bytes)}`
  }
  if (typeof bytes === 'string' && bytes.length > 0) {
    return bytes.startsWith('data:') ? bytes : `data:${mediaType};base64,${bytes}`
  }
  if (typeof attachment.dataUrl === 'string' && attachment.dataUrl.length > 0) {
    return attachment.dataUrl
  }
  if (typeof attachment.url === 'string' && attachment.url.length > 0) {
    return attachment.url
  }
  return undefined
}

/**
 * Project DSH `GenerateOptions.messages` + `system` onto OpenAI Chat Completions wire messages.
 *
 * @param {readonly Record<string, any>[]} rawMessages
 * @param {string | undefined} systemPrompt
 * @param {{ supportsVision?: boolean; supportsTools?: boolean; resolveImage?: (att: any) => string | undefined }} [opts]
 * @returns {Record<string, any>[]}
 */
export function toOpenAiChatMessages(rawMessages, systemPrompt, opts = {}) {
  const supportsVision = opts.supportsVision === true
  const supportsTools = opts.supportsTools !== false
  const cleaned = repairToolPairing(rawMessages)
  /** @type {Record<string, any>[]} */
  const wire = []

  for (const msg of cleaned) {
    switch (msg.role) {
      case 'system':
      case 'developer': {
        const text = extractPlainText(msg.content)
        if (text.trim().length > 0) {
          wire.push({ role: 'system', content: text })
        }
        break
      }

      case 'tool': {
        const callId = String(msg.toolCallId ?? msg.source?.callId ?? '').trim()
        const text = extractPlainText(msg.content)
        const formatted = msg.isError === true && text ? `[Tool Error] ${text}` : text
        if (supportsTools && callId) {
          wire.push({
            role: 'tool',
            tool_call_id: callId,
            content: formatted || '(empty tool result)',
          })
        } else if (formatted) {
          wire.push({
            role: 'user',
            content: `[Tool Result ${callId || 'call'}]\n${formatted}`,
          })
        }
        break
      }

      case 'assistant': {
        const blocks = normalizeContentBlocks(msg.content)
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('')
        const toolCalls = blocks
          .filter((b) => b.type === 'tool-call')
          .map((b) => ({
            id: String(b.id),
            type: 'function',
            function: {
              name: String(b.name),
              arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}),
            },
          }))

        if (supportsTools && toolCalls.length > 0) {
          wire.push({
            role: 'assistant',
            content: text.length > 0 ? text : null,
            tool_calls: toolCalls,
          })
        } else {
          const fallbackToolSummary =
            toolCalls.length > 0
              ? toolCalls.map((tc) => `[Called tool ${tc.function.name}(${tc.function.arguments})]`).join('\n')
              : ''
          const merged = [text, fallbackToolSummary].filter(Boolean).join('\n')
          if (merged.length > 0) {
            wire.push({ role: 'assistant', content: merged })
          }
        }
        break
      }

      default: {
        // User message (may also contain legacy `tool-result` blocks)
        const blocks = normalizeContentBlocks(msg.content)
        const legacyResults = extractToolResults(msg)
        if (legacyResults.length > 0 && supportsTools) {
          for (const tr of legacyResults) {
            const trText = extractPlainText(tr.content)
            wire.push({
              role: 'tool',
              tool_call_id: tr.callId,
              content: tr.isError && trText ? `[Tool Error] ${trText}` : trText || '(empty tool result)',
            })
          }
        }

        const userParts = []
        for (const block of blocks) {
          if (block.type === 'tool-result') continue
          if (block.type === 'text' && typeof block.text === 'string') {
            userParts.push({ type: 'text', text: block.text })
          } else if (block.type === 'image') {
            const url = supportsVision ? resolveImageDataUrl(block, opts.resolveImage) : undefined
            if (url) {
              userParts.push({ type: 'image_url', image_url: { url } })
            } else {
              const name = block.attachment?.name ?? 'image'
              userParts.push({
                type: 'text',
                text: supportsVision
                  ? `[Image attachment "${name}" omitted: bytes unavailable]`
                  : `[Image attachment "${name}" omitted: selected keyless model is text-only]`,
              })
            }
          }
        }

        if (userParts.length > 0) {
          wire.push({
            role: 'user',
            content:
              userParts.length === 1 && userParts[0].type === 'text' ? userParts[0].text : userParts,
          })
        } else if (legacyResults.length === 0) {
          wire.push({ role: 'user', content: '' })
        }
        break
      }
    }
  }

  if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
    if (wire[0]?.role !== 'system') {
      wire.unshift({ role: 'system', content: systemPrompt })
    }
  }

  // Ensure at least one message exists for strict OpenAI gateways
  if (wire.length === 0) {
    wire.push({ role: 'user', content: 'Hello' })
  }

  return wire
}

/**
 * Flatten conversation into plain `{ role, content }` strings for non-OpenAI wires
 * (`chatjimmy` and `ollama`).
 *
 * @param {readonly Record<string, any>[]} rawMessages
 * @param {string | undefined} systemPrompt
 * @returns {{ role: string; content: string }[]}
 */
export function toPlainTextMessages(rawMessages, systemPrompt) {
  const wire = toOpenAiChatMessages(rawMessages, systemPrompt, {
    supportsVision: false,
    supportsTools: false,
  })
  return wire.map((m) => ({
    role: m.role === 'tool' ? 'user' : String(m.role ?? 'user'),
    content:
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
          : '',
  }))
}

/**
 * Fold `GenerateOptions.tools` and `GenerateOptions.toolHistory` (`{ tools, updates }`)
 * into OpenAI function tool declarations.
 *
 * CRITICAL: `toolHistory` in `@deepseek-ai/dsh-llm@0.2.1-rc.2` is an OBJECT
 * `{ tools: readonly ToolSchema[], updates: readonly { messageId, additions }[] }`,
 * NEVER an iterable array!
 *
 * @param {readonly any[] | undefined} tools
 * @param {{ tools?: readonly any[]; updates?: readonly { messageId?: string; additions?: readonly any[] }[] } | undefined} toolHistory
 * @returns {Record<string, any>[] | undefined}
 */
export function buildOpenAiTools(tools, toolHistory) {
  if (tools === undefined && toolHistory === undefined) return undefined

  /** @type {Map<string, any>} */
  const byName = new Map()

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (typeof tool?.name === 'string' && tool.name.length > 0) {
        byName.set(tool.name, tool)
      }
    }
  }

  if (toolHistory && typeof toolHistory === 'object' && !Array.isArray(toolHistory)) {
    if (Array.isArray(toolHistory.tools)) {
      for (const tool of toolHistory.tools) {
        if (typeof tool?.name === 'string' && tool.name.length > 0) {
          byName.set(tool.name, tool)
        }
      }
    }
    if (Array.isArray(toolHistory.updates)) {
      for (const update of toolHistory.updates) {
        if (!Array.isArray(update?.additions)) continue
        for (const addition of update.additions) {
          if (typeof addition?.name === 'string' && addition.name.length > 0 && !byName.has(addition.name)) {
            byName.set(addition.name, addition)
          }
        }
      }
    }
  }

  if (byName.size === 0) return undefined

  return [...byName.values()].map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(typeof tool.description === 'string' && tool.description.length > 0
        ? { description: tool.description }
        : {}),
      parameters:
        tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
    },
  }))
}

/**
 *Selectable reasoning effort descriptors for models with reasoning capability.
 *
 * @param {{ reasoning?: boolean; reasoningCannotDisable?: boolean } | null | undefined} modelEntry
 */
export function buildReasoningMetadata(modelEntry) {
  if (!modelEntry || modelEntry.reasoning !== true) return undefined
  const efforts = []
  if (!modelEntry.reasoningCannotDisable) {
    efforts.push({ id: 'off', name: 'Off', description: 'Deaktiviert explizites Thinking für schnellere Antworten' })
  }
  efforts.push(
    { id: 'low', name: 'Low', description: 'Kurzes Reasoning für alltägliche Aufgaben' },
    { id: 'medium', name: 'Medium', description: 'Ausgewogenes Reasoning-Budget' },
    { id: 'high', name: 'High', description: 'Maximale Reasoning-Tiefe für komplexe Probleme' },
  )
  return {
    efforts,
    defaultEffort: 'medium',
  }
}

/**
 * Build upstream wire parameters for a selected `reasoningEffort`.
 *
 * @param {Record<string, any>} provider
 * @param {Record<string, any> | null} modelEntry
 * @param {string | undefined} effort
 * @returns {Record<string, any>}
 */
export function buildReasoningWirePatch(provider, modelEntry, effort) {
  if (!effort || !modelEntry?.reasoning) return {}
  const normalized = String(effort).toLowerCase()
  if (normalized === 'off' && modelEntry.reasoningCannotDisable) return {}

  if (provider.id === 'kilo' || provider.id === 'kilo-openrouter') {
    if (normalized === 'off') return { reasoning: { enabled: false } }
    if (['low', 'medium', 'high'].includes(normalized)) {
      return { reasoning: { effort: normalized } }
    }
    return {}
  }

  // Only send `reasoning_effort` on providers known to accept it without HTTP 400
  if (['ovh', 'vireonix', 'llm7'].includes(provider.id) && ['low', 'medium', 'high'].includes(normalized)) {
    return { reasoning_effort: normalized }
  }

  return {}
}
