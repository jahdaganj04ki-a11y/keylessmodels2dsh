import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { admitPluginRequest } from '../src/trust.js'
import * as hostPlugin from '../index.js'

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'km2dsh-api-'))
}

test('admitPluginRequest enforces loopback, blocks cross-site/DNS-rebinding, and allows dsh-app://app', () => {
  // Valid loopback same-origin request
  assert.equal(
    admitPluginRequest({
      headers: {
        host: '127.0.0.1:43129',
        origin: 'http://127.0.0.1:43129',
        'sec-fetch-site': 'same-origin',
      },
    }),
    undefined,
  )

  // Valid DSH Desktop Electron custom protocol request (`dsh-app://app`)
  assert.equal(
    admitPluginRequest({
      headers: {
        host: '127.0.0.1:43129',
        referer: 'dsh-app://app/index.html',
      },
    }),
    undefined,
  )

  // DNS rebinding attempt (`evil.example.com` host) -> 403
  assert.equal(
    admitPluginRequest({
      headers: {
        host: 'evil.example.com:43129',
      },
    }),
    403,
  )

  // Cross-site browser CSRF attempt -> 403
  assert.equal(
    admitPluginRequest({
      headers: {
        host: '127.0.0.1:43129',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    }),
    403,
  )

  // Host `connection.admit(req)` rejection takes precedence -> 401
  assert.equal(
    admitPluginRequest(
      { headers: { host: '127.0.0.1:43129' } },
      { admit: () => ({ rejection: 401 }) },
    ),
    401,
  )
})

test('Management HTTP API + optional local OpenAI proxy work end-to-end', async () => {
  const dataDir = makeTempDir()
  const routes = new Map()
  let currentDshRoutes = []

  const mockWebServer = {
    register(entry) {
      routes.set(entry.path, entry.handler)
      return () => routes.delete(entry.path)
    },
  }

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1')
    const handler = routes.get(urlObj.pathname)
    if (!handler) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    handler(req, res)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const apiPort = server.address().port
  const apiBase = `http://127.0.0.1:${apiPort}/api/keylessmodels2dsh`

  const mockFetch = async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Pong OK"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  const fakeCtx = {
    llm: {
      registerAdapter(initial, _adapter) {
        currentDshRoutes = [...initial]
        const fn = () => {}
        fn.replace = (next) => {
          currentDshRoutes = [...next]
        }
        return fn
      },
    },
    webServer: mockWebServer,
    inject(_deps, cb) {
      cb({ webServer: mockWebServer })
    },
  }

  const disposePlugin = hostPlugin.apply(fakeCtx, {
    dataDir,
    disableAutoBootNetwork: true,
    fetchImpl: mockFetch,
  })

  try {
    // 1. GET /state
    const stateRes = await fetch(`${apiBase}/state`)
    assert.equal(stateRes.status, 200)
    const stateJson = await stateRes.json()
    assert.equal(stateJson.version, '1.0.0')
    assert.ok(Array.isArray(stateJson.providers) && stateJson.providers.length >= 16)
    assert.ok(Array.isArray(stateJson.rejectedClaims) && stateJson.rejectedClaims.length >= 5)

    // 2. Toggle per-provider routes + enable local OpenAI proxy on an ephemeral port
    // Find a free port first
    const probeSrv = http.createServer()
    await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r))
    const freeProxyPort = probeSrv.address().port
    await new Promise((r) => probeSrv.close(r))

    const settingsRes = await fetch(`${apiBase}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exposePerProviderRoutes: true,
        localProxyEnabled: true,
        localProxyPort: freeProxyPort,
        localProxyKey: 'sk-test-local',
      }),
    })
    assert.equal(settingsRes.status, 200)
    const settingsJson = await settingsRes.json()
    assert.equal(settingsJson.ok, true)
    assert.ok(currentDshRoutes.includes('keyless-kilo'))
    assert.equal(settingsJson.state.proxy.running, true)

    // 3. Test local OpenAI proxy: 401 without key, 200 with key on /v1/models and /v1/chat/completions
    const unauthProxy = await fetch(`http://127.0.0.1:${freeProxyPort}/v1/models`)
    assert.equal(unauthProxy.status, 401)

    const modelsProxy = await fetch(`http://127.0.0.1:${freeProxyPort}/v1/models`, {
      headers: { Authorization: 'Bearer sk-test-local' },
    })
    assert.equal(modelsProxy.status, 200)
    const modelsData = await modelsProxy.json()
    assert.ok(modelsData.data.some((m) => m.id === 'auto'))

    const chatProxy = await fetch(`http://127.0.0.1:${freeProxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-test-local',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'Ping' }],
      }),
    })
    assert.equal(chatProxy.status, 200)
    const chatData = await chatProxy.json()
    assert.equal(chatData.choices[0].message.content, 'Pong OK')

    // 4. POST /probe for a single concrete model
    const probeRes = await fetch(`${apiBase}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compositeId: 'kilo/kilo-auto/free' }),
    })
    const probeJson = await probeRes.json()
    assert.equal(probeJson.ok, true)
  } finally {
    disposePlugin()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
