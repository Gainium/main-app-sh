process.env.NODE_ENV = 'testing'

/**
 * A futures deal whose position the venue closed without the bot: priced from
 * the venue's account fills (`venueCloseEvidence`), and the two engine paths
 * that use it.
 *
 * The case: a 0.26 short opened at 760.63 on a Kraken perpetual was liquidated
 * in nine chunks (8 × 0.03 + 0.02) at 876.20–883.00. The chunks reached no
 * engine (the user stream flagged none of them as a liquidation), the resting
 * take profit was then refused `wouldNotReducePosition`, and the deal was left
 * open until the user stopped the bot, which booked it at roughly zero. The
 * real close is 0.26 at about 879.35, a loss of about 30.9 before fees.
 *
 * Spec `277` (see `specs/277.futures-deal-closed-outside-the-bot.md`) adds the
 * Bitget fill shape, the "position already closed" close, the one-hour gate on
 * the resting take-profit path and the "profit unknown" close.
 *
 * Run: npx mocha -r ts-node/register src/bot/dca/venueCloseEvidence.spec.ts
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import RedisClient from '../../db/redis'
import { isForcedCloseFillType, venueCloseEvidence } from './venueCloseEvidence'
import {
  DCACloseTriggerEnum,
  DCADealFlags,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
  type AccountFill,
  type Order,
} from '../../../types'

const SYMBOL = 'ZEC-USD'
const DEAL_ID = '000000000000000000000d77'
const DEAL_OPEN = Date.parse('2026-11-22T03:03:40Z')
const DEAL_QTY = 0.26

const at = (iso: string) => Date.parse(`${iso}Z`)

/** The nine liquidation chunks, as the venue's account fills report them. */
const LIQUIDATION: AccountFill[] = [
  ['2026-11-23T14:16:38.015', 877.27, 0.03],
  ['2026-11-23T14:16:52.669', 876.2, 0.03],
  ['2026-11-23T14:17:06.301', 876.86, 0.03],
  ['2026-11-23T14:17:19.478', 878.05, 0.03],
  ['2026-11-23T14:17:31.196', 880.31, 0.03],
  ['2026-11-23T14:17:43.121', 879.04, 0.03],
  ['2026-11-23T14:17:54.361', 882.06, 0.03],
  ['2026-11-23T14:18:05.896', 883, 0.03],
  ['2026-11-23T14:18:18.350', 882.35, 0.02],
].map(([t, price, qty], i) => ({
  fillId: `liq-fill-${i}`,
  orderId: `liq-order-${i}`,
  clientOrderId: '',
  symbol: SYMBOL,
  side: 'BUY',
  price: `${price}`,
  quantity: `${qty}`,
  timestamp: at(t as string),
  fillType: 'liquidation',
}))

/** The deal's own entry, and the previous deal's take profit. Ours: excluded. */
const OWN: AccountFill[] = [
  {
    fillId: 'own-entry',
    orderId: 'own-entry',
    clientOrderId: 'D-BO-entry',
    symbol: SYMBOL,
    side: 'SELL',
    price: '760.63',
    quantity: '0.26',
    timestamp: at('2026-11-22T03:03:39.571'),
    fillType: 'maker',
  },
  {
    fillId: 'own-prev-tp',
    orderId: 'own-prev-tp',
    clientOrderId: 'D-TP-previous',
    symbol: SYMBOL,
    side: 'BUY',
    price: '760.74',
    quantity: '0.25',
    timestamp: at('2026-11-22T03:03:38.004'),
    fillType: 'maker',
  },
]

/** An earlier liquidation of an older position: before this deal opened. */
const OLDER_LIQUIDATION: AccountFill = {
  ...LIQUIDATION[0],
  fillId: 'old-liq',
  orderId: 'old-liq',
  price: '788.49',
  quantity: '0.08',
  timestamp: at('2026-11-21T13:23:25.973'),
}

const FILLS_NEWEST_FIRST = [...LIQUIDATION, ...OWN, OLDER_LIQUIDATION].sort(
  (a, b) => b.timestamp - a.timestamp,
)

const EXPECTED_PRICE =
  LIQUIDATION.reduce((s, f) => s + +f.price * +f.quantity, 0) / DEAL_QTY

const evidenceFor = (fills: AccountFill[], dealQty = DEAL_QTY) =>
  venueCloseEvidence(fills, {
    symbol: SYMBOL,
    closeSide: 'BUY',
    sinceMs: DEAL_OPEN,
    dealQty,
  })

