/**
 * Spec 096 — the credential rate limiter must key on an address the caller
 * cannot choose.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * Drives a real Express app over a real socket with the same limiter shape the
 * server mounts (`express-rate-limit` + `ipKeyGenerator(getClientIp(req))`),
 * so `trust proxy` resolution is Express's own, not a re-implementation.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import express from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { expect } from 'chai'
import { getClientIp, parseTrustProxy } from './clientIp'

const MAX = 10
const ATTEMPTS = 30

async function withApp(
  trustProxy: string | undefined,
  run: (port: number, seen: string[]) => Promise<void>,
) {
  const seen: string[] = []
  const app = express()
  app.set('trust proxy', parseTrustProxy(trustProxy))
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: MAX,
      standardHeaders: false,
      legacyHeaders: true,
      keyGenerator: (req) =>
        ipKeyGenerator(getClientIp(req as express.Request) || 'unknown'),
    }),
  )
  app.post('/', (req, res) => {
    seen.push(getClientIp(req) ?? '')
    res.json({ ok: true })
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    await run((server.address() as AddressInfo).port, seen)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

function post(port: number, xff?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: xff ? { 'x-forwarded-for': xff } : {},
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function allowed(port: number, xffFor: (i: number) => string) {
  let ok = 0
  for (let i = 0; i < ATTEMPTS; i++) {
    if ((await post(port, xffFor(i))) !== 429) ok++
  }
  return ok
}

describe('096 client IP for rate limiting', () => {
  describe('§1 TRUST_PROXY unset (direct exposure)', () => {
    it('§1.1 a rotating X-Forwarded-For does not buy a fresh bucket', async () => {
      await withApp(undefined, async (port, seen) => {
        expect(await allowed(port, (i) => `10.9.0.${i + 1}`)).to.equal(MAX)
        expect(new Set(seen)).to.deep.equal(new Set(['127.0.0.1']))
      })
    })
  })

  describe('§2 TRUST_PROXY=1 (one reverse proxy appending the peer)', () => {
    it('§2.1 a spoofed leftmost entry is ignored; the proxy-appended one is used', async () => {
      await withApp('1', async (port, seen) => {
        // nginx `$proxy_add_x_forwarded_for` appends the real peer to
        // whatever the client sent, so only the rightmost entry is trusted.
        expect(
          await allowed(port, (i) => `10.9.0.${i + 1}, 203.0.113.7`),
        ).to.equal(MAX)
        expect(new Set(seen)).to.deep.equal(new Set(['203.0.113.7']))
      })
    })

    it('§2.2 distinct real clients still get their own buckets', async () => {
      await withApp('1', async (port) => {
        expect(await allowed(port, (i) => `203.0.113.${i + 1}`)).to.equal(
          ATTEMPTS,
        )
      })
    })
  })

  describe('§3 parseTrustProxy', () => {
    it('§3.1 defaults to trusting nothing', () => {
      expect(parseTrustProxy(undefined)).to.equal(false)
      expect(parseTrustProxy('  ')).to.equal(false)
    })
    it('§3.2 accepts hop counts, booleans, presets and lists', () => {
      expect(parseTrustProxy('2')).to.equal(2)
      expect(parseTrustProxy('true')).to.equal(true)
      expect(parseTrustProxy('loopback')).to.equal('loopback')
      expect(parseTrustProxy('10.0.0.1, 10.0.0.0/8')).to.deep.equal([
        '10.0.0.1',
        '10.0.0.0/8',
      ])
    })
  })
})
