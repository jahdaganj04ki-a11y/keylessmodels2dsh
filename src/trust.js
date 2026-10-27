/**
 * HTTP request admission fence for `/api/keylessmodels2dsh/*` routes.
 *
 * WebServer dispatch in DeepSeek Harness is longest-prefix-wins, so plugin routes
 * under `/api/keylessmodels2dsh/*` execute ahead of the kernel's `/api` middleware.
 * We enforce two layers in order:
 *   1. The host composition's `connection` service (`admit(req)` or legacy `requestRejection(req)`),
 *      which validates browser-session cookies and desktop tokens identically to built-in routes.
 *   2. Structural loopback + DNS-rebinding + Cross-Site (`Sec-Fetch-Site`, `Origin`, `Referer`)
 *      validation, permitting `dsh-app://app` Desktop Electron relay requests.
 *
 * @module src/trust.js
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Parse a `Host`, `Origin`, or `Referer` authority into `{ scheme, hostname, port }`.
 *
 * @param {string | undefined} raw
 * @param {string} [defaultScheme]
 */
function parseAuthority(raw, defaultScheme = 'http') {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const trimmed = raw.trim()
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `${defaultScheme}://${trimmed}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return {
      scheme: url.protocol.slice(0, -1),
      hostname: url.hostname.toLowerCase(),
      port,
    }
  } catch {
    return null
  }
}

/**
 * Check if `Referer` is DSH Desktop's custom `dsh-app://app` renderer protocol.
 *
 * @param {string} value
 */
function isDshDesktopProtocolReferer(value) {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'dsh-app:' &&
      url.hostname === 'app' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

/**
 * Check whether an incoming HTTP request is trusted to access plugin management APIs.
 * Returns `undefined` when admitted, or an HTTP rejection status code (`401`/`403`/`503`).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {(() => any) | any} [connectionSource]
 * @returns {number | undefined}
 */
export function admitPluginRequest(req, connectionSource) {
  const connection = typeof connectionSource === 'function' ? connectionSource() : connectionSource
  if (connection !== undefined && connection !== null) {
    try {
      if (typeof connection.admit === 'function') {
        const res = connection.admit(req)
        const status = res && typeof res === 'object' ? res.rejection : undefined
        if (typeof status === 'number') return status
        return undefined
      }
      if (typeof connection.requestRejection === 'function') {
        const status = connection.requestRejection(req)
        if (typeof status === 'number') return status
        return undefined
      }
    } catch {
      return 503
    }
  }

  // Structural fallback fence when `connection` service is not mounted
  const hostAuth = parseAuthority(req.headers?.host, 'http')
  if (!hostAuth || !LOOPBACK_HOSTS.has(hostAuth.hostname)) {
    return 403
  }

  const fetchSite = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (fetchSite === 'cross-site') {
    return 403
  }

  for (const headerName of ['origin', 'referer']) {
    const val = req.headers?.[headerName]
    if (typeof val !== 'string' || val.trim().length === 0) continue
    if (headerName === 'referer' && isDshDesktopProtocolReferer(val.trim())) {
      if (req.headers?.origin !== undefined || req.headers?.['sec-fetch-site'] !== undefined) {
        return 403
      }
      continue
    }
    const auth = parseAuthority(val.trim())
    if (!auth) return 403
    if (
      auth.scheme !== hostAuth.scheme ||
      auth.hostname !== hostAuth.hostname ||
      auth.port !== hostAuth.port
    ) {
      return 403
    }
  }

  return undefined
}
