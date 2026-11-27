process.env.NODE_ENV = 'testing'

/**
 * Spec 296 §4 — the hold reaches the four places that trade an open deal:
 * order placement, the missing-TP re-send, automatic closes and the
 * DCA-by-market safety order. A manual or API close still runs, and a crash
 * with an unchanged balance trades exactly as before.
 *
 * Run: `npm test` (mocha) from core/. No network or DB: drives the real
 * dcaHelper methods over the real MainBot, with the three evidence reads
 * (snapshot row, recorded fills, venue balance) stubbed.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import { ConditionLatch } from './conditionLatch'
import {
  BotStatusEnum,
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
} from '../../types'

const DAY = 24 * 60 * 60 * 1000
const CREATE = Date.UTC(2026, 10, 10)

describe('spec 296 — token ratio hold wiring', () => {
  let DCA: any
  let dbInit: any

  before(function () {
    this.timeout(240000)
    const req = createRequire(__filename)
    DCA = req('./dcaHelper').default(MainBot)
    dbInit = req('../db/dbInit')
  })

  /**
   * A spot SNDKB-style deal: average 870.655, price now `price`. The
   * baseline snapshot holds `baseline` base; the venue now holds `venue`.
   */
  function bot(o: { price: number; baseline: number; venue: number }) {
    const rec = {
      placed: 0,
      reads: { snapshot: 0, orders: 0, balance: 0 },
      errors: [] as string[],
      logs: [] as string[],
      closeReached: [] as string[],
      rearmCleared: 0,
    }
    dbInit.snapshotDb.readData = async () => {
      rec.reads.snapshot++
      return {
        status: StatusEnum.ok,
        data: {
          result: [
            {
              updateTime: CREATE - 3 * DAY,
              assets: [
                {
                  name: 'SNDKB',
                  exchanges: [{ uuid: 'ex1', amount: o.baseline }],
                },
              ],
            },
          ],
        },
      }
    }
    const b: any = Object.create(DCA.prototype)
    b.botId = 'b296'
    b.userId = 'u296'
    b.combo = false
    b.loadingComplete = true
    b.allowedMethods = new Set(['checkDCAByMarketLevel'])
    b.data = {
      _id: b.botId,
      status: BotStatusEnum.open,
      exchange: ExchangeEnum.bitget,
      exchangeUUID: 'ex1',
      paperContext: false,
      settings: { pair: ['SNDKBUSDT'], futures: false },
    }
    b.deals = new Map()
    b.dealStatusMap = new Map()
    b.dealSymbolMap = new Map()
    b.dealTimersMap = new Map()
    b.allowToPlaceOrders = new Map()
    b.tokenRatioHolds = new Map()
    b.dealsDCAByMarket = new Map()
    b.dealsByMarketProcessing = new Set()
    b.lastStreamData = new Map([
      ['SNDKBUSDT', { price: o.price, time: Date.now() }],
    ])
    b.standingConditionLatch = new ConditionLatch(60 * 60 * 1000)
    b.orders = new Map()
    b.exchange = {}
    b.ordersDb = {
      readData: async () => {
        rec.reads.orders++
        return { status: StatusEnum.ok, data: { result: [] } }
      },
    }
    b.getBalancesFromExchange = async () => {
      rec.reads.balance++
      return {
        status: StatusEnum.ok,
        data: [{ asset: 'SNDKB', free: o.venue, locked: 0 }],
      }
    }
    b.handleErrors = async (e: string) => {
      rec.errors.push(e)
    }
    b.handleLog = (m: string) => {
      rec.logs.push(m)
    }
    b.handleDebug = () => undefined
    b.handleWarn = () => undefined
    b.startMethod = () => 'm'
    b.endMethod = () => undefined
    b.clearDealTimer = async () => undefined
    b.shouldProceed = () => true
    b.restingTakeProfits = () => []
    b.clearMissingTpRearm = () => {
      rec.rearmCleared++
    }
    b.getTPOrder = async () => {
      rec.placed++
      return []
    }
    b.getExchangeInfo = async () => ({ baseAsset: {}, quoteAsset: {} })
    b.dealReleased = () => {
      // Reached only when the hold let placement through.
      rec.placed++
      return true
    }
    // (dealId, deal, closeType, forceMarket, price, sl, closeTrigger)
    b.maybeStartSplitClose = async (...a: any[]) => {
      rec.closeReached.push(String(a[6]))
      return true
    }
    b.deals.set('d1', {
      deal: {
        _id: 'd1',
        status: DCADealStatusEnum.open,
        symbol: { symbol: 'SNDKBUSDT', baseAsset: 'SNDKB', quoteAsset: 'USDT' },
        avgPrice: 870.655,
        lastPrice: o.price,
        createTime: CREATE,
      },
      currentOrders: [{ price: String(o.price), side: 'BUY' }],
      initialOrders: [],
    })
    return { b, rec }
  }

  const split = () => bot({ price: 72.36, baseline: 0.0128, venue: 0.1024 })
  const crash = () => bot({ price: 300, baseline: 0.0128, venue: 0.0128 })

  it('§4.1 placement into a re-denominated pair is skipped, and reported once', async () => {
    const { b, rec } = split()
    await b.placeOrdersHoldingDealLock('b296', 'SNDKBUSDT', 'd1', {
      new: [{}],
      cancel: [],
    })
    await b.placeOrdersHoldingDealLock('b296', 'SNDKBUSDT', 'd1', {
      new: [{}],
      cancel: [],
    })
    expect(rec.placed).to.equal(0)
    expect(rec.errors).to.have.length(1)
    expect(rec.errors[0]).to.contain('SNDKBUSDT')
    // The second call is answered from the cache: one read of each source.
    expect(rec.reads).to.deep.equal({ snapshot: 1, orders: 1, balance: 1 })
  })

  it('§4.1 a crash with the balance unchanged places as before', async () => {
    const { b, rec } = crash()
    await b.placeOrdersHoldingDealLock('b296', 'SNDKBUSDT', 'd1', {
      new: [{}],
      cancel: [],
    })
    expect(rec.placed).to.equal(1)
    expect(rec.errors).to.have.length(0)
  })

  it('§4.1 a deal near its entry reads nothing', async () => {
    const { b, rec } = bot({ price: 800, baseline: 0.0128, venue: 0.1024 })
    await b.placeOrdersHoldingDealLock('b296', 'SNDKBUSDT', 'd1', {
      new: [{}],
      cancel: [],
    })
    expect(rec.placed).to.equal(1)
    expect(rec.reads).to.deep.equal({ snapshot: 0, orders: 0, balance: 0 })
  })

  it('§4.2 the missing-TP re-send stops for a held deal', async () => {
    const { b, rec } = split()
    await b.rearmMissingTp('d1')
    expect(rec.placed).to.equal(0)
    expect(rec.rearmCleared).to.equal(1)
  })

  it('§4.3 an automatic close is skipped; manual and API closes run', async () => {
    for (const t of [
      DCACloseTriggerEnum.tp,
      DCACloseTriggerEnum.sl,
      DCACloseTriggerEnum.webhook,
    ]) {
      const { b, rec } = split()
      await b.closeDealById(
        'b296',
        'd1',
        CloseDCATypeEnum.closeByMarket,
        true,
        false,
        false,
        false,
        '',
        undefined,
        false,
        t,
      )
      expect(rec.closeReached, t).to.deep.equal([])
    }
    for (const t of [DCACloseTriggerEnum.manual, DCACloseTriggerEnum.api]) {
      const { b, rec } = split()
      await b.closeDealById(
        'b296',
        'd1',
        CloseDCATypeEnum.closeByMarket,
        true,
        false,
        false,
        false,
        '',
        undefined,
        false,
        t,
      )
      expect(rec.closeReached).to.deep.equal([t])
    }
  })

  it('§4.3 an automatic close of a crashed deal runs as before', async () => {
    const { b, rec } = crash()
    await b.closeDealById(
      'b296',
      'd1',
      CloseDCATypeEnum.closeByMarket,
      true,
      false,
      false,
      false,
      '',
      undefined,
      false,
      DCACloseTriggerEnum.sl,
    )
    expect(rec.closeReached).to.deep.equal([DCACloseTriggerEnum.sl])
  })

  it('§4.4 no DCA-by-market safety order into a held pair', async () => {
    const { b, rec } = split()
    b.holdSafetyOrderAgainstOpposingPosition = async () => false
    Object.defineProperty(b, 'isLong', { get: () => true })
    let marketSent = 0
    b.getExchangeInfo = async () => {
      marketSent++
      return null
    }
    b.dealsDCAByMarket.set('d1', 72.36)
    await b.checkDCAByMarketLevel('b296', 72.36, 'SNDKBUSDT')
    expect(marketSent).to.equal(0)
    expect(rec.errors).to.have.length(1)
  })

  it('§4.5 futures bots are never held', async () => {
    const { b, rec } = split()
    b.data.settings.futures = true
    expect(await b.holdForTokenRatioChange('d1')).to.equal(false)
    expect(rec.reads.snapshot).to.equal(0)
  })
})
