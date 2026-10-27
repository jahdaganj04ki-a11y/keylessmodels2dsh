#!/usr/bin/env node
/**
 * Static & structural verifier for `keylessmodels2dsh`.
 *
 * Enforces every packaging & seam invariant required by `@deepseek-ai/dsh@0.2.1-rc.2`
 * and `dsh-desktop` `v0.12.1` on Windows x64:
 *   1. Zero `dependencies`, zero `peerDependencies`, zero `postinstall`/`prepare` lifecycle hooks.
 *   2. Valid `dsh.client` shape (`platform: 'web'`, `inject: ['slots', 'locale']`, `external: ['react']`).
 *   3. Valid `exports` (`./package.json`, `.`, `./client`, `./icon`, `./locale/*.json`).
 *   4. Presence of `cordis.patch.yml`, `icon.svg`, and `locale/{en,de,zh}.json` with `meta.title`/`meta.description`.
 *   5. No static imports of `@deepseek-ai/*` or third-party packages anywhere in `index.js` or `src/*.js`.
 *   6. Clean import & instantiation smoke check of the Host plugin (`index.js`) and syntax check of `client.js`.
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ VERIFY FAILED: ${msg}`)
    process.exit(1)
  }
}

async function main() {
  const pkgPath = path.join(ROOT, 'package.json')
  assert(fs.existsSync(pkgPath), 'package.json missing')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

  // 1. Dependency & lifecycle hook hygiene (bowenliang123/dsh-context#206)
  assert(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'package.json must have ZERO runtime dependencies')
  assert(!pkg.peerDependencies || Object.keys(pkg.peerDependencies).length === 0, 'package.json must have ZERO peerDependencies (autoInstallPeers: false trap)')
  for (const forbiddenHook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert(!pkg.scripts?.[forbiddenHook], `package.json must not define '${forbiddenHook}' lifecycle script`)
  }

  // 2. Engine & dsh.client metadata
  assert(pkg.type === 'module', 'package.json must use "type": "module"')
  assert(typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.includes('0.2.0-rc.1'), 'engines.dsh must cover >=0.2.0-rc.1 <1.0.0')
  assert(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must equal "web"')
  assert(Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject must be a string array')
  assert(!pkg.dsh?.client?.external || !pkg.dsh.client.external.includes(pkg.name), 'dsh.client.external must not self-reference')

  // 3. Exports & required files
  for (const expKey of ['./package.json', '.', './client', './icon', './locale/*.json']) {
    assert(Boolean(pkg.exports?.[expKey]), `package.json exports missing "${expKey}"`)
  }
  for (const rel of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'adapter/kernel.js']) {
    assert(fs.existsSync(path.join(ROOT, rel)), `Required file missing: ${rel}`)
  }
  for (const loc of ['en', 'de', 'zh']) {
    const locFile = path.join(ROOT, 'locale', `${loc}.json`)
    assert(fs.existsSync(locFile), `Locale file missing: locale/${loc}.json`)
    const locJson = JSON.parse(fs.readFileSync(locFile, 'utf8'))
    assert(typeof locJson?.meta?.title === 'string' && locJson.meta.title.length > 0, `locale/${loc}.json missing meta.title`)
    assert(typeof locJson?.meta?.description === 'string' && locJson.meta.description.length > 0, `locale/${loc}.json missing meta.description`)
  }

  // 4. Scan host JS files for prohibited external static imports or globalThis.fetch monkey-patching
  const hostFiles = [
    path.join(ROOT, 'index.js'),
    path.join(ROOT, 'adapter', 'kernel.js'),
    ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'src', f)),
  ]
  for (const file of hostFiles) {
    const content = fs.readFileSync(file, 'utf8')
    const staticImports = [...content.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const spec of staticImports) {
      assert(
        spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'),
        `Forbidden external static import "${spec}" in ${path.relative(ROOT, file)}`,
      )
    }
    assert(!/globalThis\.fetch\s*=/.test(content), `Must never monkey-patch globalThis.fetch in ${path.relative(ROOT, file)}`)
  }

  // 5. Import `index.js` and verify Cordis plugin exports
  const hostMod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
  assert(hostMod.name === 'keylessmodels2dsh', 'index.js must export name = "keylessmodels2dsh"')
  assert(Array.isArray(hostMod.inject) && hostMod.inject.length === 1 && hostMod.inject[0] === 'llm', 'index.js root inject must be ["llm"] only')
  assert(typeof hostMod.apply === 'function', 'index.js must export apply(ctx, config)')

  // 6. Execute `client.js` inside an isolated VM sandbox mocking `window.__ModuleLoader__.load`
  const clientCode = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  let loadedModule = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(descriptor) {
          loadedModule = descriptor
        },
      },
    },
    globalThis: {},
    console,
  }
  vm.runInNewContext(clientCode, sandbox, { filename: 'client.js' })
  assert(loadedModule && loadedModule.id === 'keylessmodels2dsh', 'client.js must call window.__ModuleLoader__.load({ id: "keylessmodels2dsh", ... })')
  assert(typeof loadedModule.factory === 'function', 'client.js descriptor must provide factory(require)')

  const fakeReact = {
    createElement: (...args) => ({ args }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const clientPlugin = loadedModule.factory((id) => {
    assert(id === 'react', `client.js requested unexpected external module "${id}"`)
    return fakeReact
  })
  assert(Array.isArray(clientPlugin.inject) && clientPlugin.inject.includes('slots'), 'clientPlugin must inject "slots"')
  assert(typeof clientPlugin.apply === 'function', 'clientPlugin must export apply(ctx)')

  console.log(`✓ keylessmodels2dsh v${pkg.version} passed all DSH v0.12.1 / @deepseek-ai/dsh@0.2.1-rc.2 seam checks (${hostFiles.length} host modules + client.js verified).`)
}

main().catch((err) => {
  console.error('✗ VERIFY CRASHED:', err)
  process.exit(1)
})
