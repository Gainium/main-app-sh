process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `306.a-quarantined-never-placed-order-is-never-retired`.
 *
 * A safety order whose placement never got an exchange id back keeps the
 * `'-1'` placeholder. Quarantine came first: it marked such an order and made
 * the restart probe skip it. Spec 109's retire came later and lives inside
 * `noteOrderNotFound`, which only the restart probe calls. So an order
 * quarantined before spec 109 was never asked about again, and the
 * user-stream reconnect pass, which does ask, parked the venue's definitive
 * "does not exist" as unresolved. The deal counted a safety order that was
 * never on the book.
 *
 * Drives the REAL `isOrderQuarantined` / `noteOrderNotFound` of MainBot and the
 * REAL `checkOrdersAfterReconnect` of the DCA, Combo and grid helpers. Venue,
 * DB and placement are stubbed on the instance.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import { DCADealStatusEnum, StatusEnum, TypeOrderEnum } from '../../types'

const BOT_ID = '000000000000000000000b06'
const DEAL_ID = '000000000000000000000d06'
const SYMBOL = 'TESTUSDT'
const ORDER_ID = 'x-TEST-RO-000000000000000000000306'
/** Old enough for every age floor (specs 109 / 177). */
const LONG_AGO = Date.now() - 30 * 24 * 60 * 60 * 1000
/** Quarantined before the retire existed. */
const QUARANTINE = {
  strikes: 3,
  firstAt: LONG_AGO,
  lastAt: LONG_AGO,
  since: LONG_AGO,
  reason: 'Order does not exist.',
  runId: `${LONG_AGO}`,
}
const ABSENT = 'Order does not exist.'
/** The bot's own answer, given without asking the venue (spec 184 §4.4). */
const OWN_ANSWER = 'Order not found: no exchange order id'

const neverPlaced = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: '-1',
    clientOrderId: ORDER_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    type: 'LIMIT',
    side: 'BUY',
    price: '0.006674',
    origPrice: '0.006674',
    origQty: '1498',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    updateTime: LONG_AGO,
    transactTime: LONG_AGO,
    quarantine: { ...QUARANTINE },
    ...over,
  }) as any

const loadModule = createRequire(__filename)
let Dca: any
let Combo: any
let Grid: any

class Base {
  constructor(..._a: any[]) {}
}
Object.setPrototypeOf(Base.prototype, (MainBot as any).prototype)

type Opts = {
  held?: any
  reason?: string
  dealStatus?: DCADealStatusEnum | null
  rebuilding?: boolean
}