describe('pricing a deal closed by the venue from its account fills', () => {
  it('the reported case: nine liquidation chunks price the whole close', () => {
    const e = evidenceFor(FILLS_NEWEST_FIRST)
    expect(e).to.not.equal(undefined)
    expect(e!.fills).to.equal(9)
    expect(e!.qty).to.be.closeTo(DEAL_QTY, 1e-9)
    expect(e!.price).to.be.closeTo(EXPECTED_PRICE, 1e-6)
    expect(e!.price).to.be.closeTo(879.35, 0.01)
    expect(e!.liquidation).to.equal(true)
  })

  it('the bot’s own fills and fills from before the deal are never counted', () => {
    const e = evidenceFor(FILLS_NEWEST_FIRST)
    // Had the older 788.49 chunk or the 760.74 take profit leaked in, the
    // average would move well off the nine chunks' own.
    expect(e!.price).to.be.closeTo(EXPECTED_PRICE, 1e-6)
  })

  it('a partial record prices nothing', () => {
    expect(evidenceFor(LIQUIDATION.slice(0, 5))).to.equal(undefined)
  })

  it('no fills, or a deal with no size, prices nothing', () => {
    expect(evidenceFor([])).to.equal(undefined)
    expect(evidenceFor(FILLS_NEWEST_FIRST, 0)).to.equal(undefined)
  })

  it('a hand close on the exchange (no client id) counts, and is not a liquidation', () => {
    const hand = LIQUIDATION.map((f) => ({ ...f, fillType: 'taker' }))
    const e = evidenceFor(hand)
    expect(e!.qty).to.be.closeTo(DEAL_QTY, 1e-9)
    expect(e!.liquidation).to.equal(false)
  })

  it('stops at the deal’s size, newest first', () => {
    const e = evidenceFor(FILLS_NEWEST_FIRST, 0.05)
    // The last chunk (0.02 @ 882.35) and 0.03 of the one before (883).
    expect(e!.qty).to.be.closeTo(0.05, 1e-9)
    expect(e!.price).to.be.closeTo((0.02 * 882.35 + 0.03 * 883) / 0.05, 1e-6)
  })

  it('spec 277 §1.5: Bitget — API fills are the bot’s, a hand close and a liquidation are not', () => {
    // Bitget fills carry no client order id; `source` says who placed them.
    const bitget = (over: Partial<AccountFill>): AccountFill => ({
      ...LIQUIDATION[0],
      fillType: 'close',
      quantity: '0.26',
      price: '870',
      ...over,
    })
    expect(evidenceFor([bitget({ source: 'API' })]), 'a bot order').to.equal(
      undefined,
    )
    const hand = evidenceFor([bitget({ source: 'WEB', fee: '0.11' })])
    expect(hand!.liquidation).to.equal(false)
    expect(hand!.fee).to.be.closeTo(0.11, 1e-12)
    const liq = evidenceFor([
      bitget({ source: 'SYS', fillType: 'burst_close_short', fee: '0.2' }),
    ])
    expect(liq!.liquidation).to.equal(true)
    // One fill without a fee: the fee of the close is not known.
    const mixed = evidenceFor([
      bitget({ source: 'WEB', quantity: '0.13', fee: '0.1' }),
      bitget({ source: 'WEB', quantity: '0.13', fillId: 'x' }),
    ])
    expect(mixed!.fee).to.equal(undefined)
  })

  it('forced-close fill types', () => {
    for (const t of [
      'liquidation',
      'PartialLiquidation',
      'unwindBankrupt',
      'unwindCounterparty',
      'burst_close_long',
      'burst_sell_single',
      'dte_sys_adl_close_long',
    ]) {
      expect(isForcedCloseFillType(t), t).to.equal(true)
    }
    for (const t of [
      'maker',
      'taker',
      'assignee',
      'assignor',
      'close',
      'close_long',
      'sell_single',
      '',
      undefined,
    ]) {
      expect(isForcedCloseFillType(t), `${t}`).to.equal(false)
    }
  })
})

