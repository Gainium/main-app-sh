/**
 * Review (spec 044 phase 3, pass 2): the lock's Lua scripts against a REAL
 * Redis. Skipped unless `REVIEW_REAL_REDIS=1` (needs REDIS_* env).
 * Run: `REVIEW_REAL_REDIS=1 NODE_ENV=development npx mocha -r ts-node/register src/bot/fundingLock.realRedis.spec.ts`
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import RedisClient from '../db/redis'
import { FundingLock } from './fundingLock'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const d = process.env.REVIEW_REAL_REDIS === '1' ? describe : describe.skip

d('FundingLock against a real Redis (review pass 2)', function () {
  this.timeout(20000)
  it('setNxPx / pexpireIfValue / delIfValue honour the token', async () => {
    const r: any = await RedisClient.getInstance()
    const k = `review:fundingLock:${Date.now()}`
    expect(await r.setNxPx(k, 'a', 300)).to.equal(true)
    expect(await r.setNxPx(k, 'b', 300)).to.equal(false)
    expect(await r.pexpireIfValue(k, 'b', 1000)).to.equal(false)
    expect(await r.pexpireIfValue(k, 'a', 1000)).to.equal(true)
    await sleep(500)
    expect(await r.setNxPx(k, 'c', 300)).to.equal(false)
    expect(await r.delIfValue(k, 'b')).to.equal(false)
    expect(await r.delIfValue(k, 'a')).to.equal(true)
    expect(await r.pexpireIfValue(k, 'a', 1000)).to.equal(false)
  })
  it('the heartbeat keeps a section exclusive past the TTL', async () => {
    const lock = new FundingLock()
    lock.ttlMs = 300
    lock.waitMs = 10000
    let inside = 0
    let max = 0
    const sec = async () => {
      inside++
      max = Math.max(max, inside)
      await sleep(900)
      inside--
    }
    const acc = `review-${Date.now()}`
    const res = await Promise.all([lock.run(acc, sec, 'x'), lock.run(acc, sec, 'y')])
    expect(max).to.equal(1)
    expect(res.every((x) => x.acquired)).to.equal(true)
  })
})