/** An instance of `Cls` with venue, DB and placement replaced. */
const buildBot = (Cls: any, opts: Opts = {}) => {
  const {
    held = neverPlaced(),
    reason = ABSENT,
    dealStatus = DCADealStatusEnum.open,
    rebuilding = false,
  } = opts
  const persisted: any[] = []
  const placed: any[] = []
  const logs: string[] = []
  const warns: string[] = []
  const deal =
    dealStatus === null
      ? undefined
      : {
          deal: {
            _id: DEAL_ID,
            botId: BOT_ID,
            status: dealStatus,
            symbol: { symbol: SYMBOL, baseAsset: 'TEST', quoteAsset: 'USDT' },
            settings: {},
          },
        }
  const bot: any = Object.create(Cls.prototype)
  Object.assign(bot, {
    botId: BOT_ID,
    data: {
      _id: BOT_ID,
      status: 'open',
      exchange: 'binance',
      settings: { pair: [SYMBOL] },
      flags: [],
    },
    blockCheck: false,
    serviceRestart: false,
    reconcileViaSweep: false,
    reconcileBatch: null,
    orderStatuses: ['NEW', 'PARTIALLY_FILLED'],
    orders: new Map<string, any>([[held.clientOrderId, held]]),
    newlyQuarantined: [],
    quarantineSkipped: 0,
    orderCheckRunId: '',
    math: { round: (v: number) => v },
    persisted,
    placed,
    logs,
    warns,
  })
  Object.assign(bot, {
    shouldProceed: () => true,
    startMethod: () => '1',
    endMethod: () => undefined,
    handleLog: (m: string) => logs.push(m),
    handleDebug: () => undefined,
    handleWarn: (m: string) => warns.push(m),
    emit: () => true,
    spreadReconcileStart: async () => undefined,
    primeReconcileBatch: async () => undefined,
    adoptExchangeOrderId: async () => undefined,
    checkTpCoverage: async () => undefined,
    processOrdersAfterCheck: () => undefined,
    processFilledOrder: () => undefined,
    // The venue. Binance answers a client-id lookup of an order it never
    // received with -2013 "Order does not exist."
    getOrderForReconcile: async () => ({
      status: StatusEnum.notok,
      reason,
      data: null,
    }),
    getOrderFromMap: (id: string) => bot.orders.get(id),
    setOrder: (o: any) => bot.orders.set(o.clientOrderId, o),
    deleteOrder: (id: string) => bot.orders.delete(id),
    getOrdersByStatusAndDealId: () =>
      [...bot.orders.values()].filter((o: any) =>
        ['NEW', 'PARTIALLY_FILLED'].includes(o.status),
      ),
    updateOrderOnDb: (o: any) => persisted.push({ ...o }),
    getDeal: (id?: string) => (id === DEAL_ID ? deal : undefined),
    dealBookRebuildInFlight: () => rebuilding,
    baseAssetPrecision: async () => 8,
    getOrderId: (prefix: string) => `${prefix}-new`,
    placeOrders: async (
      _b: string,
      symbol: string,
      dealId: string,
      orders: { new: any[]; cancel: any[] },
    ) => {
      placed.push({ symbol, dealId, ...orders })
    },
  })
  return bot
}

describe('a quarantined never-placed order is not skipped (spec 306)', () => {
  it('§4.1 isOrderQuarantined does not skip a quarantined `-1` order', () => {
    const bot = buildBot(Base)
    expect(bot.isOrderQuarantined(neverPlaced())).to.equal(false)
    expect(bot.quarantineSkipped).to.equal(0)
  })

  it('§4.1 it still skips a quarantined order that has an exchange id', () => {
    const bot = buildBot(Base)
    expect(
      bot.isOrderQuarantined(neverPlaced({ orderId: '1000000306' })),
    ).to.equal(true)
    expect(bot.quarantineSkipped).to.equal(1)
  })

  it('§4.2 the restart probe answer then retires it, despite the quarantine', () => {
    const bot = buildBot(Base)
    const o = neverPlaced()
    expect(bot.noteOrderNotFound(o, ABSENT)).to.equal(true)
    expect(bot.persisted.map((p: any) => p.status)).to.deep.equal(['CANCELED'])
    expect(bot.orders.has(ORDER_ID)).to.equal(false)
  })

  it('§4.4 the bot’s own "no exchange order id" never retires it', () => {
    const bot = buildBot(Base)
    expect(bot.noteOrderNotFound(neverPlaced(), OWN_ANSWER)).to.equal(false)
    expect(bot.persisted).to.deep.equal([])
    expect(bot.orders.has(ORDER_ID)).to.equal(true)
  })
})