class FakeBase {
  botId = '000000000000000000000b77'
  userId = '000000000000000000000477'
  botType = 'dca'
  loadingComplete = true
  data: any = {
    settings: { type: 'regular', pair: [SYMBOL] },
    exchange: ExchangeEnum.krakenUsdm,
    paperContext: false,
    flags: [],
  }
  get futures() {
    return true
  }
  get isLong() {
    return false
  }
  get kucoinFullFutures() {
    return false
  }
  get hedge() {
    return false
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const chunk = (i: number): Order =>
  ({
    symbol: SYMBOL,
    orderId: LIQUIDATION[i].orderId,
    clientOrderId: LIQUIDATION[i].orderId,
    updateTime: LIQUIDATION[i].timestamp,
    price: LIQUIDATION[i].price,
    origQty: '0',
    executedQty: '0',
    status: 'FILLED',
    type: 'LIMIT',
    side: OrderSideEnum.buy,
    typeOrder: TypeOrderEnum.liquidation,
    liquidation: true,
  }) as unknown as Order

/**
 * A short bot holding the deal. `venue.held` is what the position read answers
 * (`undefined` = the venue did not answer); `venue.fills` the account fills.
 */
const buildBot = (venue: {
  held?: string
  fills: AccountFill[]
  combo?: boolean
}) => {
  const calls = {
    closeAll: [] as any[],
    closeById: [] as any[],
    closeDeal: [] as any[],
    events: [] as any[],
    errors: [] as string[],
    saved: [] as any[],
  }
  let open = true
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL, baseAsset: 'ZEC', quoteAsset: 'USD' },
      createTime: DEAL_OPEN,
      size: DEAL_QTY,
      flags: [DCADealFlags.newMultiTp],
    },
  }
  class TestBot extends Helper {
    calls = calls
    combo = !!venue.combo
    saveDeal(_d: any, update: any) {
      calls.saved.push(update)
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.0005 }
    }
    async profitBase() {
      return false
    }
    // A field on the helper, so it has to be set here, not on the base.
    isLong = false
    exchange = {
      futures_getPositions: async () =>
        venue.held === undefined
          ? { status: StatusEnum.notok, reason: 'timeout', data: null }
          : {
              status: StatusEnum.ok,
              data:
                venue.held === '0'
                  ? []
                  : [
                      {
                        symbol: SYMBOL,
                        positionAmt: `-${venue.held}`,
                        positionSide: 'BOTH',
                      },
                    ],
            },
      getAccountFills: async () => ({
        status: StatusEnum.ok,
        data: venue.fills,
        reason: null,
      }),
    }
    getOpenDeals() {
      return open ? [deal] : []
    }
    getDeal() {
      return open ? deal : undefined
    }
    async closeAllDeals(...args: any[]) {
      calls.closeAll.push(args)
      open = false
    }
    async closeDealById(...args: any[]) {
      calls.closeById.push(args)
      open = false
    }
    async closeDeal(...args: any[]) {
      calls.closeDeal.push(args)
      open = false
    }
    async linkLiquidationOrderToDeals() {}
    async getLatestPrice() {
      return 1
    }
    botEventDb = {
      createData: (e: any) => calls.events.push(e),
    }
    async handleErrors(msg: string) {
      calls.errors.push(msg)
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
  }
  return new TestBot() as any
}

