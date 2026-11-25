process.env.NODE_ENV = 'testing'

/**
 * Core spec 261 — a spot hedge DCA bot's SHORT leg sold the coins its LONG
 * leg holds for its take profit. Both legs trade one coin from one account and
 * nothing on the venue locks the long's coins while its take profit is not
 * resting, so every short sell the venue accepted spent them, and the long's
 * take profit was then refused for balance on every attempt.
 *
 * Spec: `specs/261.hedge-short-leg-sells-long-leg-coins.md`.
 * Run: `npm test` (mocha), or this file alone:
 * `NODE_ENV=testing npx mocha --timeout 20000 --exit -r ts-node/register src/bot/hedgeShortSellReserve.spec.ts`
 *
 * No network / DB: the real `sendOrderToExchange` runs off the DCA bot's
 * prototype against a fake venue; the deals/bots/orders reads are stubbed.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import createDCABotHelper from './dcaHelper'
import { ExchangeEnum, StatusEnum } from '../../types'
import { matchesNotEnoughBalance } from './main'

const load = createRequire(__filename)
const dbInit = load('../db/dbInit')
const { FundingReservation } = load('./fundingReservation')
const { hedgeShortSellFits } = load('./baseFunding')
const { BaseFundingGate, BASE_FUNDING_RELEASED } = load('./baseFundingGate')
const Helper: any = createDCABotHelper(MainBot as any)

const PARENT = 'hedge-parent'
const SHORT_BOT = 'short-leg'
const LONG_BOT = 'long-leg'
const SHORT_DEAL = 'short-deal'

/** What the stubbed collections hold. */
const db = {
  legs: [] as { _id: string }[],
  longDeals: [] as any[],
  resting: [] as any[],
  fail: new Set<string>(),
  filters: [] as { coll: string; filter: any }[],
}

const ok = (result: unknown) => ({ status: StatusEnum.ok, data: { result } })
const bad = { status: StatusEnum.notok, reason: 'timeout' }

function reset() {
  db.legs = [{ _id: LONG_BOT }, { _id: SHORT_BOT }]
  // The originating case: the LONG holds 1.66, no take profit on the book.
  db.longDeals = [{ _id: 'long-deal', currentBalances: { base: 1.66 } }]
  db.resting = []
  db.fail = new Set()
  db.filters = []
  ;(FundingReservation.getInstance() as any).heldByLong.clear()
}

function order(over: Record<string, unknown> = {}) {
  return {
    symbol: 'SOXSUSDT',
    orderId: '-1',
    clientOrderId: 'D-SO-1',
    price: '50',
    origPrice: '50',
    origQty: '1',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'SELL',
    type: 'LIMIT',
    typeOrder: 'dealRegular',
    dealId: SHORT_DEAL,
    exchange: ExchangeEnum.binance,
    exchangeUUID: '',
    updateTime: 1,
    transactTime: 1,
    ...over,
  } as any
}

type Opts = {
  free?: number
  isLong?: boolean
  futures?: boolean
  parentBotId?: string | undefined
  deal?: Record<string, unknown>
}

