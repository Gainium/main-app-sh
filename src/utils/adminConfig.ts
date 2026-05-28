import RedisClient from '../db/redis'
import logger from './logger'

// Self-hosted admin-config sync. Gated entirely by ADMIN_CONFIG_ENABLED:
// in cloud builds (flag absent) every export is a hard no-op — no Redis
// subscription, no timers, no log lines. Cloud behavior is byte-identical
// to today.
//
// Mirrors exchange-connector-sh/src/utils/adminConfig.ts and websocket-
// connector-sh/src/utils/adminConfig.ts (same Redis contract, same flag).
// Differences here are purely about reusing app-sh's existing
// RedisWrapper instead of bringing in a second client.

const ENABLED =
  process.env.ADMIN_CONFIG_ENABLED === 'true' ||
  process.env.ADMIN_CONFIG_ENABLED === '1'

const KEY = 'gainium:admin:enabled_exchanges'
const CHANNEL = 'gainium:admin:config'
const REFRESH_MS = Number(process.env.ADMIN_CONFIG_REFRESH_MS ?? '10000')

let cache: Set<string> | null = null
let initialized = false
let started = false

export function isAdminConfigEnabled(): boolean {
  return ENABLED
}

/**
 * Synchronous check used inside resolvers. Always returns true in
 * cloud builds AND before the first refresh completes so we don't
 * reject in-flight mutations during boot.
 */
export function isExchangeEnabled(exchange: string): boolean {
  if (!ENABLED) return true
  if (!initialized || cache === null) return true
  return cache.has(exchange)
}

function parseRaw(raw: string | null | undefined): Set<string> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return null
  }
}

function setEquals(a: Set<string> | null, b: Set<string> | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/**
 * One-shot bootstrap. Idempotent: calling twice is a no-op. Reads the
 * current key, subscribes to pubsub on `gainium:admin:config`, and
 * starts a 10s periodic refresh as a safety net for dropped messages.
 *
 * Failures are logged but never thrown — server bootstrap shouldn't
 * abort if Redis hasn't come up yet. `isExchangeEnabled` keeps
 * returning `true` (open) until the first successful read.
 */
export async function startAdminConfigSync(): Promise<void> {
  if (!ENABLED || started) return
  started = true

  const refresh = async () => {
    try {
      const redis = await RedisClient.getInstance()
      const raw = (await redis.get(KEY)) ?? null
      const next = parseRaw(raw as string | null)
      const prev = cache
      cache = next
      initialized = true
      if (!setEquals(prev, next)) {
        logger.info(
          `admin-config changed: ${
            next ? Array.from(next).sort().join(',') : '(all)'
          }`,
        )
      }
    } catch (err) {
      logger.warn(`admin-config refresh failed: ${err}`)
    }
  }

  await refresh()

  // Pubsub — uses a dedicated subscriber client per app-sh's existing
  // pattern (RedisWrapper.subscribe accepts a callback).
  try {
    const sub = await RedisClient.getInstance(true, 'admin-config')
    await sub.subscribe(CHANNEL, () => {
      void refresh()
    })
  } catch (err) {
    logger.warn(`admin-config subscribe failed: ${err}`)
  }

  // Safety net for dropped pubsub messages (Redis restart, transient
  // network drop). Idempotent — only logs when the set actually changed.
  setInterval(() => {
    void refresh()
  }, REFRESH_MS).unref()
}
