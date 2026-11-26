process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `285.one-way-opposite-safety-orders-and-unreadable-position`.
 *
 * On a one-way futures account the venue keeps ONE net position per symbol.
 * A LONG and a SHORT deal of two bots of the same user on the same symbol
 * net each other's position through their safety orders: production order
 * rows show a SHORT deal's two safety orders filling while the LONG deal was
 * open, taking the net position from +0.045 to -0.002, and the LONG deal's
 * close then refused as `wouldNotReducePosition`.
 *
 * Drives the REAL `holdSafetyOrderAgainstOpposingPosition`,
 * `placeOrdersHoldingDealLock`, `retryOpposingSafetyLevels`,
 * `refuseNewDealAgainstOpposingPosition` and `hasOpposingBotOnSymbol` off the
 * DCA helper over a fake base. DB reads are stubbed at the DAO. Fixture ids
 * are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { comboBotDb, dcaBotDb } from '../../db/dbInit'
import {
  BotStatusEnum,
  BotType,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StartConditionEnum,
  StatusEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../../types'
import { ConditionLatch } from '../conditionLatch'
import { opposingHold, OPPOSING_POSITION_RETRY_MS } from './opposingNetPosition'

const BOT_ID = '000000000000000000000b85'
const OTHER_BOT_ID = '000000000000000000000c85'
const DEAL_ID = '000000000000000000000d85'
const OTHER_DEAL_ID = '000000000000000000000e85'
const PAIR = 'ETH-USD'

const position = (amt: number) => ({
  symbol: PAIR,
  positionAmt: `${amt}`,
  positionSide: 'BOTH',
})

/** A LONG deal's safety level (adds to the long). */
const so = (
  price: number,
  dcaLevel: number,
  id = `D-RO-so285-${dcaLevel}`,
) => ({
  number: dcaLevel,
  price,
  qty: 0.013,
  side: OrderSideEnum.buy,
  newClientOrderId: id,
  type: TypeOrderEnum.dealRegular,
  dealId: DEAL_ID,
  dcaLevel,
})

class FakeBase {
  botId = BOT_ID
  userId = '000000000000000000000485'
  botType = 'dca'
  hyperliquid = false
  standingConditionLatch = new ConditionLatch(60 * 60 * 1000)
  data: any = {
    status: BotStatusEnum.open,
    settings: {
      type: 'regular',
      pair: [PAIR],
      startCondition: StartConditionEnum.asap,
    },
    exchange: ExchangeEnum.krakenUsdm,
    exchangeUUID: 'uuid-285',
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Venue =
  | { kind: 'positions'; positions: any[] }
  | { kind: 'notok' }
  | { kind: 'throws' }

type Opts = {
  venue?: Venue
  holder?: any
  oppositeBot?: boolean
  hedge?: boolean
  futures?: boolean
  botType?: string
  currentOrders?: any[]
}

const buildBot = ({
  venue = { kind: 'positions', positions: [] },
  holder = null,
  oppositeBot = false,
  hedge = false,
  futures = true,
  botType = 'dca',
  currentOrders = [],
}: Opts) => {
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: PAIR },
      settings: {},
      tpSlTargetFilled: [],
    },
    currentOrders,
    closeBySl: false,
    closeByTp: false,
  }
  let minted = 0
  class TestBot extends Helper {
    placed: string[] = []
    logs: string[] = []
    events: any[] = []
    userRefusals: string[] = []
    positionReads = 0
    holderCalls = 0
    botLookups = 0
    isLong = true
    hedge = hedge
    futures = futures
    botType = botType
    combo = false
    orders = new Map<string, any>()
    stopList = new Set<string>()
    allowToPlaceOrders = new Map()
    openNewDealTimer = new Map()
    ordersInBetweenUpdates = new Set<string>()
    reissuedClientOrderIds = new Map<string, string>()
    botEventDb = {
      createData: (e: any) => {
        this.events.push(e)
      },
    }
    exchange: any = {
      futures_getPositions: async () => {
        this.positionReads += 1
        if (venue.kind === 'throws') throw new Error('socket hang up')
        if (venue.kind === 'notok')
          return { status: StatusEnum.notok, reason: 'timeout', data: null }
        return { status: StatusEnum.ok, data: venue.positions }
      },
    }
    async findOpposingDealHolder() {
      this.holderCalls += 1
      return holder
    }
    async hasOpposingBotOnSymbol() {
      this.botLookups += 1
      return oppositeBot
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    dealReleased() {
      return false
    }
    getOrdersByStatusAndDealId() {
      return [...this.orders.values()].filter((o) =>
        ['NEW', 'PARTIALLY_FILLED'].includes(o.status),
      )
    }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    getOrderId(prefix: string) {
      minted++
      return `${prefix}-minted${String(minted).padStart(20, '0')}`
    }
    async getExchangeInfo() {
      return {
        pair: PAIR,
        baseAsset: { name: 'ETH', minAmount: 0.001, step: 0.001 },
        quoteAsset: { name: 'USD', minAmount: 1 },
        priceAssetPrecision: 1,
      }
    }
    async getAggregatedSettings() {
      return this.data.settings
    }
    async reportUserRefusal(m: string) {
      this.userRefusals.push(m)
    }
    async openDealAfterTimer() {}
    batchablePlacements() {
      return []
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    async sendGridToExchange(order: any) {
      this.placed.push(order.newClientOrderId)
      const placed = {
        clientOrderId: order.newClientOrderId,
        dealId: DEAL_ID,
        typeOrder: order.type,
        side: order.side === OrderSideEnum.buy ? 'BUY' : 'SELL',
        price: `${order.price}`,
        origPrice: `${order.price}`,
        origQty: `${order.qty}`,
        executedQty: '0',
        status: 'NEW',
        dcaLevel: order.dcaLevel,
      }
      this.orders.set(order.newClientOrderId, placed)
      return placed
    }
    processFilledOrder() {}
    async primeCancelBatch() {}
    clearCancelBatch() {}
    async cancelOrderOnExchange() {}
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug(m: string) {
      this.logs.push(m)
    }
    handleWarn(m: string) {
      this.logs.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot() as any
}

const place = (bot: any, grids: any[]) =>
  bot.placeOrdersHoldingDealLock(BOT_ID, PAIR, DEAL_ID, {
    new: grids,
    cancel: [],
  })

const OPPOSITE_DEAL = {
  dealId: OTHER_DEAL_ID,
  botId: OTHER_BOT_ID,
  botName: 'Short ETH',
  botStopped: false,
}

const bots: any[] = []
const make = (o: Opts) => {
  const b = buildBot(o)
  bots.push(b)
  return b
}

describe('one-way futures: safety orders against an opposite deal, unreadable venue (spec 285)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  afterEach(() => {
    for (const b of bots.splice(0)) {
      for (const h of b.opposingSafetyHeld.values()) clearTimeout(h.timer)
      for (const t of b.openNewDealTimer.values()) clearTimeout(t)
    }
  })

  describe('§4.0 the hold decision (pure)', () => {
    const base = { symbol: PAIR, side: 'LONG' as const }
    it('§1.1.4 an open opposite deal holds even when the venue is flat', () => {
      expect(
        opposingHold({
          ...base,
          dealHolder: true,
          oppositeBot: true,
          probe: { kind: 'positions', positions: [] },
        }),
      ).to.deep.equal({ hold: true, why: 'deal', heldSide: 'SHORT' })
    })
    it('a venue net position on the other side holds', () => {
      expect(
        opposingHold({
          ...base,
          dealHolder: false,
          oppositeBot: false,
          probe: { kind: 'positions', positions: [position(-0.015)] },
        }),
      ).to.deep.equal({ hold: true, why: 'venue', heldSide: 'SHORT' })
    })
    it('§1.1.3 unreadable holds only with an opposite-direction bot', () => {
      const probe = { kind: 'unavailable' as const }
      expect(
        opposingHold({ ...base, dealHolder: false, oppositeBot: true, probe }),
      ).to.deep.equal({ hold: true, why: 'unreadable', heldSide: null })
      expect(
        opposingHold({ ...base, dealHolder: false, oppositeBot: false, probe }),
      ).to.deep.equal({ hold: false })
    })
    it('flat or own side allows', () => {
      for (const positions of [[], [position(0.03)]]) {
        expect(
          opposingHold({
            ...base,
            dealHolder: false,
            oppositeBot: true,
            probe: { kind: 'positions', positions },
          }),
        ).to.deep.equal({ hold: false })
      }
    })
  })

  describe('§4.1 holdSafetyOrderAgainstOpposingPosition', () => {
    it('§5 a one-direction bot: no venue read, no hold', async () => {
      const bot = make({ venue: { kind: 'notok' } })
      expect(await bot.holdSafetyOrderAgainstOpposingPosition(PAIR)).to.equal(
        false,
      )
      expect(bot.positionReads).to.equal(0)
      expect(bot.events).to.have.lengthOf(0)
    })
    it('§1.1.1 an open opposite deal holds without a venue read, warns once', async () => {
      const bot = make({ holder: OPPOSITE_DEAL })
      expect(await bot.holdSafetyOrderAgainstOpposingPosition(PAIR)).to.equal(
        true,
      )
      expect(bot.positionReads).to.equal(0)
      expect(bot.events).to.have.lengthOf(1)
      expect(bot.events[0].description).to.include(OTHER_DEAL_ID)
      // §4.1.1 cached for the retry window: no second lookup, no second warning.
      expect(await bot.holdSafetyOrderAgainstOpposingPosition(PAIR)).to.equal(
        true,
      )
      expect(bot.holderCalls).to.equal(1)
      expect(bot.events).to.have.lengthOf(1)
    })
    it('opposite bot, venue net opposite: held', async () => {
      const bot = make({
        oppositeBot: true,
        venue: { kind: 'positions', positions: [position(-0.015)] },
      })
      expect(await bot.holdSafetyOrderAgainstOpposingPosition(PAIR)).to.equal(
        true,
      )
      expect(bot.positionReads).to.equal(1)
    })
    for (const venue of [{ kind: 'notok' }, { kind: 'throws' }] as Venue[]) {
      it(`§1.1.3 opposite bot, venue ${venue.kind}: held`, async () => {
        const bot = make({ oppositeBot: true, venue })
        expect(await bot.holdSafetyOrderAgainstOpposingPosition(PAIR)).to.equal(
          true,
        )
        expect(bot.events[0].description).to.include('could not be read')
      })
    }
    it('opposite bot, venue on this side: placed', async () => {
      const bot = make({
        oppositeBot: true,
        venue: { kind: 'positions', positions: [position(0.03)] },
      })
      expect(await bot.holdSafetyOrderAgainstOpposingPosition(PAIR)).to.equal(
        false,
      )
    })
    it('§5 hedge accounts, spot and grid bots are never checked', async () => {
      for (const o of [
        { hedge: true },
        { futures: false },
        { botType: BotType.grid },
      ]) {
        const bot = make({ ...o, holder: OPPOSITE_DEAL })
        expect(await bot.holdSafetyOrderAgainstOpposingPosition(PAIR)).to.equal(
          false,
        )
        expect(bot.holderCalls).to.equal(0)
      }
    })
  })

  describe('§4.2 placeOrdersHoldingDealLock', () => {
    it('held: the LONG buys are not sent, and are re-armed', async () => {
      const bot = make({ holder: OPPOSITE_DEAL })
      await place(bot, [so(1642.8, 3), so(1592.7, 4)])
      expect(bot.placed, bot.logs.join('\n')).to.deep.equal([])
      expect(bot.opposingSafetyHeld.get(DEAL_ID).levels).to.have.lengthOf(2)
    })
    it('§5 not held: placed exactly as before', async () => {
      const bot = make({})
      await place(bot, [so(1642.8, 3)])
      expect(bot.placed).to.deep.equal(['D-RO-so285-3'])
      expect(bot.opposingSafetyHeld.size).to.equal(0)
    })
    it('a pass with no position-adding order never asks', async () => {
      const bot = make({ holder: OPPOSITE_DEAL })
      await place(bot, [])
      expect(bot.holderCalls).to.equal(0)
    })
    it('§1.1.2 the retry places only the levels the ladder still wants', async () => {
      const want = so(1642.8, 3)
      const bot = make({ holder: OPPOSITE_DEAL, currentOrders: [want] })
      await place(bot, [so(1642.8, 3), so(1592.7, 4)])
      expect(bot.placed).to.deep.equal([])
      // The opposite deal closed; the hold window has passed.
      bot.opposingSafetyHoldUntil.clear()
      bot.findOpposingDealHolder = async () => null
      clearTimeout(bot.opposingSafetyHeld.get(DEAL_ID).timer)
      await bot.retryOpposingSafetyLevels(DEAL_ID)
      expect(bot.placed, bot.logs.join('\n')).to.have.lengthOf(1)
      expect(bot.orders.get(bot.placed[0]).price).to.equal('1642.8')
      expect(bot.opposingSafetyHeld.size).to.equal(0)
    })
    it('the retry is armed for the retry window', () => {
      expect(OPPOSING_POSITION_RETRY_MS).to.equal(60_000)
    })
  })

  describe('§4.4 a new deal on an unreadable venue', () => {
    it('with an opposite-direction bot: refused, retried', async () => {
      const bot = make({ oppositeBot: true, venue: { kind: 'notok' } })
      expect(await bot.refuseNewDealAgainstOpposingPosition(PAIR)).to.equal(
        true,
      )
      expect(bot.openNewDealTimer.has(PAIR)).to.equal(true)
      expect(bot.events[0].description).to.include('could not be read')
    })
    it('manual open answered with the unreadable reason', async () => {
      const bot = make({ oppositeBot: true, venue: { kind: 'throws' } })
      expect(
        await bot.refuseNewDealAgainstOpposingPosition(PAIR, 'manual'),
      ).to.equal(true)
      expect(bot.userRefusals[0]).to.include('could not be read')
    })
    it('§5 without one: opens, as before', async () => {
      const bot = make({ oppositeBot: false, venue: { kind: 'notok' } })
      expect(await bot.refuseNewDealAgainstOpposingPosition(PAIR)).to.equal(
        false,
      )
      expect(bot.openNewDealTimer.size).to.equal(0)
    })
    it('a readable flat venue never asks for an opposite bot', async () => {
      const bot = make({ oppositeBot: true })
      expect(await bot.refuseNewDealAgainstOpposingPosition(PAIR)).to.equal(
        false,
      )
      expect(bot.botLookups).to.equal(0)
    })
  })

  describe('§4.1 hasOpposingBotOnSymbol query', () => {
    const saved: Record<string, any> = {}
    afterEach(() => {
      ;(dcaBotDb as any).readData = saved.dca
      ;(comboBotDb as any).readData = saved.combo
    })
    it('asks both bot collections for the opposite strategy on this pair and account', async () => {
      saved.dca = (dcaBotDb as any).readData
      saved.combo = (comboBotDb as any).readData
      const queries: any[] = []
      ;(dcaBotDb as any).readData = async (q: any) => {
        queries.push(q)
        return { status: StatusEnum.ok, data: { result: [] } }
      }
      ;(comboBotDb as any).readData = async (q: any) => {
        queries.push(q)
        return { status: StatusEnum.ok, data: { result: [{ _id: 'x' }] } }
      }
      const real = Helper.prototype.hasOpposingBotOnSymbol
      const bot = make({})
      expect(await real.call(bot, PAIR)).to.equal(true)
      expect(queries).to.have.lengthOf(2)
      expect(queries[0]['settings.strategy']).to.equal(StrategyEnum.short)
      expect(queries[0]['settings.pair']).to.equal(PAIR)
      expect(queries[0].exchangeUUID).to.equal('uuid-285')
      expect(queries[0]._id).to.deep.equal({ $ne: BOT_ID })
    })
  })
})