function shortLeg(o: Opts = {}) {
  const rec = {
    open: [] as string[],
    orderErrors: [] as string[],
    deletedRows: [] as string[],
    cancelledRows: [] as any[],
  }
  const free = o.free ?? 2.60886
  const bot: any = Object.create(Helper.prototype)
  bot.botId = o.isLong ? LONG_BOT : SHORT_BOT
  bot.userId = 'user'
  bot.botType = 'dca'
  bot.combo = false
  bot.isLong = !!o.isLong
  bot.data = {
    exchange: ExchangeEnum.binance,
    exchangeUUID: '',
    paperContext: false,
    parentBotId: 'parentBotId' in o ? o.parentBotId : PARENT,
    settings: {
      leverage: 1,
      futures: !!o.futures,
      strategy: o.isLong ? 'LONG' : 'SHORT',
      pair: ['SOXSUSDT'],
    },
    flags: [],
  }
  bot.deals = new Map([
    [SHORT_DEAL, { deal: { _id: SHORT_DEAL, ...(o.deal ?? {}) } }],
  ])
  bot.orders = new Map()
  bot.ordersKeys = new Set()
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.math = {
    round: (v: number, p = 8) => +(+v).toFixed(p),
    remainder: () => 0,
  }
  bot.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    async openOrder(req: { newClientOrderId: string }) {
      rec.open.push(req.newClientOrderId)
      return {
        status: StatusEnum.ok,
        reason: null,
        data: { ...order(), orderId: 'venue-1', status: 'NEW' },
      }
    },
  }
  // No stub of the spec 044 gate: it runs as in prod, released to everyone.
  bot.checkAssets = async () =>
    new Map([
      ['SOXS', { asset: 'SOXS', free, locked: 0 }],
      ['USDT', { asset: 'USDT', free: 1000, locked: 0 }],
    ])
  bot.startMethod = () => 1
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleWarn = () => undefined
  bot.handleError = () => undefined
  bot.handleErrors = () => undefined
  bot.handleOrderErrors = async (reason: string) => {
    rec.orderErrors.push(reason)
  }
  bot.emit = () => undefined
  bot.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  bot.setOrdersToRedis = () => undefined
  bot.setOrderByDeal = () => undefined
  bot.setOrderByStatus = () => undefined
  bot.removeOrderByDeal = () => undefined
  bot.removeOrderByStatus = () => undefined
  bot.getExchangeInfo = async () => ({
    pair: 'SOXSUSDT',
    priceAssetPrecision: 2,
    baseAsset: { minAmount: 0.01, step: 0.01, name: 'SOXS' },
    quoteAsset: { minAmount: 5, name: 'USDT', precision: 8 },
  })
  bot.getUserFee = async () => ({ maker: 0.001, taker: 0.001 })
  bot.saveOrderToDb = async () => undefined
  bot.deleteOrderFromDb = async (id: string) => {
    rec.deletedRows.push(id)
  }
  bot.updateOrderOnDb = async (row: any) => {
    if (row.status === 'CANCELED') rec.cancelledRows.push(row)
  }
  bot.noteWrittenOffClientOrderId = () => undefined
  bot.noteRefusedRequired = () => undefined
  bot.getNotEnoughOrdersIdByOrder = () => 'nb'
  bot.isComplianceGateable = () => false
  bot.needToSendOrder = () => true
  bot.markDealStartBlocked = async () => undefined
  bot.convertOrderExecutedQty = async (x: any) => x.executedQty
  bot.convertOrderQuoteQty = async (_s: string, q: string) => q
  bot.ordersDb = {
    readData: async () => ({ data: { result: undefined } }),
    updateData: async () => ({ status: StatusEnum.ok }),
  }
  bot.botEventDb = { createData: () => undefined }
  return { bot, rec }
}

