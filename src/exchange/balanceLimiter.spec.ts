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

describe('BalanceLimiter (shadow)', () => {
  let redis: ReturnType<typeof memoryRedis>
  let savedGetInstance: unknown
  const limiter = BalanceLimiter.getInstance()

  beforeEach(() => {
    redis = memoryRedis()
    savedGetInstance = (RedisClient as any).getInstance
    ;(RedisClient as any).getInstance = async () => redis
    process.env.BALANCE_LIMITER_PER_MINUTE = '2'
    delete process.env.BALANCE_LIMITER_MODE
  })

  afterEach(() => {
    ;(RedisClient as any).getInstance = savedGetInstance
    delete process.env.BALANCE_LIMITER_PER_MINUTE
  })

  it('merges a read that overlaps one in flight', async () => {
    const first = await limiter.begin('acct', 'bot.checkAssets.dbMiss')
    const second = await limiter.begin('acct', 'bot.checkAssets.dbMiss')
    expect(first.verdict).to.equal('live')
    expect(second.verdict).to.equal('merge')
  })

  it('reuses a recent live answer, until the account places an order', async () => {
    const first = await limiter.begin('acct', 'api.updateBalance')
    first.settle(true)
    await flush()
    expect((await limiter.begin('acct', 'api.updateBalance')).verdict).to.equal(
      'reuse',
    )
    limiter.invalidate('acct')
    await flush()
    expect((await limiter.begin('acct', 'api.updateBalance')).verdict).to.equal(
      'live',
    )
  })

  it('does not open a reuse window from a failed read', async () => {
    const first = await limiter.begin('acct', 'api.updateBalance')
    first.settle(false)
    await flush()
    expect((await limiter.begin('acct', 'api.updateBalance')).verdict).to.equal(
      'live',
    )
  })

  it('holds back reads over the per-minute budget', async () => {
    for (let i = 0; i < 2; i++) {
      const t = await limiter.begin('acct', 'api.updateBalance')
      expect(t.verdict).to.equal('live')
      t.settle(false)
      await flush()
    }
    expect((await limiter.begin('acct', 'api.updateBalance')).verdict).to.equal(
      'budget',
    )
  })

  it('never reuses or budgets a deal-sizing read', async () => {
    for (let i = 0; i < 3; i++) {
      const t = await limiter.begin('acct', 'bot.dealSizing')
      expect(t.verdict).to.equal('live')
      t.settle(true)
      await flush()
    }
  })

  it('keeps accounts independent', async () => {
    await limiter.begin('a', 'x')
    expect((await limiter.begin('b', 'x')).verdict).to.equal('live')
  })

  it('records nothing when switched off', async () => {
    process.env.BALANCE_LIMITER_MODE = 'off'
    expect((await limiter.begin('acct', 'x')).verdict).to.equal('')
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
