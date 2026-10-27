import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOpenAiTools,
  repairToolPairing,
  toOpenAiChatMessages,
} from '../src/messages.js'
import {
  ERROR_CODES,
  REASONING_INDEX,
  TEXT_INDEX,
  TOOL_BASE_INDEX,
  ThinkTagSplitter,
  classifyHttpError,
  readChatJimmyResponseChunks,
  readOllamaResponseChunks,
  readOpenAiResponseChunks,
} from '../src/stream.js'

test('repairToolPairing handles DSH 0.2.1-rc.2 role:"tool" messages, legacy blocks, and orphans', () => {
  const rawMessages = [
    { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Need file content.' },
        { type: 'tool-call', id: 'call_valid', name: 'read_file', arguments: '{"path":"package.json"}' },
        { type: 'tool-call', id: 'call_unanswered', name: 'run_cmd', arguments: '{}' },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call_valid',
      isError: false,
      content: [{ type: 'text', text: '{"name":"demo"}' }],
    },
    {
      role: 'tool',
      toolCallId: 'call_ghost_orphan',
      isError: true,
      content: [{ type: 'text', text: 'orphan output' }],
    },
  ]

  const wire = toOpenAiChatMessages(rawMessages, 'System instructions', {
    supportsVision: true,
    supportsTools: true,
  })

  // System prompt prepended once
  assert.equal(wire[0].role, 'system')
  assert.equal(wire[0].content, 'System instructions')

  // Unanswered `call_unanswered` and orphan `call_ghost_orphan` are cleanly stripped,
  // leaving a valid 1-to-1 paired `[call_valid]` <-> `[call_valid]` sequence!
  const assistantMsg = wire.find((m) => m.role === 'assistant')
  assert.equal(assistantMsg.tool_calls.length, 1)
  assert.equal(assistantMsg.tool_calls[0].id, 'call_valid')

  const toolMsgs = wire.filter((m) => m.role === 'tool')
  assert.equal(toolMsgs.length, 1)
  assert.equal(toolMsgs[0].tool_call_id, 'call_valid')

  // Also check standalone repairToolPairing invariants
  const repaired = repairToolPairing(rawMessages)
  assert.equal(repaired.filter((m) => m.role === 'tool').length, 1)
})

test('buildOpenAiTools folds both V3 tools array and V4 toolHistory { tools, updates }', () => {
  const folded = buildOpenAiTools(undefined, {
    tools: [{ name: 'bash', description: 'Run shell', parameters: { type: 'object' } }],
    updates: [
      {
        atMessage: 2,
        additions: [{ name: 'read_file', description: 'Read file', parameters: { type: 'object' } }],
      },
    ],
  })

  assert.equal(folded?.length, 2)
  assert.equal(folded?.[0].function.name, 'bash')
  assert.equal(folded?.[1].function.name, 'read_file')
})

test('ThinkTagSplitter separates <think>...</think> across arbitrary token boundaries', () => {
  const splitter = new ThinkTagSplitter()
  let rText = ''
  let aText = ''

  for (const part of ['<thi', 'nk>Step 1', ' & Step 2</th', 'ink>Final ', 'Answer!']) {
    const out = splitter.push(part)
    rText += out.reasoning
    aText += out.text
  }
  const tail = splitter.flush()
  rText += tail.reasoning
  aText += tail.text

  assert.equal(rText, 'Step 1 & Step 2')
  assert.equal(aText, 'Final Answer!')
})

test('readOpenAiResponseChunks emits disjoint DSH StreamChunk bands and non-empty tool-call IDs on every delta', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}',
    'data: {"choices":[{"delta":{"content":"Let me check."}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":25,"completion_tokens":14,"total_tokens":39}}',
    'data: [DONE]',
    '',
  ].join('\n\n')

  const resp = new Response(sseLines, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })

  const chunks = []
  for await (const c of readOpenAiResponseChunks(resp, { providerId: 'kilo', modelId: 'kilo-auto/free' })) {
    chunks.push(c)
  }

  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.deepEqual(
    starts.map((s) => [s.index, s.blockType]),
    [
      [REASONING_INDEX, 'reasoning'],
      [TEXT_INDEX, 'text'],
      [TOOL_BASE_INDEX + 0, 'tool-call'],
    ],
  )

  const toolDeltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.equal(toolDeltas.length, 2)
  // CRITICAL DSH 0.2.1-rc.2 invariant: EVERY tool-call-delta MUST carry non-empty `id`!
  for (const td of toolDeltas) {
    assert.equal(td.id, 'call_abc')
    assert.equal(td.index, TOOL_BASE_INDEX + 0)
  }

  const toolEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(toolEnd.block.arguments, '{"path":"a.txt"}')

  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
})

test('ChatJimmy <|stats|> trailer and Ollama NDJSON parse into clean DSH StreamChunks', async () => {
  const cjBody = '<think>fast silicon</think>Hello from Taalas!<|stats|>{"prefill_tokens":18,"decode_tokens":9,"total_tokens":27}<|/stats|>'
  const cjResp = new Response(cjBody, { status: 200 })
  const cjChunks = []
  for await (const c of readChatJimmyResponseChunks(cjResp, { providerId: 'chatjimmy', modelId: 'llama3.1-8B' })) {
    cjChunks.push(c)
  }
  assert.ok(cjChunks.some((c) => c.type === 'reasoning-delta' && c.text.includes('fast silicon')))
  assert.ok(cjChunks.some((c) => c.type === 'text-delta' && c.text.includes('Hello from Taalas!')))
  assert.ok(!cjChunks.some((c) => c.type === 'text-delta' && c.text.includes('<|stats|>')))
  const cjUsage = cjChunks.find((c) => c.type === 'usage')
  assert.equal(cjUsage.usage.inputTokens, 18)
  assert.equal(cjUsage.usage.outputTokens, 9)

  const ollamaBody = [
    JSON.stringify({ response: 'Tiny ', done: false }),
    JSON.stringify({ response: 'Llama!', done: true, prompt_eval_count: 10, eval_count: 4 }),
  ].join('\n')
  const olResp = new Response(ollamaBody, { status: 200 })
  const olChunks = []
  for await (const c of readOllamaResponseChunks(olResp, { providerId: 'mlvoca', modelId: 'tinyllama' })) {
    olChunks.push(c)
  }
  const olEnd = olChunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(olEnd.block.text, 'Tiny Llama!')
})

test('classifyHttpError distinguishes 429 rate-limit, OpenCode FreeTierError, and context overflow', () => {
  const err429 = classifyHttpError(429, '{"error":{"message":"Anonymous quota exceeded"}}', {
    retryAfterMs: 45_000,
    providerId: 'ovh',
  })
  assert.equal(err429.code, ERROR_CODES.RATE_LIMIT)
  assert.equal(err429.retryAfterMs, 45_000)

  const errCtx = classifyHttpError(400, '{"error":{"message":"maximum context length is 32768 tokens"}}', {
    providerId: 'llm7',
  })
  assert.equal(errCtx.code, ERROR_CODES.CONTEXT_OVERFLOW)

  const errGate = classifyHttpError(403, '{"type":"FreeTierError","message":"Client blocked"}', {
    providerId: 'opencode-zen',
  })
  assert.equal(errGate.code, ERROR_CODES.AUTH)
})