describe('spot hedge short leg keeps the long leg coins (core spec 261)', () => {
  let saved: Record<string, any> = {}
  before(() => {
    saved = {
      bots: dbInit.dcaBotDb.readData,
      deals: dbInit.dcaDealsDb.readData,
      orders: dbInit.orderDb.readData,
    }
    dbInit.dcaBotDb.readData = async (filter: any) => {
      db.filters.push({ coll: 'bots', filter })
      return db.fail.has('bots') ? bad : ok(db.legs)
    }
    dbInit.dcaDealsDb.readData = async (filter: any) => {
      db.filters.push({ coll: 'deals', filter })
      if (db.fail.has('deals')) return bad
      // Only deals of that coin, as the real filter does.
      return ok(filter['symbol.baseAsset'] === 'SOXS' ? db.longDeals : [])
    }
    dbInit.orderDb.readData = async (filter: any) => {
      db.filters.push({ coll: 'orders', filter })
      return ok(db.resting)
    }
  })
  after(() => {
    dbInit.dcaBotDb.readData = saved.bots
    dbInit.dcaDealsDb.readData = saved.deals
    dbInit.orderDb.readData = saved.orders
  })
  beforeEach(reset)

  // The first fix skipped every user the spec 044 gate allows, and since the
  // gate was released that is every user: its check never ran in prod. These
  // run against the real gate, never a stub.
  describe('§3.6 with base funding released to everyone, as in prod', () => {
    it('the gate allows this user (prod state, not stubbed)', async () => {
      expect(BASE_FUNDING_RELEASED).to.equal(true)
      expect(await BaseFundingGate.getInstance().isAllowed('user')).to.equal(
        true,
      )
      const { bot } = shortLeg()
      expect(await bot.baseFundingAllowed()).to.equal(true)
    })

    it('an unstamped short deal still may not sell the long leg coins', async () => {
      const { bot, rec } = shortLeg()
      expect(await bot.hedgeShortLegReserveApplies()).to.equal(true)
      await bot.sendOrderToExchange(order({ origQty: '0.07' }))
      // The prod case after deploy: 0.07 SOXS safety sell, 0 SOXS beyond
      // the long's 1.66 free on the venue.
      expect(rec.open).to.have.length(1)
      const r2 = shortLeg({ free: 1.66 })
      await r2.bot.sendOrderToExchange(order({ origQty: '0.07' }))
      expect(r2.rec.open, 'nothing reaches the venue').to.deep.equal([])
      expect(r2.rec.orderErrors[0]).to.contain(
        'held by the long side of this hedge bot',
      )
    })
  })

  describe('§3.1 hedgeShortSellFits', () => {
    it('a sell fits only in what is free beyond the long leg coins', () => {
      expect(
        hedgeShortSellFits({ freeBase: 2.60886, heldByLong: 1.66, qty: 0.9 })
          .fits,
      ).to.equal(true)
      expect(
        hedgeShortSellFits({ freeBase: 2.60886, heldByLong: 1.66, qty: 1 })
          .fits,
      ).to.equal(false)
      expect(
        hedgeShortSellFits({ freeBase: 1, heldByLong: 1.66, qty: 0 }).spendable,
      ).to.equal(0)
      expect(
        hedgeShortSellFits({ freeBase: 1, heldByLong: NaN, qty: 1 }).fits,
      ).to.equal(true)
    })
  })

  describe('§3.2 FundingReservation.heldByHedgeLongLegs', () => {
    const read = (fresh = true) =>
      FundingReservation.getInstance().heldByHedgeLongLegs(
        PARENT,
        SHORT_BOT,
        'SOXS',
        fresh,
      )

    it('sums the long deals and leaves out this leg and stamped deals', async () => {
      expect(await read()).to.equal(1.66)
      const bots = db.filters.find((f) => f.coll === 'bots')!.filter
      expect(bots.parentBotId).to.equal(PARENT)
      expect(bots['settings.strategy']).to.equal('LONG')
      const deals = db.filters.find((f) => f.coll === 'deals')!.filter
      expect(deals.botId.$in).to.deep.equal([LONG_BOT])
      expect(deals.baseFundingBeta).to.deep.equal({ $ne: true })
      expect(deals['symbol.baseAsset']).to.equal('SOXS')
    })

    it('a resting take profit already locks its part', async () => {
      db.resting = [
        {
          dealId: 'long-deal',
          origQty: '1.66',
          executedQty: '0.5',
          price: '78',
          typeOrder: 'dealTP',
        },
      ]
      expect(await read()).to.be.closeTo(0.5, 1e-12)
    })

    it('an unreadable read is null, not 0', async () => {
      db.fail.add('deals')
      expect(await read()).to.equal(null)
      db.fail = new Set(['bots'])
      expect(await read()).to.equal(null)
    })
  })

  describe('§3.3 the short leg sells at the order site', () => {
    it('a safety sell only the long leg coins cover is refused before the venue', async () => {
      const { bot, rec } = shortLeg()
      await bot.sendOrderToExchange(order())
      expect(rec.open, 'nothing reaches the venue').to.deep.equal([])
      expect(rec.orderErrors).to.have.length(1)
      expect(matchesNotEnoughBalance(rec.orderErrors[0])).to.equal(true)
      expect(rec.deletedRows, 'write-ahead row taken back').to.deep.equal([
        'D-SO-1',
      ])
      expect(rec.cancelledRows, 'no venue write-off').to.deep.equal([])
    })

    it('a base sell is refused the same way', async () => {
      const { bot, rec } = shortLeg()
      await bot.sendOrderToExchange(
        order({ typeOrder: 'dealStart', clientOrderId: 'D-BO-1' }),
      )
      expect(rec.open).to.deep.equal([])
      expect(rec.orderErrors).to.have.length(1)
    })

    it('a sell that fits in the rest is sent', async () => {
      const { bot, rec } = shortLeg()
      await bot.sendOrderToExchange(order({ origQty: '0.9' }))
      expect(rec.open).to.deep.equal(['D-SO-1'])
    })

    it('an unreadable long-leg read sends the order, as before', async () => {
      db.fail.add('deals')
      const { bot, rec } = shortLeg()
      await bot.sendOrderToExchange(order())
      expect(rec.open).to.deep.equal(['D-SO-1'])
    })

    it('the not-enough-balance report reads the base net of the long leg coins', async () => {
      const { bot } = shortLeg()
      expect(
        await bot.spendableForNotEnoughBalance('SOXS', 2.60886),
      ).to.be.closeTo(0.94886, 1e-9)
      expect(await bot.spendableForNotEnoughBalance('USDT', 1000)).to.equal(
        1000,
      )
    })
  })

  describe('§3.4 the new-deal balance gate', () => {
    /** A short leg whose deal sells 0.5 base + 0.5 in safety orders. */
    const gate = (o: Opts = {}) => {
      const { bot } = shortLeg(o)
      bot.getAggregatedSettings = async () => ({
        pair: ['SOXSUSDT'],
        type: 'regular',
      })
      bot.getLeverageMultipler = async () => 1
      bot.getLatestPrice = async () => 50
      bot.getBaseOrder = async () => ({ origQty: '0.5', price: '50' })
      bot.createInitialDealOrders = async () => []
      bot.createCurrentDealOrders = async () => [
        { type: 'dealRegular', side: 'SELL', qty: 0.5, price: 55 },
      ]
      bot.reservedFundingBase = async () => 0
      bot.pooledMarginOrKeep = async (_a: string, v: number) => v
      bot.useCompountReduce = false
      return bot.checkBalance('SOXSUSDT')
    }

    it('a deal the long leg coins would fund is not opened', async () => {
      const r = await gate({ free: 2.0 })
      expect(r.status).to.equal(false)
      expect(r.available).to.be.closeTo(0.34, 1e-9)
      expect(r.required).to.equal(1)
    })

    it('a deal the rest funds is opened', async () => {
      expect((await gate({ free: 2.7 })).status).to.equal(true)
    })

    it('an unreadable long-leg read is an unknown balance', async () => {
      db.fail.add('deals')
      const r = await gate({ free: 2.7 })
      expect(r.status).to.equal(false)
      expect(r.unknown).to.equal(true)
    })
  })

  describe('§3.5 what does not change', () => {
    const sent = async (o: Opts, over: Record<string, unknown> = {}) => {
      const { bot, rec } = shortLeg(o)
      await bot.sendOrderToExchange(order(over))
      return rec.open.length
    }
    it('the short leg buys', async () => {
      expect(await sent({}, { side: 'BUY', typeOrder: 'dealTP' })).to.equal(1)
    })
    it('the long leg own sells', async () => {
      expect(await sent({ isLong: true }, { typeOrder: 'dealTP' })).to.equal(1)
    })
    it('futures hedge legs', async () => {
      expect(await sent({ futures: true })).to.equal(1)
    })
    it('spec 044 deals (stamped, or with a start action)', async () => {
      expect(await sent({ deal: { baseFundingBeta: true } })).to.equal(1)
      expect(await sent({ deal: { action: 'useBalance' } })).to.equal(1)
    })
    it('ordinary non-hedge spot bots', async () => {
      expect(await sent({ parentBotId: undefined })).to.equal(1)
    })
  })
})
