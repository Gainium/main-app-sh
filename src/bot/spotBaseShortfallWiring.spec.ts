process.env.NODE_ENV = 'testing'

/**
 * Spec 298 — a long spot deal's close refused for balance while the account
 * holds some, but less than the deal, of its base.
 *
 * Drives the real dcaHelper methods over the real MainBot with the venue reads
 * (exchange info, balance, account fills), the Redis stores and the settle /
 * reconcile / warning sinks stubbed. No network, DB or Redis.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import {
  BotStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'

const CREATE = Date.UTC(2026, 10, 20)

/** In-memory stand-in for a RetryBackoff. */
const store = () => {
  const m = new Map<string, { attempt: number; until: number }>()
  return {
    m,
    async record(parts: string[], reason: string) {
      const k = parts.join(':')
      const attempt = (m.get(k)?.attempt ?? 0) + 1
      const s = { attempt, until: Date.now() + 300000 }
      m.set(k, s)
      return { ...s, reason, interval: 300000 }
    },
    async check(parts: string[]) {
      const s = m.get(parts.join(':'))
      return s && s.until > Date.now()
        ? { suppressed: true, attempt: s.attempt }
        : { suppressed: false, attempt: 0 }
    },
    async peek(parts: string[]) {
      return m.get(parts.join(':')) ?? null
    },
    async clear(parts: string[]) {
      m.delete(parts.join(':'))
    },
  }
}

