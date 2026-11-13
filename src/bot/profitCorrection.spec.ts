process.env.NODE_ENV = 'testing'

/**
 * Core spec 239 — an out-of-band correction to a running DCA bot's profit
 * aggregate.
 *
 * Drives the REAL `dcaHelper.applyProfitCorrection` over a minimal base class
 * and checks: the delta lands in the worker's in-memory profit (the copy every
 * later booking `$set`s whole), it is persisted to the database and to the
 * Redis snapshot a service restart restores, the snapshot survives the
 * restore path, and a repeat of the same correction id is a no-op.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import {
  addProfitCorrection,
  invalidProfitCorrection,
} from './profitCorrection'
import { convertDCABot, convertDCABotToObject } from './utils'
import { poisonedSnapshotProfitField } from './redisSnapshotGuard'

const BOT_ID = '000000000000000000000239'
const DELTA = { total: 1.5, totalUsd: 1.25, pureBase: -2, pureQuote: 0.75 }

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  botType = 'dca'
  loadingComplete = true
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let DcaHelper: any

const emptyMulti = () => ({ base: new Map(), quote: new Map() })

const botData = (
  profit = { total: 10, totalUsd: 9, pureBase: 4, pureQuote: 3 },
) => ({
  _id: BOT_ID,
  status: 'open',
  profit: { freeTotal: 0, freeTotalUsd: 0, ...profit },
  currentBalances: emptyMulti(),
  initialBalances: emptyMulti(),
  assets: { used: emptyMulti(), required: emptyMulti() },
  symbol: new Map(),
  lastPrice: new Map(),
  lastUsdRate: new Map(),
  settings: { pair: ['ALT_USDT'] },
})

const buildBot = (data: any = botData()) => {
  const writes: any[] = []
  const redis = new Map<string, string>()
  const emitted: any[] = []
  class TestBot extends DcaHelper {
    data: any = data
    writes = writes
    redis = redis
    emitted = emitted
    async updateData(d: any) {
      // What the real updateData does: `$set` the given fields.
      writes.push(JSON.parse(JSON.stringify(d)))
    }
    async setToRedis(key: string, d: any) {
      redis.set(key, JSON.stringify(d))
    }
    emit(event: string, payload: any) {
      emitted.push([event, JSON.parse(JSON.stringify(payload))])
    }
    handleLog(m: string) {
      return m
    }
    handleWarn(m: string) {
      return m
    }
    handleDebug(m: string) {
      return m
    }
  }
  return new TestBot() as any
}

describe('spec 239 — profit correction on a running DCA bot', () => {
  before(function () {
    this.timeout(180000)
    DcaHelper = loadModule('./dcaHelper').default(FakeBase as any)
  })

  it('§2.1 pure: adds every field and keeps the rest', () => {
    const out = addProfitCorrection(
      { total: 1, totalUsd: 2, freeTotal: 7, freeTotalUsd: 8 },
      DELTA,
    )
    expect(out).to.deep.equal({
      total: 2.5,
      totalUsd: 3.25,
      freeTotal: 7,
      freeTotalUsd: 8,
      pureBase: -2,
      pureQuote: 0.75,
    })
  })

  it('§2.4 pure: refuses a non-finite delta or a missing id', () => {
    expect(invalidProfitCorrection(DELTA, 'c1')).to.equal(null)
    expect(invalidProfitCorrection({ ...DELTA, totalUsd: NaN }, 'c1')).to.match(
      /totalUsd/,
    )
    expect(invalidProfitCorrection({ total: 1 }, 'c1')).to.match(/totalUsd/)
    expect(invalidProfitCorrection(DELTA, '')).to.match(/id/)
    expect(invalidProfitCorrection(DELTA, 'x'.repeat(65))).to.match(/id/)
  })

  it('§2.1 adds the delta to the worker profit and persists it with the id', async () => {
    const bot = buildBot()
    expect(await bot.applyProfitCorrection(DELTA, 'test', 'c1')).to.equal(
      'applied',
    )
    expect(bot.data.profit).to.include({
      total: 11.5,
      totalUsd: 10.25,
      pureBase: 2,
      pureQuote: 3.75,
    })
    expect(bot.writes).to.have.length(1)
    expect(bot.writes[0].profit.total).to.equal(11.5)
    expect(bot.writes[0].profitCorrections).to.deep.equal(['c1'])
    expect(bot.emitted[0][0]).to.equal('bot settings update')
    expect(bot.emitted[0][1].profit.total).to.equal(11.5)
  })

  it('§2.2 the next booking $sets the corrected profit, not the old one', async () => {
    const bot = buildBot()
    await bot.applyProfitCorrection(DELTA, 'test', 'c1')
    // closeDeal's own booking shape (dcaHelper closeDeal).
    bot.data.profit.total += 2
    await bot.updateData({ profit: bot.data.profit })
    expect(bot.writes.at(-1).profit.total).to.equal(13.5)
  })

  it('§2.2 the Redis snapshot is written now and survives the restore path', async () => {
    const bot = buildBot()
    await bot.applyProfitCorrection(DELTA, 'test', 'c1')
    const raw = bot.redis.get('botData')
    expect(raw, 'snapshot written').to.be.a('string')
    // What loadData() does on a service restart: parse the snapshot, check
    // it is not poisoned, then convertDCABot it.
    const snap = JSON.parse(raw)
    expect(poisonedSnapshotProfitField(snap)).to.equal(null)
    const restored: any = convertDCABot(snap)
    expect(restored.profit.total).to.equal(11.5)
    expect(restored.profit.pureQuote).to.equal(3.75)
    expect(restored.profitCorrections).to.deep.equal(['c1'])
    // And the restored worker refuses to apply the same correction again.
    const after = buildBot(restored)
    expect(await after.applyProfitCorrection(DELTA, 'test', 'c1')).to.equal(
      'duplicate',
    )
    expect(after.data.profit.total).to.equal(11.5)
    expect(after.writes).to.have.length(0)
  })

  it('§2.3 a repeat of the same id is a no-op; a new id still applies', async () => {
    const bot = buildBot()
    await bot.applyProfitCorrection(DELTA, 'test', 'c1')
    expect(await bot.applyProfitCorrection(DELTA, 'test', 'c1')).to.equal(
      'duplicate',
    )
    expect(bot.data.profit.total).to.equal(11.5)
    expect(await bot.applyProfitCorrection(DELTA, 'test', 'c2')).to.equal(
      'applied',
    )
    expect(bot.data.profit.total).to.equal(13)
    expect(bot.data.profitCorrections).to.deep.equal(['c1', 'c2'])
  })

  it('§2.4 refuses while loading, on a combo bot, and on a bad delta — nothing written', async () => {
    const loading = buildBot()
    loading.loadingComplete = false
    expect(await loading.applyProfitCorrection(DELTA, 't', 'c1')).to.match(
      /^refused: bot data not loaded/,
    )
    const combo = buildBot()
    combo.combo = true
    expect(await combo.applyProfitCorrection(DELTA, 't', 'c1')).to.match(
      /^refused: only a DCA bot/,
    )
    const bad = buildBot()
    expect(
      await bad.applyProfitCorrection({ ...DELTA, total: NaN }, 't', 'c1'),
    ).to.match(/^refused: delta.total/)
    for (const b of [loading, combo, bad]) {
      expect(b.writes).to.have.length(0)
      expect(b.data.profit.total).to.equal(10)
    }
  })

  it('§2.4 never throws: a failing write is reported, the memory copy stays', async () => {
    const bot = buildBot()
    bot.updateData = async () => {
      throw new Error('db down')
    }
    expect(await bot.applyProfitCorrection(DELTA, 't', 'c1')).to.equal(
      'applied, persist failed: db down',
    )
    expect(bot.data.profit.total).to.equal(11.5)
    expect(await bot.applyProfitCorrection(DELTA, 't', 'c1')).to.equal(
      'duplicate',
    )
  })

  it('snapshot helper keeps the field', () => {
    const o: any = convertDCABotToObject({
      ...botData(),
      profitCorrections: ['c1'],
    } as any)
    expect(o.profitCorrections).to.deep.equal(['c1'])
  })
})
