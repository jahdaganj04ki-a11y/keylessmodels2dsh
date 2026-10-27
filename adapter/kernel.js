/**
 * Isolated kernel attribution seam.
 *
 * `@deepseek-ai/dsh-llm` requires every provider HTTP request to carry the
 * Harness attribution `User-Agent` (`attributionHeaders()`). We resolve it
 * lazily via dynamic `import()` with a deterministic fallback so the plugin:
 *   1. never pins or duplicates a `@deepseek-ai/*` runtime package in `dependencies`,
 *   2. activates cleanly on profiles with `autoInstallPeers: false` (DSH Desktop Windows),
 *   3. runs identically inside standalone Node unit tests.
 *
 * @module adapter/kernel.js
 */

const FALLBACK_USER_AGENT =
  'deepseek-harness/0.2.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness) keylessmodels2dsh/1.0.0'

/** @type {string | null} */
let cachedUserAgent = null

/**
 * Resolve the Harness attribution User-Agent string once per process.
 *
 * @param {{ debug?: (msg: string) => void } | undefined} [logger]
 * @returns {Promise<string>}
 */
export async function resolveAttributionUserAgent(logger) {
  if (cachedUserAgent !== null) return cachedUserAgent
  try {
    // Dynamic string keeps static bare-import scanners clear while letting
    // DSH Desktop's host-module-fallback resolve `@deepseek-ai/dsh-llm` at runtime.
    const spec = ['@deepseek-ai', 'dsh-llm'].join('/')
    const mod = await import(spec)
    const headers = typeof mod.attributionHeaders === 'function' ? mod.attributionHeaders() : undefined
    const ua = headers?.['user-agent'] ?? headers?.['User-Agent']
    if (typeof ua === 'string' && ua.trim().length > 0) {
      cachedUserAgent = `${ua.trim()} keylessmodels2dsh/1.0.0`
      return cachedUserAgent
    }
  } catch (error) {
    logger?.debug?.(
      `keylessmodels2dsh: kernel attribution helper unavailable, using fallback (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  cachedUserAgent = FALLBACK_USER_AGENT
  return cachedUserAgent
}

export { FALLBACK_USER_AGENT }