describe('spec 298 — spot close refused, account holds less than the deal', () => {
  let DCA: any

  before(function () {
    this.timeout(240000)
    const req = createRequire(__filename)
    DCA = req('./dcaHelper').default(MainBot)
  })

  /**
   * A DOT deal with `remaining` base left; the account holds `free`+`locked`;
   * `fills` is what `getAccountFills` answers (or throws when 'throw').
   */
  function bot(o: {
    remaining: number
    free: number
    locked?: number
    fills?: any[] | 'throw'
  }) {
    const rec = {
      fillReads: 0,
      settled: [] as any[],
      reconciled: 0,
      events: [] as any[],
      rearmed: 0,
      rechecks: [] as number[],
      placed: 0,
    }
    const b: any = Object.create(DCA.prototype)
    b.botId = 'b298'
    b.userId = 'u298'
    b.combo = false
    b.isLong = true
    b.loadingComplete = true
    b.data = {
      _id: b.botId,
      status: BotStatusEnum.open,
      exchange: ExchangeEnum.binance,
      exchangeUUID: 'ex1',
      paperContext: false,
      settings: { pair: ['DOTUSDT'], futures: false },
    }
    b.deals = new Map()
    b.dealStatusMap = new Map()
    b.allowToPlaceOrders = new Map()
    b.tokenRatioHolds = new Map()
    b.orders = new Map()
    const stores = { readings: store(), held: store() }
    b.spotShortfallStores = () => stores
    b.exchange = {
      getAccountFills: async () => {
        rec.fillReads++
        if (o.fills === 'throw') {
          throw new Error('venue down')
        }
        return { status: StatusEnum.ok, data: o.fills ?? [] }
      },
    }
    b.getExchangeInfo = async () => ({
      baseAsset: { name: 'DOT', minAmount: 0.01 },
      quoteAsset: { name: 'USDT' },
    })
    b.getBalancesFromExchange = async () => ({
      status: StatusEnum.ok,
      data: [{ asset: 'DOT', free: o.free, locked: o.locked ?? 0 }],
    })
    b.dealOwnBasePosition = () => o.remaining
    b.restingTakeProfits = () => []
    b.hasHeldTakeProfit = () => false
    b.settleExternallyClosedDeal = async (id: string, ev: any) => {
      rec.settled.push({ id, ev })
    }
    b.reconcileDealPosition = async () => {
      rec.reconciled++
      return false
    }
    b.rearmMissingTp = async () => {
      rec.rearmed++
    }
    b.armSpotShortfallRecheck = (_id: string, ms: number) => {
      rec.rechecks.push(ms)
    }
    b.botEventDb = {
      createData: (e: any) => {
        rec.events.push(e)
      },
    }
    b.handleErrors = async () => undefined
    b.handleLog = () => undefined
    b.handleDebug = () => undefined
    b.handleWarn = () => undefined
    b.shouldProceed = () => true
    b.startMethod = () => 'm'
    b.endMethod = () => undefined
    b.dealReleased = () => {
      rec.placed++
      return true
    }
    b.deals.set('d1', {
      deal: {
        _id: 'd1',
        status: DCADealStatusEnum.open,
        symbol: { symbol: 'DOTUSDT', baseAsset: 'DOT', quoteAsset: 'USDT' },
        avgPrice: 4,
        lastPrice: 4,
        createTime: CREATE,
      },
      currentOrders: [],
      initialOrders: [],
    })
    /** Let the next reading through, as the re-read timer does. */
    const elapse = () => {
      for (const s of stores.readings.m.values()) s.until = 0
    }
    return { b, rec, stores, elapse }
  }

  const outsideSell = (qty: number, price: number, extra: any = {}) => ({
    symbol: 'DOTUSDT',
    side: 'SELL',
    timestamp: CREATE + 60000,
    quantity: `${qty}`,
    price: `${price}`,
    clientOrderId: '',
    ...extra,
  })

  it('§3.2 partial holding + matching outside fills: booked closed at their price', async () => {
    const { b, rec } = bot({
      remaining: 44.35,
      free: 10,
      fills: [
        outsideSell(20, 5),
        outsideSell(14.35, 6),
        // the bot's own sell is not outside evidence
        outsideSell(50, 9, { clientOrderId: 'GA-123' }),
      ],
    })
    expect(await b.checkSpotBaseShortfall('d1', 'refusal')).to.equal('settled')
    expect(rec.settled).to.have.length(1)
    const ev = rec.settled[0].ev
    expect(ev.qty).to.be.closeTo(34.35, 1e-9)
    expect(ev.price).to.be.closeTo((20 * 5 + 14.35 * 6) / 34.35, 1e-9)
    expect(rec.events).to.have.length(0)
    expect(await b.holdForSpotShortfall('d1')).to.equal(false)
  })

  it('§3.3 no outside fills: held on the second agreeing reading, warned once', async () => {
    const { b, rec, elapse } = bot({ remaining: 44.35, free: 10, fills: [] })
    expect(await b.checkSpotBaseShortfall('d1', 'refusal')).to.equal('reading')
    expect(await b.holdForSpotShortfall('d1')).to.equal(false)
    // A burst of refusals inside the window is the same reading.
    expect(await b.checkSpotBaseShortfall('d1', 'refusal')).to.equal('skipped')
    elapse()
    expect(await b.checkSpotBaseShortfall('d1', 'recheck')).to.equal('held')
    expect(rec.events).to.have.length(1)
    expect(rec.events[0].description).to.contain('10 DOT')
    expect(rec.events[0].description).to.contain('44.35 DOT')
    expect(await b.checkSpotBaseShortfall('d1', 'refusal')).to.equal('held')
    expect(await b.checkSpotBaseShortfall('d1', 'recheck')).to.equal('held')
    expect(rec.events).to.have.length(1)
    expect(rec.settled).to.have.length(0)
    b.spotShortfallHolds.clear()
    expect(await b.holdForSpotShortfall('d1')).to.equal(true)
  })

  it('§3.3 fills unreadable: same as none — held after two readings, never settled', async () => {
    const { b, rec, elapse } = bot({ remaining: 44.35, free: 10, fills: 'throw' })
    expect(await b.checkSpotBaseShortfall('d1', 'refusal')).to.equal('reading')
    elapse()
    expect(await b.checkSpotBaseShortfall('d1', 'recheck')).to.equal('held')
    expect(rec.fillReads).to.equal(2)
    expect(rec.settled).to.have.length(0)
    expect(rec.events).to.have.length(1)
  })

  it('§3.1 coin locked in other orders, TOTAL covers: today\'s behaviour', async () => {
    // total 46.5, free 4.15, needed 44.35
    const { b, rec } = bot({ remaining: 44.35, free: 4.15, locked: 42.35 })
    expect(await b.checkSpotBaseShortfall('d1', 'refusal')).to.equal('covered')
    expect(rec.fillReads).to.equal(0)
    expect(rec.settled).to.have.length(0)
    expect(rec.events).to.have.length(0)
    expect(rec.reconciled).to.equal(0)
    expect(await b.holdForSpotShortfall('d1')).to.equal(false)
  })

  it('§3.1 zero holding: left to spec 047, nothing done here', async () => {
    const { b, rec } = bot({ remaining: 44.35, free: 0 })
    expect(await b.checkSpotBaseShortfall('d1', 'refusal')).to.equal('gone')
    expect(rec.fillReads).to.equal(0)
    expect(rec.settled).to.have.length(0)
    expect(rec.events).to.have.length(0)
    expect(rec.reconciled).to.equal(0)
    expect(await b.holdForSpotShortfall('d1')).to.equal(false)
  })

  it('§3.4 a held deal places no new orders; cancels still go through', async () => {
    const { b, rec, elapse } = bot({ remaining: 44.35, free: 10 })
    await b.checkSpotBaseShortfall('d1', 'refusal')
    elapse()
    await b.checkSpotBaseShortfall('d1', 'recheck')
    await b.placeOrdersHoldingDealLock('b298', 'DOTUSDT', 'd1', {
      new: [{}],
      cancel: [],
    })
    expect(rec.placed).to.equal(0)
    await b.placeOrdersHoldingDealLock('b298', 'DOTUSDT', 'd1', {
      new: [],
      cancel: [{}],
    })
    expect(rec.placed).to.equal(1)
  })

  it('§3.5 the balance restored releases the hold and re-arms the take profit', async () => {
    const o = { remaining: 44.35, free: 10 }
    const { b, rec, elapse } = bot(o)
    await b.checkSpotBaseShortfall('d1', 'refusal')
    elapse()
    await b.checkSpotBaseShortfall('d1', 'recheck')
    o.free = 44.35
    expect(await b.checkSpotBaseShortfall('d1', 'recheck')).to.equal('covered')
    expect(rec.rearmed).to.equal(1)
    expect(await b.holdForSpotShortfall('d1')).to.equal(false)
  })

  it('§3.5 a held deal whose holding drops under the minimum goes to spec 047', async () => {
    const o = { remaining: 44.35, free: 10 }
    const { b, rec, elapse } = bot(o)
    await b.checkSpotBaseShortfall('d1', 'refusal')
    elapse()
    await b.checkSpotBaseShortfall('d1', 'recheck')
    o.free = 0
    expect(await b.checkSpotBaseShortfall('d1', 'recheck')).to.equal('gone')
    expect(rec.reconciled).to.equal(1)
    expect(await b.holdForSpotShortfall('d1')).to.equal(false)
  })

  it('§2 only a long spot DCA deal-close balance refusal triggers', () => {
    const { b } = bot({ remaining: 44.35, free: 10 })
    const nb =
      'Not enough balance Order id GA-1, order type: deal close, balance total - 10 DOT, free - 10 DOT, required - 44.35 DOT'
    const tp = { dealId: 'd1', typeOrder: TypeOrderEnum.dealTP }
    b.isErrorNotEnoughBalance = (s: string) => s.startsWith('Not enough balance')
    expect(b.spotShortfallTriggered(nb, tp)).to.equal(true)
    expect(b.spotShortfallTriggered('Timeout', tp)).to.equal(false)
    expect(
      b.spotShortfallTriggered(nb, { ...tp, typeOrder: TypeOrderEnum.dealRegular }),
    ).to.equal(false)
    expect(b.spotShortfallTriggered(nb, { ...tp, reduceFundsId: 'r' })).to.equal(
      false,
    )
    b.combo = true
    expect(b.spotShortfallTriggered(nb, tp)).to.equal(false)
    b.combo = false
    b.data.settings.futures = true
    expect(b.spotShortfallTriggered(nb, tp)).to.equal(false)
    b.data.settings.futures = false
    b.isLong = false
    expect(b.spotShortfallTriggered(nb, tp)).to.equal(false)
  })

  it('§3 a deal with a resting or band-held take profit is not checked', async () => {
    const { b, rec } = bot({ remaining: 44.35, free: 10 })
    b.hasHeldTakeProfit = () => true
    expect(await b.checkSpotBaseShortfall('d1', 'refusal')).to.equal('skipped')
    b.hasHeldTakeProfit = () => false
    b.restingTakeProfits = () => [{}]
    expect(await b.checkSpotBaseShortfall('d1', 'refusal')).to.equal('skipped')
    expect(rec.fillReads).to.equal(0)
  })
})
