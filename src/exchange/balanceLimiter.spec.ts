process.env.NODE_ENV = 'testing'

/**
 * Balance limiter shadow verdicts and caller tagging.
 * Run: `npm test` (mocha).
 *
 * Driven against an in-memory stand-in for the Redis wrapper so the verdict
 * order (merge → reuse → budget → live) and the exemptions can be checked
 * without a server.
 */
import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import RedisClient from '../db/redis'
import BalanceLimiter from './balanceLimiter'
import { StatusEnum } from '../../types'
import {
  accountRefFor,
  currentExchangeCaller,
  withExchangeCaller,
} from './requestContext'

const flush = () => new Promise((r) => setTimeout(r, 5))

const memoryRedis = () => {
  const kv = new Map<string, string>()
  return {
    kv,
    async setNx(key: string, value: string) {
      if (kv.has(key)) return false
      kv.set(key, value)
      return true
    },
    async set(key: string, value: string) {
      kv.set(key, value)
    },
    async get(key: string) {
      return kv.get(key)
    },
    async del(key: string) {
      kv.delete(key)
    },
    async incr(key: string) {
      const n = Number(kv.get(key) ?? 0) + 1
      kv.set(key, `${n}`)
      return n
    },
    async expire() {
      return
    },
  }
}

describe('BalanceLimiter', () => {
  let redis: ReturnType<typeof memoryRedis>
  let savedGetInstance: unknown
  const limiter = BalanceLimiter.getInstance()
  let calls = 0
  const ok = (v = 1) => ({
    data: {
      status: StatusEnum.ok,
      reason: null,
      data: [{ asset: 'USDT', free: v, locked: 0 }],
    } as any,
  })
  const live =
    (v = 1, delay = 0) =>
    async () => {
      calls++
      if (delay) await new Promise((r) => setTimeout(r, delay))
      return ok(v)
    }

  beforeEach(() => {
    redis = memoryRedis()
    calls = 0
    savedGetInstance = (RedisClient as any).getInstance
    ;(RedisClient as any).getInstance = async () => redis
    process.env.BALANCE_LIMITER_PER_MINUTE = '2'
    delete process.env.BALANCE_LIMITER_MODE
  })

  afterEach(() => {
    ;(RedisClient as any).getInstance = savedGetInstance
    delete process.env.BALANCE_LIMITER_PER_MINUTE
    delete process.env.BALANCE_LIMITER_MODE
  })

  it('serves a bot balance check from a recent answer instead of the venue', async () => {
    const first = await limiter.read('acct', 'bot.checkAssets.direct', live(5))
    expect(first.served).to.equal(false)
    await flush()
    const second = await limiter.read('acct', 'bot.checkAssets.direct', live(9))
    expect(second.served).to.equal(true)
    expect(second.verdict).to.equal('reuse')
    expect((second as any).data.data[0].free).to.equal(5)
    expect(calls).to.equal(1)
  })

  it('merges concurrent bot balance checks into one venue call', async () => {
    const [a, b, c] = await Promise.all([
      limiter.read('acct', 'bot.checkAssets.direct', live(1, 20)),
      limiter.read('acct', 'bot.checkAssets.direct', live(1, 20)),
      limiter.read('acct', 'bot.checkAssets.dbMiss', live(1, 20)),
    ])
    expect(calls).to.equal(1)
    expect([a, b, c].filter((o) => o.served).length).to.equal(2)
  })

  it('reads live again once the account places or cancels an order', async () => {
    await limiter.read('acct', 'bot.checkAssets.direct', live(5))
    await flush()
    limiter.invalidate('acct')
    await flush()
    const after = await limiter.read('acct', 'bot.checkAssets.direct', live(7))
    expect(after.served).to.equal(false)
    expect(calls).to.equal(2)
  })

  it('does not store an answer that an order overtook', async () => {
    const pending = limiter.read('acct', 'bot.checkAssets.direct', live(5, 30))
    await flush()
    limiter.invalidate('acct')
    await pending
    await flush()
    const next = await limiter.read('acct', 'bot.checkAssets.direct', live(7))
    expect(next.served).to.equal(false)
  })

  it('never serves deal sizing or non-bot callers from a stored answer', async () => {
    await limiter.read('acct', 'bot.checkAssets.direct', live(5))
    await flush()
    for (const caller of [
      'bot.dealSizing',
      'bot.balanceStart',
      'api.updateBalance',
    ]) {
      const o = await limiter.read('acct', caller, live(6))
      expect(o.served, caller).to.equal(false)
    }
    expect(calls).to.equal(4)
  })

  it('records the verdict without enforcing it in log mode', async () => {
    process.env.BALANCE_LIMITER_MODE = 'log'
    await limiter.read('acct', 'bot.checkAssets.direct', live(5))
    await flush()
    const o = await limiter.read('acct', 'bot.checkAssets.direct', live(6))
    expect(o.served).to.equal(false)
    expect(o.verdict).to.equal('reuse')
  })

  it('does not store a failed read', async () => {
    await limiter.read('acct', 'bot.checkAssets.direct', async () => {
      calls++
      return {
        data: { status: StatusEnum.notok, reason: 'x', data: null } as any,
      }
    })
    await flush()
    const o = await limiter.read('acct', 'bot.checkAssets.direct', live(6))
    expect(o.served).to.equal(false)
  })

  it('records the per-minute budget verdict but still reads', async () => {
    for (let i = 0; i < 2; i++) {
      await limiter.read('acct', 'api.updateBalance', live())
      await flush()
      limiter.invalidate('acct')
      await flush()
    }
    const o = await limiter.read('acct', 'api.updateBalance', live())
    expect(o.served).to.equal(false)
    expect(o.verdict).to.equal('budget')
  })

  it('keeps accounts independent', async () => {
    await limiter.read('a', 'bot.checkAssets.direct', live())
    await flush()
    const o = await limiter.read('b', 'bot.checkAssets.direct', live())
    expect(o.served).to.equal(false)
  })

  it('does nothing when switched off', async () => {
    process.env.BALANCE_LIMITER_MODE = 'off'
    const o = await limiter.read('acct', 'bot.checkAssets.direct', live())
    expect(o.verdict).to.equal('')
    expect(redis.kv.size).to.equal(0)
  })
})

describe('exchange request context', () => {
  it('lets the outermost caller tag win across awaits', async () => {
    const seen = await withExchangeCaller('bot.dealSizing', async () => {
      await flush()
      return withExchangeCaller('bot.balancesFromExchange', async () => {
        await flush()
        return currentExchangeCaller()
      })
    })
    expect(seen).to.equal('bot.dealSizing')
    expect(currentExchangeCaller()).to.equal('')
  })

  it('fingerprints the stored key stably and without exposing it', () => {
    const ref = accountRefFor('stored-key-value')
    expect(ref).to.have.length(16)
    expect(ref).to.equal(accountRefFor('stored-key-value'))
    expect(ref).to.not.equal(accountRefFor('another-key'))
    expect(accountRefFor(undefined)).to.equal('')
  })
})