for (const [name, get] of [
  ['DCA', () => Dca],
  ['Combo', () => Combo],
] as const) {
  describe(`${name}: the reconnect pass retires and re-places a quarantined never-placed safety order (spec 306)`, () => {
    before(function () {
      // One ts-node compile of the 22k-line helper (and the combo mixin).
      this.timeout(300000)
      Dca ??= loadModule('./dcaHelper').default(Base as any)
      Combo ??= loadModule('./comboHelper').default()
    })

    it('§4.3 "does not exist" retires it, logs it, and places it again', async () => {
      const bot = buildBot(get())
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      expect(bot.persisted.map((p: any) => p.status), 'row').to.deep.equal([
        'CANCELED',
      ])
      expect(bot.orders.has(ORDER_ID), 'out of the map').to.equal(false)
      expect(
        bot.logs.some((l: string) =>
          l.includes(`Order ${ORDER_ID} never reached the exchange`),
        ),
        'retire logged',
      ).to.equal(true)
      expect(bot.placed, 'placed again').to.have.length(1)
      const [p] = bot.placed
      expect(p.dealId).to.equal(DEAL_ID)
      expect(p.symbol).to.equal(SYMBOL)
      expect(p.cancel).to.deep.equal([])
      expect(p.new).to.have.length(1)
      expect(p.new[0].price).to.equal(0.006674)
      expect(p.new[0].qty).to.equal(1498)
      expect(p.new[0].type).to.equal(TypeOrderEnum.dealRegular)
      expect(
        bot.warns.some((w: string) => w.includes('could not read')),
        'not reported as unresolved',
      ).to.equal(false)
      expect(bot.blockCheck, 'block released').to.equal(false)
    })

    it('§4.4 the bot’s own "no exchange order id" retires nothing', async () => {
      const bot = buildBot(get(), { reason: OWN_ANSWER })
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      expect(bot.persisted).to.deep.equal([])
      expect(bot.placed).to.deep.equal([])
      expect(bot.orders.has(ORDER_ID)).to.equal(true)
    })

    it('§4.5 an order with an exchange id is left to the quarantine', async () => {
      const bot = buildBot(get(), {
        held: neverPlaced({ orderId: '1000000306' }),
      })
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      expect(bot.persisted).to.deep.equal([])
      expect(bot.placed).to.deep.equal([])
      expect(bot.orders.has(ORDER_ID)).to.equal(true)
    })

    it('§4.6 a never-placed take-profit is left to the restart check', async () => {
      const bot = buildBot(get(), {
        held: neverPlaced({ typeOrder: TypeOrderEnum.dealTP, side: 'SELL' }),
      })
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      expect(bot.persisted).to.deep.equal([])
      expect(bot.placed).to.deep.equal([])
    })

    it('§4.7 a deal no longer open, or with its book being rebuilt, gets nothing placed', async () => {
      for (const [over, why] of [
        [{ dealStatus: null }, 'deal not held'],
        [{ dealStatus: DCADealStatusEnum.closed }, 'deal closed'],
        [{ rebuilding: true }, 'book rebuild in flight'],
      ] as const) {
        const bot = buildBot(get(), over as Opts)
        await bot.checkOrdersAfterReconnect(BOT_ID, false)
        expect(bot.persisted.map((p: any) => p.status), why).to.deep.equal([
          'CANCELED',
        ])
        expect(bot.placed, why).to.deep.equal([])
      }
    })
  })
}

describe('grid: the reconnect pass retires a quarantined never-placed order (spec 306)', () => {
  before(function () {
    this.timeout(300000)
    Grid ??= loadModule('./helper').default(Base as any)
  })

  const gridOrder = (over: Record<string, unknown> = {}) =>
    neverPlaced({
      dealId: undefined,
      typeOrder: TypeOrderEnum.regular,
      ...over,
    })

  it('§4.8 "does not exist" retires it', async () => {
    const bot = buildBot(Grid, { held: gridOrder() })
    await bot.checkOrdersAfterReconnect(BOT_ID)
    expect(bot.persisted.map((p: any) => p.status)).to.deep.equal(['CANCELED'])
    expect(bot.orders.has(ORDER_ID)).to.equal(false)
    expect(
      bot.warns.some((w: string) => w.includes('could not read')),
    ).to.equal(false)
  })

  it('§4.8 the bot’s own answer, or a real exchange id, retires nothing', async () => {
    for (const [over, why] of [
      [{ reason: OWN_ANSWER, held: gridOrder() }, 'own answer'],
      [{ held: gridOrder({ orderId: '1000000306' }) }, 'exchange id'],
    ] as const) {
      const bot = buildBot(Grid, over as Opts)
      await bot.checkOrdersAfterReconnect(BOT_ID)
      expect(bot.persisted, why).to.deep.equal([])
      expect(bot.orders.has(ORDER_ID), why).to.equal(true)
    }
  })
})
