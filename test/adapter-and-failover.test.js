import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createPluginStores } from '../src/store.js'
import { KeylessRouterPool } from '../src/router.js'
import { KeylessModelsAdapter } from '../src/adapter.js'
import { UNIFIED_ROUTE } from '../src/providers.js'
import * as hostPlugin from '../index.js'

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'km2dsh-adapter-'))
}

test('Buffered pre-commit failover discards partial <think> attempt on 429 and streams healthy fallback cleanly', async () => {
  const dataDir = makeTempDir()
  const stores = createPluginStores({ dataDir })
  const pool = new KeylessRouterPool({ stores })

  const attemptedUrls = []
  const mockFetch = async (url) => {
    const u = String(url)
    attemptedUrls.push(u)

    // First candidate starts streaming `<think>` reasoning and then blows up mid-stream before committing!
    if (attemptedUrls.length === 1) {
      const brokenStream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"reasoning_content":"Uncommitted partial thought..."}}]}\n\n',
            ),
          )
          ctrl.enqueue(
            new TextEncoder().encode(
              'data: {"error":{"message":"Mid-stream rate limit 429","code":429}}\n\n',
            ),
          )
          ctrl.close()
        },
      })
      return new Response(brokenStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    // Second candidate returns a clean complete SSE answer!
    const cleanSse = [
      'data: {"choices":[{"delta":{"reasoning_content":"Backup reasoning."}}]}',
      'data: {"choices":[{"delta":{"content":"Clean answer from fallback provider!"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    return new Response(cleanSse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  const adapter = new KeylessModelsAdapter({
    pool,
    getUserAgent: () => 'test-ua/1.0',
    fetchImpl: mockFetch,
  })

  const call = await adapter.prepareCall(UNIFIED_ROUTE, 'auto')
  assert.equal(Number.isInteger(call.model.context.contextWindow), true)
  assert.equal(Number.isInteger(call.model.defaultMaxTokens), true)

  const emitted = []
  for await (const chunk of call.stream({
    provider: UNIFIED_ROUTE,
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hallo Welt!' }] }],
  })) {
    emitted.push(chunk)
  }

  assert.equal(attemptedUrls.length, 2, 'must have failed over from candidate #1 to candidate #2')
  // Uncommitted partial thought from candidate #1 MUST NOT leak into the consumer stream!
  assert.ok(
    !emitted.some((c) => c.type === 'reasoning-delta' && c.text.includes('Uncommitted partial thought')),
    'buffered pre-commit reasoning from failed candidate #1 must be discarded',
  )
  const textEnd = emitted.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(textEnd.block.text, 'Clean answer from fallback provider!')
  assert.equal(emitted.at(-1).reason.kind, 'stop')

  const stats = pool.getRuntimeState().stats
  assert.equal(stats.successfulRequests, 1)
  assert.equal(stats.failovers, 1)

  stores.dispose()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('Closing stream iterator early via break immediately aborts upstream fetch signal', async () => {
  const dataDir = makeTempDir()
  const stores = createPluginStores({ dataDir })
  const pool = new KeylessRouterPool({ stores })

  let upstreamSignalAborted = false
  const mockFetch = async (_url, init) => {
    init.signal.addEventListener('abort', () => {
      upstreamSignalAborted = true
    })
    const multiEventStream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"First token "}}]}\n\n'),
        )
      },
    })
    return new Response(multiEventStream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  const adapter = new KeylessModelsAdapter({
    pool,
    getUserAgent: () => 'test-ua/1.0',
    fetchImpl: mockFetch,
  })

  for await (const chunk of adapter.stream({
    provider: UNIFIED_ROUTE,
    model: 'kilo/kilo-auto/free',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  })) {
    if (chunk.type === 'text-delta') {
      break
    }
  }

  assert.equal(upstreamSignalAborted, true, 'breaking out of stream must immediately abort fetch AbortSignal')

  stores.dispose()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('Real @deepseek-ai/dsh@0.2.1-rc.2 seam compatibility (Cordis + LlmRuntime + BlockAssembler + dsh-app-boot)', async (t) => {
  const seamNodeModules = '/tmp/research/dsh-seam/node_modules'
  if (!fs.existsSync(seamNodeModules)) {
    t.skip('Optional local @deepseek-ai/dsh@0.2.1-rc.2 testbench not present')
    return
  }

  const cordis = await import(
    pathToFileURL(path.join(seamNodeModules, '@deepseek-ai/cordis/lib/index.mjs')).href
  ).catch(() =>
    import(pathToFileURL(path.join(seamNodeModules, '@deepseek-ai/cordis/lib/index.js')).href),
  )
  const dshLlm = await import(
    pathToFileURL(path.join(seamNodeModules, '@deepseek-ai/dsh-llm/lib/index.js')).href
  )
  const dshClientModules = await import(
    pathToFileURL(path.join(seamNodeModules, '@deepseek-ai/dsh-client-modules/lib/index.js')).href
  )
  const dshAppBoot = await import(
    pathToFileURL(path.join(seamNodeModules, '@deepseek-ai/dsh-app-boot/lib/index.js')).href
  )

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

  // 1. Validate plugin compatibility against DSH 0.2.1-rc.2 (`dsh-desktop` v0.12.1)
  const unmet = dshAppBoot.evaluatePluginCompatibility(pkgJson, {}, '0.2.1-rc.2')
  assert.equal(unmet, undefined, 'Plugin must have ZERO unmet engine/peer requirements on DSH 0.2.1-rc.2')

  // 2. Validate module graph ordering in `@deepseek-ai/dsh-client-modules`
  const ordered = dshClientModules.orderByModuleGraph([
    {
      id: pkgJson.name,
      url: 'plugins/??keylessmodels2dsh/client.js&rev=000000000000',
      rev: '000000000000',
      inject: pkgJson.dsh.client.inject,
      immediately: pkgJson.dsh.client.immediately,
    },
  ])
  assert.equal(ordered.length, 1)
  assert.equal(ordered[0].id, 'keylessmodels2dsh')

  // 3. Validate `readPluginMeta` by temporarily linking package in a temp node_modules
  const metaTmp = makeTempDir()
  const linkedPkgDir = path.join(metaTmp, 'node_modules', 'keylessmodels2dsh')
  fs.mkdirSync(path.dirname(linkedPkgDir), { recursive: true })
  fs.symlinkSync(repoRoot, linkedPkgDir, 'dir')
  const parentPkgFile = path.join(metaTmp, 'package.json')
  fs.writeFileSync(parentPkgFile, '{"name":"test-profile"}')
  const meta = dshAppBoot.readPluginMeta('keylessmodels2dsh', pathToFileURL(parentPkgFile).href)
  assert.ok(meta, 'readPluginMeta must resolve plugin metadata')
  assert.ok(String(meta.title?.en || meta.title || '').length > 0)
  fs.rmSync(metaTmp, { recursive: true, force: true })

  // 4. Mount real `LlmRuntime` on a real Cordis v4 `Context`, then mount `keylessmodels2dsh`!
  const dataDir = makeTempDir()
  const rootCtx = new cordis.Context()
  const llmFiber = rootCtx.plugin(dshLlm.default)

  // Wait for `llm` service to become active
  await new Promise((resolve) => rootCtx.inject(['llm'], () => resolve(undefined)))

  const mockFetch = async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"Plan check."}}]}',
      'data: {"choices":[{"delta":{"content":"Executing tool."}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_99","function":{"name":"bash","arguments":"{\\"cmd\\":\\"dir\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":15,"completion_tokens":10,"total_tokens":25}}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  const pluginFiber = rootCtx.plugin(hostPlugin, {
    dataDir,
    disableAutoBootNetwork: true,
    fetchImpl: mockFetch,
  })

  // Wait a tick for nested plugin fiber
  await new Promise((r) => setTimeout(r, 50))

  const providers = rootCtx.llm.listProviders()
  assert.ok(
    providers.some((p) => p.id === 'keyless-free'),
    'Real LlmRuntime must list "keyless-free" provider route',
  )

  const listed = await rootCtx.llm.listModels('keyless-free')
  assert.ok(listed.length > 20, 'Real LlmRuntime.listModels("keyless-free") must return models')

  const resolvedModel = await rootCtx.llm.resolveModelInfo('keyless-free', 'auto-coding')
  assert.equal(resolvedModel.provider, 'keyless-free')
  assert.equal(resolvedModel.id, 'auto-coding')
  assert.ok(resolvedModel.context.contextWindow >= 131072)

  // Verify `providerRetryPolicy` passes real `LlmRuntime` validation without throwing!
  const retryPol = rootCtx.llm.providerRetryPolicy('keyless-free')
  assert.equal(retryPol.mode, 'normal')

  // Stream through real `LlmRuntime.stream()` + real `BlockAssembler.push()`!
  const assembler = new dshLlm.BlockAssembler()
  const streamIterable = await rootCtx.llm.stream({
    provider: 'keyless-free',
    model: 'auto-coding',
    messages: [dshLlm.createUserMessage({ content: [{ type: 'text', text: 'List files' }] })],
  })
  for await (const chunk of streamIterable) {
    assembler.push(chunk)
  }

  const finalBlocks = assembler.blocks()
  assert.equal(finalBlocks.length, 3)
  assert.equal(finalBlocks[0].type, 'reasoning')
  assert.equal(finalBlocks[1].type, 'text')
  assert.equal(finalBlocks[2].type, 'tool-call')
  assert.equal(finalBlocks[2].name, 'bash')
  assert.deepEqual(JSON.parse(finalBlocks[2].arguments), { cmd: 'dir' })
  assert.equal(assembler.finish.kind, 'tool-calls')
  assert.equal(assembler.usage?.totalTokens, 25)

  pluginFiber.dispose()
  llmFiber.dispose()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
