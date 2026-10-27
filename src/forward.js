/**
 * Optional local loopback OpenAI-compatible gateway (`127.0.0.1:<port>/v1`).
 *
 * Allows external Windows developer tools (VS Code Continue, Cline, Cursor, Aider,
 * OpenAI SDK scripts) to consume the exact same keyless multi-provider pool and
 * smart `auto*` failover router running inside DSH Desktop!
 *
 * Strictly binds to `127.0.0.1` only (never `0.0.0.0`) so free IP quotas are never
 * exposed to the local network without explicit user intent.
 *
 * @module src/forward.js
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { UNIFIED_ROUTE } from './providers.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Start the local loopback OpenAI-compatible forward server.
 *
 * @param {{
 *   port: number;
 *   apiKey?: string;
 *   adapter: import('./adapter.js').KeylessModelsAdapter;
 *   logger?: any;
 * }} opts
 * @returns {Promise<{ host: string; port: number; baseUrl: string; close: () => Promise<void> }>}
 */
export async function startLocalForwardProxy(opts) {
  const host = '127.0.0.1'
  const requestedPort = Math.max(1024, Math.min(65535, Math.floor(Number(opts.port) || 18788)))

  const server = http.createServer(async (req, res) => {
    try {
      const expectedKey = String(opts.apiKey ?? '').trim()
      if (expectedKey.length > 0) {
        const authHeader = String(req.headers.authorization ?? '').trim()
        const bearer = authHeader.toLowerCase().startsWith('bearer ')
          ? authHeader.slice(7).trim()
          : ''
        if (bearer !== expectedKey) {
          sendJson(res, 401, { error: { message: 'Invalid local proxy API key', type: 'authentication_error' } })
          return
        }
      }

      const urlObj = new URL(req.url || '/', `http://${host}`)
      const pathname = urlObj.pathname.replace(/\/+$/, '') || '/'

      if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
        const models = await opts.adapter.listModels(UNIFIED_ROUTE)
        sendJson(res, 200, {
          object: 'list',
          data: models.map((m) => ({
            id: m.id,
            object: 'model',
            created: 1730000000,
            owned_by: 'keylessmodels2dsh',
          })),
        })
        return
      }

      if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
        const body = await readJsonBody(req)
        const model = String(body.model || 'auto')
        const wantStream = body.stream === true
        const rawMsgs = Array.isArray(body.messages) ? body.messages : []

        const dshMessages = rawMsgs.map((m) => ({
          role: m.role || 'user',
          ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
          content:
            typeof m.content === 'string'
              ? [{ type: 'text', text: m.content }]
              : Array.isArray(m.content)
                ? m.content.map((p) =>
                    p?.type === 'image_url'
                      ? { type: 'image', attachment: { url: p.image_url?.url } }
                      : { type: 'text', text: String(p?.text ?? '') },
                  )
                : [],
        }))

        const tools = Array.isArray(body.tools)
          ? body.tools
              .filter((t) => t?.function?.name)
              .map((t) => ({
                name: t.function.name,
                description: t.function.description || '',
                parameters: t.function.parameters || { type: 'object', properties: {} },
              }))
          : undefined

        const abortController = new AbortController()
        req.on('close', () => {
          if (!res.writableEnded) abortController.abort()
        })

        const streamIter = opts.adapter.stream({
          provider: UNIFIED_ROUTE,
          model,
          messages: dshMessages,
          tools,
          temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
          maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
          stop: Array.isArray(body.stop) ? body.stop : undefined,
          signal: abortController.signal,
        })

        const completionId = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`
        const created = Math.floor(Date.now() / 1000)

        if (wantStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })

          let toolSeq = 0
          const indexToSlot = new Map()

          for await (const chunk of streamIter) {
            if (chunk.type === 'reasoning-delta') {
              res.write(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }],
                })}\n\n`,
              )
            } else if (chunk.type === 'text-delta') {
              res.write(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
                })}\n\n`,
              )
            } else if (chunk.type === 'tool-call-delta') {
              let slot = indexToSlot.get(chunk.index)
              if (slot === undefined) {
                slot = toolSeq++
                indexToSlot.set(chunk.index, slot)
              }
              res.write(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: slot,
                            id: chunk.id,
                            type: 'function',
                            function: {
                              ...(chunk.name ? { name: chunk.name } : {}),
                              arguments: chunk.argumentsDelta || '',
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              )
            } else if (chunk.type === 'finish') {
              if (chunk.reason?.kind === 'error') {
                res.write(`data: ${JSON.stringify({ error: chunk.reason.failure })}\n\n`)
              } else {
                const fr =
                  chunk.reason?.kind === 'tool-calls'
                    ? 'tool_calls'
                    : chunk.reason?.kind === 'max-tokens'
                      ? 'length'
                      : 'stop'
                res.write(
                  `data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: fr }],
                  })}\n\n`,
                )
              }
            }
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // Non-streaming aggregation
        let fullText = ''
        let fullReasoning = ''
        const toolCalls = []
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        let finishReason = 'stop'

        for await (const chunk of streamIter) {
          if (chunk.type === 'block-end') {
            if (chunk.block.type === 'text') fullText += chunk.block.text
            else if (chunk.block.type === 'reasoning') fullReasoning += chunk.block.text
            else if (chunk.block.type === 'tool-call') {
              toolCalls.push({
                id: chunk.block.id,
                type: 'function',
                function: { name: chunk.block.name, arguments: chunk.block.arguments },
              })
            }
          } else if (chunk.type === 'usage') {
            usage = {
              prompt_tokens: chunk.usage.inputTokens || 0,
              completion_tokens: chunk.usage.outputTokens || 0,
              total_tokens: chunk.usage.totalTokens || 0,
            }
          } else if (chunk.type === 'finish') {
            if (chunk.reason?.kind === 'error') {
              sendJson(res, chunk.reason.failure?.status || 502, { error: chunk.reason.failure })
              return
            }
            if (chunk.reason?.kind === 'tool-calls') finishReason = 'tool_calls'
            else if (chunk.reason?.kind === 'max-tokens') finishReason = 'length'
          }
        }

        sendJson(res, 200, {
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: fullText || null,
                ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage,
        })
        return
      }

      sendJson(res, 404, { error: { message: 'Not found' } })
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      } else {
        res.end()
      }
    }
  })

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    server.once('error', onError)
    server.listen(requestedPort, host, () => {
      server.off('error', onError)
      resolve(undefined)
    })
  })

  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort

  return {
    host,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}