describe('the engine', () => {
  const store = new Map<string, string>()
  let previousGetInstance: any
  before(function () {
    // One ts-node compile of a very large module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
    // The take-profit back-off windows live in Redis.
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
  })
  after(() => {
    ;(RedisClient as any).getInstance = previousGetInstance
  })

  describe('a liquidation the venue runs in chunks', () => {
    it('a chunk while the venue still holds the position closes nothing yet', async () => {
      const bot = buildBot({ held: '0.23', fills: FILLS_NEWEST_FIRST })
      await bot.processLiquidationOrder(chunk(0))
      expect(bot.calls.closeAll).to.have.length(0)
      expect(bot.liquidationSettleMap().has(SYMBOL), 'a re-check is armed').to
        .be.true
      bot.clearLiquidationSettle(SYMBOL)
    })

    it('the chunk that empties the position closes the deal at the price of every chunk', async () => {
      const bot = buildBot({ held: '0', fills: FILLS_NEWEST_FIRST })
      await bot.processLiquidationOrder(chunk(8))
      expect(bot.calls.closeAll).to.have.length(1)
      const args = bot.calls.closeAll[0]
      expect(args[1]).to.equal(SYMBOL)
      // Not the last chunk's 882.35: all nine, volume weighted.
      expect(args[6]).to.be.closeTo(EXPECTED_PRICE, 1e-6)
      expect(args[7]).to.equal(DCACloseTriggerEnum.liquidation)
      expect(bot.liquidationSettleMap().has(SYMBOL)).to.be.false
    })

    it('a venue that does not answer the position read closes on the report, as before', async () => {
      const bot = buildBot({ held: undefined, fills: [] })
      await bot.processLiquidationOrder(chunk(8))
      expect(bot.calls.closeAll).to.have.length(1)
      expect(bot.calls.closeAll[0][6]).to.equal(882.35)
    })

    it('a liquidation that stops part way leaves the deal open on the rest, and says so', async () => {
      const bot = buildBot({ held: '0.1', fills: FILLS_NEWEST_FIRST })
      const order = chunk(3)
      await bot.processLiquidationOrder(order)
      // The armed re-checks, run by hand rather than on the timer.
      for (let i = 0; i < 8; i++) {
        await bot.processLiquidationOrder(order)
      }
      expect(bot.calls.closeAll).to.have.length(0)
      expect(bot.liquidationSettleMap().has(SYMBOL)).to.be.false
      expect(bot.calls.errors.join(' ')).to.contain('still open')
    })
  })

  describe('a resting take profit refused because the position is gone', () => {
    const refuse = async (fills: AccountFill[], firstSeenAgoMs = 0) => {
      store.clear()
      const bot = buildBot({ held: '0', fills })
      if (firstSeenAgoMs) {
        // An episode whose first "no position" reading is that old.
        await bot.checkRefusedRestingTpPosition(
          bot.getDeal(DEAL_ID),
          'wouldNotReducePosition',
        )
        for (const [k, v] of store) {
          const st = JSON.parse(v)
          if (st.firstAt) {
            store.set(
              k,
              JSON.stringify({
                ...st,
                firstAt: st.firstAt - firstSeenAgoMs,
                until: 0,
              }),
            )
          }
        }
        bot.calls.events.length = 0
      }
      const reconciled: any[] = []
      bot.reconcileDealPosition = async (...args: any[]) => {
        reconciled.push(args)
        return false
      }
      await bot.checkRefusedRestingTpPosition(
        bot.getDeal(DEAL_ID),
        'wouldNotReducePosition',
      )
      return { bot, reconciled }
    }

    it('spec 277 §1.3: the first "no position" reading holds the take profit and closes nothing, even with fills', async () => {
      const { reconciled } = await refuse(FILLS_NEWEST_FIRST)
      expect(reconciled).to.have.length(0)
    })

    it('the reported case: an hour after the first reading, with the venue fills, it reconciles the deal closed, no "close manually" warning', async () => {
      const { bot, reconciled } = await refuse(
        FILLS_NEWEST_FIRST,
        61 * 60 * 1000,
      )
      expect(reconciled).to.have.length(1)
      expect(reconciled[0][3]?.describesItself, 'its own settle').to.equal(true)
      expect(
        bot.calls.events.filter((e: any) =>
          `${e.description}`.includes('close this deal manually'),
        ),
      ).to.have.length(0)
    })

    it('without venue fills the first reading keeps the spec 143 warning and leaves the deal open', async () => {
      const { bot, reconciled } = await refuse([])
      expect(reconciled).to.have.length(0)
      expect(bot.calls.events).to.have.length(1)
      // Spec 277 §1.3: no longer asks the user to close it by hand.
      expect(bot.calls.events[0].description).to.contain(
        'closes the deal itself',
      )
    })

    it('spec 277 §1.3: without venue fills, an hour after the first reading it reconciles too (the settle books "profit unknown")', async () => {
      const { reconciled } = await refuse([], 61 * 60 * 1000)
      expect(reconciled).to.have.length(1)
      expect(reconciled[0][3]?.describesItself).to.equal(true)
    })

    it('spec 277 §1.3: under an hour after the first reading, nothing is reconciled', async () => {
      const { reconciled } = await refuse([], 30 * 60 * 1000)
      expect(reconciled).to.have.length(0)
    })

    it('spec 277 §1.4: the settle CLOSES the deal at the venue fills, as a liquidation, and says so', async () => {
      const bot = buildBot({ held: '0', fills: FILLS_NEWEST_FIRST })
      const settle = bot.settleFromVenueFills(DEAL_ID)
      expect(settle.describesItself).to.equal(true)
      await settle()
      // `closeDealById(leave, …)` cancelled the orders and returned with the
      // deal still open; the close goes to `closeDeal` at the fills' price.
      expect(bot.calls.closeById).to.have.length(0)
      expect(bot.calls.closeDeal).to.have.length(1)
      const args = bot.calls.closeDeal[0]
      expect(args[1]).to.equal(DEAL_ID)
      expect(args[2]).to.equal(undefined)
      expect(args[3], 'priced from the fills').to.be.closeTo(
        EXPECTED_PRICE,
        1e-6,
      )
      // Kraken fills carry no fee: the close leg is the taker estimate.
      expect(args[4]).to.be.closeTo(EXPECTED_PRICE * DEAL_QTY * 0.0005, 1e-9)
      const saved = bot.calls.saved.find((u: any) => u.flags)
      expect(saved.flags).to.include(DCADealFlags.closedExternally)
      expect(saved.flags).to.not.include(DCADealFlags.profitUnknown)
      expect(saved.flags).to.include(DCADealFlags.newMultiTp)
      expect(saved.closeTrigger).to.equal(DCACloseTriggerEnum.liquidation)
      expect(bot.calls.events).to.have.length(1)
      expect(bot.calls.events[0].description).to.contain('liquidated')
    })

    it('spec 277 §1.1: no fills that cover the deal: closed as "profit unknown", flagged, and the user is told', async () => {
      const bot = buildBot({ held: '0', fills: [] })
      await bot.settleFromVenueFills(DEAL_ID)()
      expect(bot.calls.closeById).to.have.length(0)
      expect(bot.calls.closeDeal).to.have.length(1)
      expect(bot.calls.closeDeal[0].slice(1)).to.deep.equal([DEAL_ID])
      const saved = bot.calls.saved.find((u: any) => u.flags)
      expect(saved.flags).to.include.members([
        DCADealFlags.closedExternally,
        DCADealFlags.profitUnknown,
      ])
      expect(bot.calls.events).to.have.length(1)
      expect(bot.calls.events[0].description).to.contain('profit is unknown')
    })
  })

  describe('spec 277 §1.1/§1.2: a closing order refused because the position is already closed', () => {
    it('a DCA deal is settled as an outside close, from the venue fills', async () => {
      const bot = buildBot({ held: '0', fills: FILLS_NEWEST_FIRST })
      await bot.closeDealWhosePositionIsGone(DEAL_ID, DCACloseTriggerEnum.tp)
      expect(bot.calls.closeDeal).to.have.length(1)
      expect(bot.calls.closeDeal[0][3]).to.be.closeTo(EXPECTED_PRICE, 1e-6)
      expect(bot.calls.events[0].description).to.contain('liquidated')
    })

    it('a combo deal whose base minigrid completed closes exactly as before: no flag, no message', async () => {
      const bot = buildBot({ held: '0', fills: [], combo: true })
      await bot.closeDealWhosePositionIsGone(DEAL_ID, DCACloseTriggerEnum.base)
      expect(bot.calls.closeDeal).to.have.length(1)
      expect(bot.calls.closeDeal[0].slice(1)).to.deep.equal([DEAL_ID])
      expect(bot.calls.saved.filter((u: any) => u.flags)).to.have.length(0)
      expect(bot.calls.events).to.have.length(0)
    })

    it('the reported combo case: the venue said the deal is flat (spec 175) — "profit unknown" when no fills cover it', async () => {
      const bot = buildBot({ held: '0', fills: [], combo: true })
      bot.markPositionClosedOutside(DEAL_ID)
      await bot.closeDealWhosePositionIsGone(DEAL_ID, DCACloseTriggerEnum.base)
      expect(bot.calls.closeDeal).to.have.length(1)
      const saved = bot.calls.saved.find((u: any) => u.flags)
      expect(saved.flags).to.include(DCADealFlags.profitUnknown)
      expect(bot.calls.events[0].description).to.contain('profit is unknown')
    })

    it('a spot deal closes exactly as before', async () => {
      const bot = buildBot({ held: '0', fills: FILLS_NEWEST_FIRST })
      Object.defineProperty(bot, 'futures', { get: () => false })
      await bot.closeDealWhosePositionIsGone(DEAL_ID, DCACloseTriggerEnum.tp)
      expect(bot.calls.closeDeal[0].slice(1)).to.deep.equal([DEAL_ID])
      expect(bot.calls.events).to.have.length(0)
    })
  })
})
