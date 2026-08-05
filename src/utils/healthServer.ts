import * as http from 'http'
import logger from './logger'

const DEFAULT_HEALTH_PORT = 3000

/**
 * A dependency probe. Resolve = healthy. Throw or resolve a string = unhealthy,
 * and the string (or error message) is reported as the reason.
 *
 * Keep every probe CHEAP and READ-ONLY — `db.admin().ping()`, `redis.ping()`,
 * a cached counter. A probe that runs a real query turns the health endpoint
 * into a load source, and a probe that writes turns a monitoring poll into a
 * mutation.
 */
export type HealthCheck = () => Promise<void | string> | void | string

export interface HealthResponse {
  status: 'ok' | 'degraded'
  /** True only when every registered dependency passed. */
  ok: boolean
  uptime: number
  timestamp: number
  service?: string
  /** name → 'ok' or a short failure reason. Absent when nothing is registered. */
  deps?: Record<string, string>
}

/**
 * WHY THIS FILE ASSERTS DEPENDENCIES AND NOT JUST `process.uptime()`.
 *
 * The original version answered 200 with the process uptime and nothing else.
 * That proves the event loop is turning — which is exactly the state a wedged
 * service is in. A service whose datastore has gone away keeps a perfectly
 * healthy event loop while serving nothing, and an uptime-shaped check reports
 * it green throughout.
 *
 * So a health check here means "this service can still do its job", which for
 * every service on this platform means its datastores answer. A check that
 * cannot fail is not a check.
 *
 * Registration is ADDITIVE and OPTIONAL: a caller that registers nothing gets
 * the old liveness-only behaviour and the old response shape plus `ok:true`.
 * That matters because this file lives in `core/`, which every service embeds.
 */
const checks = new Map<string, HealthCheck>()

/** How long a single probe may take before it counts as failed. */
const CHECK_TIMEOUT_MS = 3000
/**
 * Results are cached for this long. The poller runs every couple of minutes,
 * but nothing stops a load balancer, an operator with curl, or a retry storm
 * from hammering the endpoint — and each hit would otherwise be a fresh round
 * of pings to Mongo and Redis. The cache makes the cost of being probed
 * independent of how often you are probed.
 */
const CACHE_MS = 5000

let cached: { at: number; body: HealthResponse } | null = null

/**
 * Register a dependency probe under `name`. Idempotent per name — re-registering
 * replaces, so a module that boots twice does not double-probe.
 */
export function registerHealthCheck(name: string, check: HealthCheck): void {
  checks.set(name, check)
}

function withTimeout(check: HealthCheck): Promise<string> {
  return new Promise<string>((resolve) => {
    const timer = setTimeout(
      () => resolve(`timeout after ${CHECK_TIMEOUT_MS}ms`),
      CHECK_TIMEOUT_MS,
    )
    const settle = (reason: string) => {
      clearTimeout(timer)
      resolve(reason)
    }
    try {
      const out = check()
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        ;(out as Promise<void | string>).then(
          (r) => settle(typeof r === 'string' && r ? r : 'ok'),
          (e) => settle(String(e?.message ?? e).slice(0, 200)),
        )
      } else {
        settle(typeof out === 'string' && out ? out : 'ok')
      }
    } catch (e) {
      settle(String((e as Error)?.message ?? e).slice(0, 200))
    }
  }).catch(() => 'check threw')
}

/**
 * Run every registered probe (in parallel, each independently timed out) and
 * build the response. Cached for CACHE_MS.
 */
export async function runHealthChecks(
  service?: string,
): Promise<HealthResponse> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_MS) return cached.body

  const names = [...checks.keys()]
  const results = await Promise.all(
    names.map((n) => withTimeout(checks.get(n)!)),
  )

  const deps: Record<string, string> = {}
  let ok = true
  names.forEach((n, i) => {
    deps[n] = results[i]
    if (results[i] !== 'ok') ok = false
  })

  const body: HealthResponse = {
    status: ok ? 'ok' : 'degraded',
    ok,
    uptime: process.uptime(),
    timestamp: Date.now(),
    ...(service ? { service } : {}),
    ...(names.length ? { deps } : {}),
  }
  cached = { at: now, body }
  return body
}

export class HealthServer {
  private server: http.Server | null = null
  private service?: string

  constructor(service?: string) {
    this.service = service
  }

  start(port: number = DEFAULT_HEALTH_PORT): void {
    try {
      this.server = http.createServer(this.handleRequest.bind(this))

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Health server port ${port} is in use - skipping`)
          return
        }
        logger.error(`Health server error: ${err.message}`)
      })

      this.server.listen(port, () => {
        logger.info(`Health server listening on port ${port}`)
      })
    } catch (error) {
      logger.error(`Failed to start health server: ${error}`)
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close(() => {
        logger.info('Health server stopped')
      })
      this.server = null
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.url === '/health' && req.method === 'GET') {
      const body = await runHealthChecks(this.service)
      // 503 on a failed dependency is the whole point: the poller, a load
      // balancer and a human with curl all read the status code, and only the
      // poller reads the body.
      res.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not Found' }))
    }
  }
}

/**
 * Mount `/health` on an existing express app. Same semantics as HealthServer:
 * 200 when every registered dependency passes, 503 otherwise.
 */
export const addHealthEndpoint = (app: any, service?: string) => {
  app.get('/health', async (_req: any, res: any) => {
    const body = await runHealthChecks(service)
    res.status(body.ok ? 200 : 503).json(body)
  })
}

export default HealthServer
