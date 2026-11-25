process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `266.combo-grid-sells-refused-against-a-smaller-venue-position`.
 *
 * Same harness as spec 175's `comboFlatDealGridRefusal.spec.ts`: the REAL
 * Combo `handleOrderErrors` override and the REAL dcaHelper
 * `reconcileDealPosition`, over a minimal base class. The venue position call
 * and the bot event DAO are recorded instead of run, and the parent's
 * `placeOrdersHoldingDealLock` is replaced by a recorder so the test sees what
 * the combo override hands it.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import RedisClient from '../db/redis'
import {
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import { GRID_SHORTFALL_HOLD_MS } from './combo/gridShortfallHold'

const BOT_ID = '000000000000000000000b66'
const DEAL_ID = '000000000000000000000d66'
const MINIGRID = '000000000000000000000a66'
const PAIR = 'AAA-USD'

/** The production refusal, verbatim from the venue. */
const REFUSED = 'wouldNotReducePosition'

const store = new Map<string, string>()
let previousGetInstance: unknown
const useStore = () => {
  store.clear()
  previousGetInstance = (RedisClient as any).getInstance
  ;(RedisClient as any).getInstance = async () => ({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v)
    },
    del: async (k: string) => {
      store.delete(k)
    },
  })
}
const releaseStore = () => {
  if (previousGetInstance) {
    ;(RedisClient as any).getInstance = previousGetInstance
  }
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000466'
  loadingComplete = true
  futures = true
  coinm = false
  hedge = false
  orders = new Map()
  data: any = {
    settings: { type: 'regular', pair: [PAIR] },
    status: 'open',
    exchange: ExchangeEnum.krakenUsdm,
    exchangeUUID: 'uuid-266',
    flags: [],
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  async handleOrderErrors(e: string) {
    ;(this as any).reported.push(e)
  }
  constructor(..._a: any[]) {}
}

let Combo: any
/** What the parent placement pass received, per call. */
let placed: { new: any[]; cancel: any[] }[] = []

const buildBot = (venueQty: number | null) => {
  const positions: any[] =
    venueQty === null
      ? []
      : [{ symbol: PAIR, positionAmt: `${venueQty}`, positionSide: 'BOTH' }]
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: DCADealStatusEnum.open,
    symbol: { symbol: PAIR, baseAsset: 'AAA', quoteAsset: 'USD' },
    currentBalances: { base: 259, quote: 14.8 },
    levels: { complete: 14, all: 16 },
    avgPrice: 0.2953,
  }
  const full: any = {
    deal,
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
    closeBySl: false,
  }
  class TestBot extends Combo {
    reported: string[] = []
    probes = 0
    events: any[] = []
    closes: any[][] = []
    isLong = true
    positions = positions
    exchange: any = {
      futures_getPositions: async () => {
        this.probes++
        await new Promise((r) => setTimeout(r, 5))
        return { status: StatusEnum.ok, data: this.positions, reason: null }
      },
    }
    botEventDb: any = {
      createData: async (d: any) => {
        this.events.push(d)
        return { status: StatusEnum.ok }
      },
    }
    getDeal(id: string) {
      return id === DEAL_ID ? full : undefined
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async closeDealById(...args: any[]) {
      this.closes.push(args)
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
  }
  const bot = new (TestBot as any)(BOT_ID, ExchangeEnum.krakenUsdm, false)
  return { bot, full }
}

const refusedOrder = (price: number, side: 'BUY' | 'SELL' = 'SELL') =>
  ({
    clientOrderId: `CMB-GR-fixture${Math.random().toString(36).slice(2, 8)}`,
    dealId: DEAL_ID,
    minigridId: MINIGRID,
    symbol: PAIR,
    side,
    typeOrder: TypeOrderEnum.dealGrid,
    origQty: '19',
    price: `${price}`,
  }) as any

const grid = (
  price: number,
  side = OrderSideEnum.sell,
  type = TypeOrderEnum.dealGrid,
) =>
  ({
    newClientOrderId: `CMB-GR-new${Math.random().toString(36).slice(2, 8)}`,
    dealId: DEAL_ID,
    minigridId: MINIGRID,
    number: 0,
    price,
    qty: 19,
    side,
    type,
  }) as any

const settle = () => new Promise((r) => setTimeout(r, 40))

const refuse = async (bot: any, order: any) => {
  await bot.handleOrderErrors(
    REFUSED,
    order,
    'limitOrders()',
    `Send new order request ${order.clientOrderId}`,
  )
  await settle()
}

/** A burst like production: the levels go out together and all come back. */
const refuseBurst = async (bot: any, prices: number[]) => {
  await Promise.all(
    prices.map((p) =>
      bot.handleOrderErrors(REFUSED, refusedOrder(p), 'limitOrders()', 'step'),
    ),
  )
  await settle()
}

const place = (bot: any, news: any[], cancel: any[] = []) =>
  bot.placeOrdersHoldingDealLock(BOT_ID, PAIR, DEAL_ID, { new: news, cancel })

const sentPrices = () => placed[placed.length - 1].new.map((g) => g.price)

describe('combo grid levels refused against a smaller venue position (spec 266)', () => {
  before(function () {
    this.timeout(240000)
    const req = createRequire(__filename)
    const Dca = req('./dcaHelper').default(FakeBase)
    Dca.prototype.placeOrdersHoldingDealLock = async function (
      _b: string,
      _s: string,
      _d: string,
      orders: any,
    ) {
      placed.push({ new: [...orders.new], cancel: [...orders.cancel] })
    }
    Combo = req('./comboHelper').default(Dca)
  })
  beforeEach(() => {
    useStore()
    placed = []
  })
  afterEach(releaseStore)

  it('§1.1.2 tells the user once, with both quantities', async () => {
    const { bot } = buildBot(99)
    await refuseBurst(bot, [0.3237, 0.3312, 0.3386])
    expect(bot.probes).to.equal(1)
    expect(bot.events).to.have.length(1)
    const [event] = bot.events
    expect(event.type).to.equal('warning')
    expect(event.deal).to.equal(DEAL_ID)
    expect(event.description).to.contain('99')
    expect(event.description).to.contain('259')
    // A later shortfall reading in the same episode does not repeat it.
    bot.gridShortfallHolds.clear()
    await refuse(bot, refusedOrder(0.3237))
    expect(bot.probes).to.equal(2)
    expect(bot.events).to.have.length(1)
  })

  it('§1.1.3 holds back exactly the refused levels', async () => {
    const { bot } = buildBot(99)
    await refuseBurst(bot, [0.3237, 0.3312])
    const regular = grid(0.2558, OrderSideEnum.buy, TypeOrderEnum.dealRegular)
    const opening = grid(0.2633, OrderSideEnum.buy)
    const other = grid(0.316)
    const tp = grid(0.3202, OrderSideEnum.sell, TypeOrderEnum.dealTP)
    await place(bot, [grid(0.3237), grid(0.3312), regular, opening, other, tp])
    expect(sentPrices()).to.have.members([0.2558, 0.2633, 0.316, 0.3202])
  })

  it('§1.1.4 a level refused while held joins the hold without a probe', async () => {
    const { bot } = buildBot(99)
    await refuse(bot, refusedOrder(0.3237))
    expect(bot.probes).to.equal(1)
    await refuse(bot, refusedOrder(0.3386))
    expect(bot.probes).to.equal(1)
    await place(bot, [grid(0.3237), grid(0.3386)])
    expect(sentPrices()).to.deep.equal([])
  })

  describe('§1.1.5 the hold ends', () => {
    it('when the deal records a different base', async () => {
      const { bot, full } = buildBot(99)
      await refuse(bot, refusedOrder(0.3237))
      full.deal.currentBalances = { base: 280, quote: 9 }
      await place(bot, [grid(0.3237)])
      expect(sentPrices()).to.deep.equal([0.3237])
    })
    it('when the deal completes another level', async () => {
      const { bot, full } = buildBot(99)
      await refuse(bot, refusedOrder(0.3237))
      full.deal.levels = { complete: 15, all: 16 }
      await place(bot, [grid(0.3237)])
      expect(sentPrices()).to.deep.equal([0.3237])
    })
    it('when a pass cancels a closing-side grid order', async () => {
      const { bot } = buildBot(99)
      await refuse(bot, refusedOrder(0.3237))
      await place(bot, [grid(0.3237)], [grid(0.316)])
      expect(sentPrices()).to.deep.equal([0.3237])
      // And it stays ended.
      await place(bot, [grid(0.3237)])
      expect(sentPrices()).to.deep.equal([0.3237])
    })
    it('after GRID_SHORTFALL_HOLD_MS', async () => {
      const { bot } = buildBot(99)
      await refuse(bot, refusedOrder(0.3237))
      const hold = bot.gridShortfallHolds.get(DEAL_ID)
      hold.until = Date.now() - 1
      await place(bot, [grid(0.3237)])
      expect(sentPrices()).to.deep.equal([0.3237])
      expect(GRID_SHORTFALL_HOLD_MS).to.be.greaterThan(0)
    })
  })

  describe('§1.1.6 nothing changes', () => {
    it('when the venue holds at least the deal base', async () => {
      const { bot } = buildBot(259)
      await refuse(bot, refusedOrder(0.3237))
      expect(bot.probes).to.equal(1)
      expect(bot.events).to.have.length(0)
      await place(bot, [grid(0.3237)])
      expect(sentPrices()).to.deep.equal([0.3237])
    })
    it('in the deal books on a shortfall', async () => {
      const { bot, full } = buildBot(99)
      await refuse(bot, refusedOrder(0.3237))
      expect(full.deal.currentBalances).to.deep.equal({
        base: 259,
        quote: 14.8,
      })
      expect(full.deal.avgPrice).to.equal(0.2953)
      expect(bot.closes).to.have.length(0)
    })
    it('and a reading without a shortfall ends the episode', async () => {
      const { bot } = buildBot(99)
      await refuse(bot, refusedOrder(0.3237))
      expect(bot.events).to.have.length(1)
      bot.gridShortfallHolds.clear()
      bot.positions[0].positionAmt = '259'
      await refuse(bot, refusedOrder(0.3237))
      expect(bot.events).to.have.length(1)
      bot.positions[0].positionAmt = '99'
      await refuse(bot, refusedOrder(0.3237))
      expect(bot.events).to.have.length(2)
    })
    it('for an opening-side refusal', async () => {
      const { bot } = buildBot(99)
      await refuse(bot, refusedOrder(0.2633, 'BUY'))
      expect(bot.probes).to.equal(0)
      expect(bot.events).to.have.length(0)
    })
  })
})
