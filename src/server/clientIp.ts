import type express from 'express'

/**
 * Parse the `TRUST_PROXY` env var into a value Express accepts for
 * `app.set('trust proxy', ...)`.
 *
 * Accepted forms (mirrors Express semantics):
 *  - unset / ''            -> `false`  (SAFE DEFAULT: trust nothing)
 *  - 'true' / 'false'      -> boolean
 *  - a number (e.g. '1')   -> hop count (number of trusted proxies in front)
 *  - 'loopback' / 'linklocal' / 'uniquelocal' -> preset subnet name
 *  - a comma-separated list of IPs/CIDRs -> trusted subnet list
 *
 * SAFE DEFAULT — why `false`:
 *  When trust proxy is OFF, Express ignores the `X-Forwarded-For` header and
 *  `req.ip` is the direct socket peer. An attacker cannot spoof their address
 *  with a forged header to get a fresh rate-limit bucket per request. The cost
 *  is that, behind a reverse proxy, `req.ip` is the proxy's address, so every
 *  client shares one bucket — degrading IP *accuracy* but never *weakening*
 *  the limiter.
 *
 * Behind a reverse proxy, set `TRUST_PROXY` to the number of proxies between
 * the public internet and this process (one nginx in front -> `1`), and make
 * that proxy append the peer address to `X-Forwarded-For`. Never use `true`
 * on an internet-facing instance: it trusts a header any client can set.
 */
export function parseTrustProxy(
  raw: string | undefined,
): boolean | number | string | string[] {
  if (raw === undefined || raw.trim() === '') {
    return false
  }
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && /^\d+$/.test(value)) {
    return asNumber
  }
  if (value.includes(',')) {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  }
  return value
}

/**
 * Return the trustworthy client IP for a request.
 *
 * With `app.set('trust proxy', ...)` configured, Express already resolves
 * `req.ip` to the left-most untrusted address in the `X-Forwarded-For` chain
 * (honouring the configured number of trusted hops). So `req.ip` is the single
 * source of truth — we do NOT re-parse `X-Forwarded-For` by hand, which is what
 * made the old call sites spoofable.
 *
 * Fallbacks (defensive only; `req.ip` is populated for normal Express requests):
 *  1. `req.ip`                    — the canonical, trust-proxy-aware value
 *  2. first entry of XFF          — only when `req.ip` is somehow empty
 *  3. `req.socket.remoteAddress`  — the raw peer address
 */
export function getClientIp(req: express.Request): string | undefined {
  if (req.ip) {
    return req.ip
  }

  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(',')[0]
      ?.trim()
    if (first) {
      return first
    }
  }

  return req.socket?.remoteAddress
}

export default getClientIp
