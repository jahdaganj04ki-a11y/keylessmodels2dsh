import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  BUILTIN_PROVIDERS,
  UNIFIED_ROUTE,
  VIRTUAL_MODELS,
  findVirtualModel,
  isFreeOnProvider,
} from '../src/providers.js'
import { createPluginStores, resolveDshHome } from '../src/store.js'
import { KeylessRouterPool, normalizeCustomProvider } from '../src/router.js'
import { ERROR_CODES, KeylessUpstreamError } from '../src/stream.js'
import {
  discoverProviderModels,
  scanLocalZeroKeyServers,
  syncStillworksLiveShelf,
} from '../src/discovery.js'

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'km2dsh-router-'))
}

test('Windows DSH Desktop path resolution prioritizes %APPDATA%\\dsh-desktop\\harness', () => {
  const tmp = makeTempDir()
  const fakeAppData = path.join(tmp, 'AppData', 'Roaming')
  const desktopHarness = path.join(fakeAppData, 'dsh-desktop', 'harness')
  fs.mkdirSync(desktopHarness, { recursive: true })

  const resolved = resolveDshHome(
    { APPDATA: fakeAppData, USERPROFILE: tmp },
    'win32',
  )
  assert.equal(resolved, desktopHarness)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('Built-in registry filters Kilo free models and excludes paid models', () => {
  const kilo = BUILTIN_PROVIDERS.find((p) => p.id === 'kilo')
  assert.ok(kilo, 'kilo provider must exist')
  assert.equal(isFreeOnProvider(kilo, { id: 'kilo-auto/free' }), true)
  assert.equal(isFreeOnProvider(kilo, { id: 'minimax/minimax-m2.5:free' }), true)
  assert.equal(
    isFreeOnProvider(kilo, {
      id: 'z-ai/glm-5-free-promo',
      pricing: { prompt: '0', completion: '0' },
    }),
    true,
  )
  assert.equal(
    isFreeOnProvider(kilo, {
      id: 'anthropic/claude-sonnet-4.5',
      pricing: { prompt: '0.000003', completion: '0.000015' },
    }),
    false,
  )
})

test('Router pool ranks candidates by capability, sticky session, and cooldowns', () => {
  const dataDir = makeTempDir()
  const stores = createPluginStores({ dataDir })
  const pool = new KeylessRouterPool({ stores })

  // Unified route is always exposed by default
  assert.deepEqual(pool.desiredDshRoutes(), [UNIFIED_ROUTE])

  // Enabling per-provider routes exposes `keyless-<id>` routes alongside `keyless-free`
  stores.settings.update({ exposePerProviderRoutes: true })
  const multiRoutes = pool.desiredDshRoutes()
  assert.ok(multiRoutes.includes(UNIFIED_ROUTE))
  assert.ok(multiRoutes.includes('keyless-kilo'))
  assert.ok(multiRoutes.includes('keyless-ovh'))

  // Vision virtual model prioritizes vision-capable entries
  const visionVm = findVirtualModel('auto-vision')
  const visionRanked = pool.rankCandidates({ virtual: visionVm, needsVision: true })
  assert.ok(visionRanked.length > 0)
  assert.equal(visionRanked[0].vision, true)

  // Sticky session remembers healthy choice and puts it #1 on next turn
  const codingVm = findVirtualModel('auto-coding')
  const chosen = visionRanked[0]
  pool.rememberStickyChoice('sess-42', codingVm.id, 'ovh/Qwen3-Coder-30B-A3B-Instruct')
  const stickyRanked = pool.rankCandidates({
    virtual: codingVm,
    sessionId: 'sess-42',
  })
  assert.equal(stickyRanked[0].compositeId, 'ovh/Qwen3-Coder-30B-A3B-Instruct')

  // Recording a 429 failure places that candidate into cooldown and drops it behind healthy peers
  pool.recordFailure({
    compositeId: 'ovh/Qwen3-Coder-30B-A3B-Instruct',
    providerId: 'ovh',
    requestedModel: 'auto-coding',
    error: new KeylessUpstreamError('Rate limit', ERROR_CODES.RATE_LIMIT, {
      status: 429,
      retryAfterMs: 120_000,
    }),
    latencyMs: 55,
    finalTurnFailure: false,
  })
  const after429 = pool.rankCandidates({
    virtual: codingVm,
    sessionId: 'sess-42',
  })
  assert.notEqual(after429[0].compositeId, 'ovh/Qwen3-Coder-30B-A3B-Instruct')
  assert.ok(chosen)

  // Resetting cooldowns restores eligibility immediately
  pool.resetCooldowns('ovh')
  const restored = pool.rankCandidates({
    virtual: codingVm,
    sessionId: 'sess-42',
  })
  assert.equal(restored[0].compositeId, 'ovh/Qwen3-Coder-30B-A3B-Instruct')

  stores.dispose()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('Live discovery, Stillworks shelf sync, and local zero-key scan populate dynamic catalog', async () => {
  const dataDir = makeTempDir()
  const stores = createPluginStores({ dataDir })
  const pool = new KeylessRouterPool({ stores })

  const mockFetch = async (url) => {
    const u = String(url)
    if (u.includes('api.kilo.ai/api/gateway/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'kilo-auto/free',
              name: 'Kilo Auto Free',
              context_length: 200000,
              supported_parameters: ['tools', 'reasoning'],
              pricing: { prompt: '0', completion: '0' },
            },
            {
              id: 'deepseek/deepseek-r1:free',
              name: 'DeepSeek R1 Free',
              context_length: 163840,
              supported_parameters: ['reasoning'],
              pricing: { prompt: '0', completion: '0' },
            },
            {
              id: 'openai/gpt-5-paid',
              pricing: { prompt: '0.00001', completion: '0.00003' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (u.includes('stillworks.supercapybara.com/api/llm/up')) {
      return new Response(
        JSON.stringify([
          {
            provider: 'BrandNewFreeCloud',
            model: 'qwen-3-coder-free',
            endpoint: 'https://api.brandnewfree.example/v1/chat/completions',
            avg_latency_ms: 420,
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (u.includes('127.0.0.1:11434/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'qwen2.5-coder:14b', context_length: 65536 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('offline', { status: 503 })
  }

  const kilo = pool.getProvider('kilo')
  const discoveredKilo = await discoverProviderModels(kilo, { fetchImpl: mockFetch })
  assert.equal(discoveredKilo.ok, true)
  assert.equal(discoveredKilo.models.length, 2)
  assert.ok(discoveredKilo.models.some((m) => m.id === 'deepseek/deepseek-r1:free'))
  assert.ok(!discoveredKilo.models.some((m) => m.id === 'openai/gpt-5-paid'))

  const shelfRes = await syncStillworksLiveShelf(pool, { fetchImpl: mockFetch })
  assert.equal(shelfRes.ok, true)
  assert.equal(shelfRes.newProviders, 1)

  const localRes = await scanLocalZeroKeyServers(pool, { fetchImpl: mockFetch })
  const ollamaStatus = localRes.find((d) => d.id === 'ollama-local')
  assert.equal(ollamaStatus?.online, true)
  assert.equal(ollamaStatus?.models.length, 1)

  const fullCatalog = pool.buildCatalog()
  assert.ok(fullCatalog.some((e) => e.compositeId === 'ollama-local/qwen2.5-coder:14b'))
  assert.ok(fullCatalog.some((e) => e.modelId === 'qwen-3-coder-free'))

  const custom = normalizeCustomProvider({
    id: 'My Lab Server!',
    name: 'Lab vLLM',
    baseUrl: 'http://127.0.0.1:8000/v1/',
    staticModels: ['Qwen/Qwen3-32B'],
  })
  assert.equal(custom?.id, 'my-lab-server')
  assert.equal(custom?.baseUrl, 'http://127.0.0.1:8000/v1')

  assert.equal(VIRTUAL_MODELS.length, 5)
  stores.dispose()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
