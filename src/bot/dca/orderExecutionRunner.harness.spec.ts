process.env.NODE_ENV = 'testing'

/**
 * Spec 242 — the engine side of order execution modes, on the REAL DCA helper
 * mixin over a minimal base: split closes (§4.5, §6.3), the base-order split
 * (§6.5), the resting take-profit timeout (§4.2), the stop-loss close type
 * (§4.4), and the persisted state a restart resumes from.
 *
 * Exchange-facing calls are stubbed and recorded; timers are inspected and
 * cleared rather than awaited.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  TypeOrderEnum,
} from '../../../types'

class FakeBase {
  botId = '000000000000000000000b64'
  data: any = { settings: {} }
  constructor(..._a: any[]) {}
}

let Helper: any
before(() => {
  Helper = createRequire(__filename)('../dcaHelper').default(FakeBase as any)
})

type Calls = {
  reduce: any[]
  add: any[]
  close: any[]
  cancelled: string[]
  saved: any[]
}

const ED = {
  baseAsset: { step: 0.001, minAmount: 0.001, name: 'BTC' },
  quoteAsset: { minAmount: 5, name: 'USDT' },
  priceAssetPrecision: 2,
}

const make = (
  settings: Record<string, unknown>,
  opts: { orders?: any[]; last?: number; qty?: number } = {},
) => {
  const bot: any = Object.create(Helper.prototype)
  const calls: Calls = {
    reduce: [],
    add: [],
    close: [],
    cancelled: [],
    saved: [],
  }
  const deal: any = {
    deal: {
      _id: 'd1',
      status: DCADealStatusEnum.open,
      symbol: { symbol: 'BTCUSDT' },
      settings: {},
    },
  }
  bot.botId = 'b1'
  bot.data = { settings }
  bot.combo = false
  bot.isLong = true
  bot.useCompountReduce = false
  bot.allowToPlaceOrders = new Map()
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.handleDebug = () => undefined
  bot.getAggregatedSettings = async () => ({ ...settings })
  bot.getExchangeInfo = async () => ED
  bot.getDeal = () => deal
  bot.getOpenDeals = () => [deal]
  bot.getLastStreamData = () => ({ price: opts.last ?? 100 })
  bot.prepareTpOrder = async () => ({
    qty: opts.qty ?? 1,
    price: 103,
    side: 'SELL',
  })
  bot.getOrdersByStatusAndDealId = () => opts.orders ?? []
  bot.getOrderFromMap = (id: string) =>
    (opts.orders ?? []).find((o) => o.clientOrderId === id)
  bot.cancelOrderOnExchange = async (o: any) => {
    calls.cancelled.push(o.clientOrderId)
    return { ...o, status: 'CANCELED', executedQty: o.executedQty ?? '0' }
  }
  bot.handleUnknownOrder = async () => undefined
  let n = 0
  bot.reduceDealFunds = async (_b: string, _d: string, s: any) => {
    calls.reduce.push(s)
    bot.lastReduceOrderId = new Map([['d1', `R${++n}`]])
  }
  bot.addDealFunds = async (_b: string, _d: string, s: any) => {
    calls.add.push(s)
    bot.lastAddOrderId = new Map([['d1', `A${++n}`]])
  }
  bot.closeDealById = async (...args: any[]) => {
    calls.close.push(args)
  }
  bot.saveDeal = (_d: any, patch: any) => {
    calls.saved.push(patch)
  }
  return { bot, calls, deal }
}

const clearTimers = (bot: any) => {
  for (const m of [bot.splitCloses, bot.entrySplits]) {
    for (const st of m?.values() ?? []) {
      if (st.timer) clearTimeout(st.timer)
    }
  }
  for (const t of bot.restingTpTimers?.values() ?? []) clearTimeout(t)
}

const splitTp = {
  useTp: true,
  dealCloseCondition: 'techInd',
  tpExecution: {
    mode: 'split',
    slices: 4,
    pace: 'iceberg',
    sliceIntervalSec: 5,
    sliceMode: 'market',
  },
}

describe('spec 242 — split close runner (§4.5)', () => {
  let bots: any[] = []
  afterEach(() => {
    bots.forEach(clearTimers)
    bots = []
  })

  it('a take-profit close whose stage is split becomes slices; the deal is blocked', async () => {
    const { bot, calls } = make(splitTp)
    bots.push(bot)
    const owned = await bot.maybeStartSplitClose(
      'd1',
      bot.getDeal(),
      CloseDCATypeEnum.closeByMarket,
      false,
      '',
      false,
      DCACloseTriggerEnum.indicator,
    )
    expect(owned).to.equal(true)
    expect(bot.allowToPlaceOrders.get('d1')).to.equal(false)
    // let the first slice go out
    await new Promise((r) => setImmediate(r))
    expect(calls.reduce).to.have.length(1)
    expect(+calls.reduce[0].qty).to.equal(0.25)
    expect(calls.reduce[0].useLimitPrice).to.equal(false)
    expect(bot.splitCloses.get('d1').sizes).to.deep.equal([
      0.25, 0.25, 0.25, 0.25,
    ])
  })

  it('a slice fill moves on; the last slice is the deal close', async () => {
    const { bot, calls } = make(splitTp)
    bots.push(bot)
    await bot.maybeStartSplitClose(
      'd1',
      bot.getDeal(),
      CloseDCATypeEnum.closeByMarket,
      false,
      '',
      false,
      DCACloseTriggerEnum.indicator,
    )
    await new Promise((r) => setImmediate(r))
    for (let i = 0; i < 3; i++) {
      const st = bot.splitCloses.get('d1')
      bot.onSplitSliceFilled(
        'd1',
        st.orderId ?? bot.lastReduceOrderId.get('d1'),
      )
      clearTimeout(bot.splitCloses.get('d1').timer)
      await bot.placeSplitSlice('d1')
    }
    expect(calls.reduce).to.have.length(3)
    expect(calls.close).to.have.length(1)
    expect(calls.close[0][2]).to.equal(CloseDCATypeEnum.closeByMarket)
    expect(bot.splitCloses.has('d1')).to.equal(false)
  })

  it('the same trigger again is ignored; a manual close interrupts the split', async () => {
    const { bot } = make(splitTp)
    bots.push(bot)
    await bot.maybeStartSplitClose(
      'd1',
      bot.getDeal(),
      CloseDCATypeEnum.closeByMarket,
      false,
      '',
      false,
      DCACloseTriggerEnum.indicator,
    )
    expect(
      await bot.maybeStartSplitClose(
        'd1',
        bot.getDeal(),
        CloseDCATypeEnum.closeByMarket,
        false,
        '',
        false,
        DCACloseTriggerEnum.indicator,
      ),
    ).to.equal(true)
    expect(
      await bot.maybeStartSplitClose(
        'd1',
        bot.getDeal(),
        CloseDCATypeEnum.closeByMarket,
        false,
        '',
        false,
        DCACloseTriggerEnum.manual,
      ),
    ).to.equal(false)
    expect(bot.splitCloses.has('d1')).to.equal(false)
  })

  it('not for combo bots, a forced market close or a non-split stage', async () => {
    const combo = make(splitTp)
    combo.bot.combo = true
    expect(
      await combo.bot.maybeStartSplitClose(
        'd1',
        combo.bot.getDeal(),
        CloseDCATypeEnum.closeByMarket,
        false,
        '',
        false,
        DCACloseTriggerEnum.indicator,
      ),
    ).to.equal(false)
    const forced = make(splitTp)
    expect(
      await forced.bot.maybeStartSplitClose(
        'd1',
        forced.bot.getDeal(),
        CloseDCATypeEnum.closeByMarket,
        true,
        '',
        false,
        DCACloseTriggerEnum.indicator,
      ),
    ).to.equal(false)
    const plain = make({ ...splitTp, tpExecution: { mode: 'market' } })
    expect(
      await plain.bot.maybeStartSplitClose(
        'd1',
        plain.bot.getDeal(),
        CloseDCATypeEnum.closeByMarket,
        false,
        '',
        false,
        DCACloseTriggerEnum.indicator,
      ),
    ).to.equal(false)
  })

  it('past the floor with onFloor market: the rest closes at market', async () => {
    const { bot, calls } = make(
      {
        ...splitTp,
        tpExecution: {
          ...splitTp.tpExecution,
          floorPerc: 2,
          onFloor: 'market',
        },
      },
      { last: 100 },
    )
    bots.push(bot)
    await bot.maybeStartSplitClose(
      'd1',
      bot.getDeal(),
      CloseDCATypeEnum.closeByMarket,
      false,
      '',
      false,
      DCACloseTriggerEnum.indicator,
    )
    await new Promise((r) => setImmediate(r))
    bot.getLastStreamData = () => ({ price: 97 })
    bot.onSplitSliceFilled('d1', bot.lastReduceOrderId.get('d1'))
    clearTimeout(bot.splitCloses.get('d1').timer)
    await bot.placeSplitSlice('d1')
    expect(calls.close).to.have.length(1)
    expect(calls.close[0][2]).to.equal(CloseDCATypeEnum.closeByMarket)
    expect(calls.close[0][4]).to.equal(true)
  })

  it('a split take profit at a known price is watched like a market one', async () => {
    const { bot } = make({
      useTp: true,
      dealCloseCondition: 'tp',
      tpExecution: { mode: 'split', sliceMode: 'limit' },
    })
    expect(await bot.isDealForTPLevelCheck(bot.getDeal())).to.equal(true)
    const multi = make({
      useTp: true,
      useMultiTp: true,
      dealCloseCondition: 'tp',
      tpExecution: { mode: 'split', sliceMode: 'limit' },
    })
    expect(await multi.bot.isDealForTPLevelCheck(multi.bot.getDeal())).to.equal(
      false,
    )
  })
})

describe('spec 242 — base order split (§6.5)', () => {
  let bots: any[] = []
  afterEach(() => {
    bots.forEach(clearTimers)
    bots = []
  })
  const splitEntry = {
    entryExecution: {
      mode: 'split',
      slices: 4,
      pace: 'iceberg',
      sliceIntervalSec: 5,
      sliceMode: 'market',
    },
  }

  it('the base order is shrunk to slice 1 and the plan is kept for re-placements', async () => {
    const { bot } = make(splitEntry)
    bots.push(bot)
    const base = { origQty: '1', price: '100' }
    await bot.applyEntrySplit('d1', 'BTCUSDT', base, 0)
    expect(base.origQty).to.equal('0.25')
    const again = { origQty: '1', price: '101' }
    await bot.applyEntrySplit('d1', 'BTCUSDT', again, 0)
    expect(again.origQty).to.equal('0.25')
  })

  it('not eligible: risk/reward, short spot, a fixed size', async () => {
    for (const [extra, ctx] of [
      [{ useRiskReward: true }, {}],
      [{}, { isLong: false }],
    ] as const) {
      const { bot } = make({ ...splitEntry, ...extra })
      Object.assign(bot, ctx)
      const base = { origQty: '1', price: '100' }
      await bot.applyEntrySplit('d1', 'BTCUSDT', base, 0)
      expect(base.origQty).to.equal('1')
    }
    const fixed = make(splitEntry)
    const base = { origQty: '1', price: '100' }
    await fixed.bot.applyEntrySplit('d1', 'BTCUSDT', base, 10)
    expect(base.origQty).to.equal('1')
  })

  it('after the base fill the rest follows as add-funds slices, then completes', async () => {
    const { bot, calls } = make(splitEntry)
    bots.push(bot)
    await bot.applyEntrySplit(
      'd1',
      'BTCUSDT',
      { origQty: '1', price: '100' },
      0,
    )
    bot.onEntryBaseFilled('d1')
    for (let i = 0; i < 3; i++) {
      clearTimeout(bot.entrySplits.get('d1').timer)
      await bot.placeEntrySlice('d1')
      bot.onEntrySliceFilled('d1', bot.lastAddOrderId.get('d1'))
    }
    expect(calls.add.map((a) => +a.qty)).to.deep.equal([0.25, 0.25, 0.25])
    expect(bot.entrySplits.has('d1')).to.equal(false)
  })
})

describe('spec 242 — resting take-profit timeout (§4.2)', () => {
  it('armed once on a part fill, expires to a market close', async () => {
    const order = {
      clientOrderId: 'TP1',
      status: 'PARTIALLY_FILLED',
      executedQty: '0.3',
    }
    const { bot, calls } = make(
      {
        useTp: true,
        dealCloseCondition: 'tp',
        tpExecution: { mode: 'limit', timeoutSec: 30 },
      },
      { orders: [order] },
    )
    await bot.armRestingTpTimeout(bot.getDeal().deal, 'TP1')
    await bot.armRestingTpTimeout(bot.getDeal().deal, 'TP1')
    expect(bot.restingTpTimers.size).to.equal(1)
    clearTimers(bot)
    await bot.expireRestingTp('d1', 'TP1')
    expect(calls.cancelled).to.deep.equal(['TP1'])
    expect(calls.close[0][2]).to.equal(CloseDCATypeEnum.closeByMarket)
    expect(calls.close[0][10]).to.equal(DCACloseTriggerEnum.tp)
  })
  it('nothing to do once the take profit filled', async () => {
    const { bot, calls } = make(
      {
        useTp: true,
        dealCloseCondition: 'tp',
        tpExecution: { mode: 'limit', timeoutSec: 30 },
      },
      { orders: [{ clientOrderId: 'TP1', status: 'FILLED' }] },
    )
    await bot.expireRestingTp('d1', 'TP1')
    expect(calls.close).to.have.length(0)
  })
  it('no timer for a legacy bot', async () => {
    const { bot } = make({
      useTp: true,
      dealCloseCondition: 'tp',
      closeOrderType: 'LIMIT',
    })
    await bot.armRestingTpTimeout(bot.getDeal().deal, 'TP1')
    expect(bot.restingTpTimers?.size ?? 0).to.equal(0)
  })
})

describe('spec 242 — stop-loss close type (§4.4)', () => {
  it('chase closes by limit; legacy and combo close at market', async () => {
    const chase = make({
      useSl: true,
      dealCloseConditionSL: 'tp',
      slExecution: { mode: 'chase', timeoutSec: 20 },
    })
    expect(
      await chase.bot.stopLossCloseType(chase.bot.getDeal().deal, true),
    ).to.equal(CloseDCATypeEnum.closeByLimit)
    const legacy = make({ useSl: true, dealCloseConditionSL: 'tp' })
    expect(
      await legacy.bot.stopLossCloseType(legacy.bot.getDeal().deal, true),
    ).to.equal(CloseDCATypeEnum.closeByMarket)
    const trailing = make({ slExecution: { mode: 'chase' } })
    expect(
      await trailing.bot.stopLossCloseType(trailing.bot.getDeal().deal, false),
    ).to.equal(CloseDCATypeEnum.closeByMarket)
    const combo = make({ slExecution: { mode: 'chase' } })
    combo.bot.combo = true
    expect(
      await combo.bot.stopLossCloseType(combo.bot.getDeal().deal, true),
    ).to.equal(CloseDCATypeEnum.closeByMarket)
  })
})

describe('spec 242 — persisted state and restart resume', () => {
  let bots: any[] = []
  afterEach(() => {
    bots.forEach(clearTimers)
    bots = []
  })

  it('a running split is written to the deal and cleared when it ends', async () => {
    const { bot, calls, deal } = make(splitTp)
    bots.push(bot)
    await bot.maybeStartSplitClose(
      'd1',
      bot.getDeal(),
      CloseDCATypeEnum.closeByMarket,
      false,
      '',
      false,
      DCACloseTriggerEnum.indicator,
    )
    const last = calls.saved[calls.saved.length - 1]
    expect(last.executionSplit).to.include({ stage: 'tp', index: 0 })
    expect(last.executionSplit.sizes).to.have.length(4)
    bot.clearSplitClose('d1')
    expect(deal.deal.executionSplit).to.equal(null)
  })

  it('a bot teardown keeps the persisted state for the restart', async () => {
    const { bot, deal } = make(splitTp)
    bots.push(bot)
    await bot.maybeStartSplitClose(
      'd1',
      bot.getDeal(),
      CloseDCATypeEnum.closeByMarket,
      false,
      '',
      false,
      DCACloseTriggerEnum.indicator,
    )
    bot.clearSplitClose('d1', false)
    expect(deal.deal.executionSplit).to.include({ stage: 'tp' })
  })

  it('resume re-plans the rest of a split close into the slices left', async () => {
    const tp = {
      clientOrderId: 'TP9',
      typeOrder: TypeOrderEnum.dealTP,
      status: 'NEW',
    }
    const { bot, calls, deal } = make(splitTp, { orders: [tp], qty: 0.5 })
    bots.push(bot)
    deal.deal.executionSplit = {
      stage: 'tp',
      execution: splitTp.tpExecution,
      sizes: [0.25, 0.25, 0.25, 0.25],
      index: 2,
      triggerPrice: 100,
      startedAt: 1,
      updatedAt: 1,
    }
    await bot.resumeExecutionState()
    expect(calls.cancelled).to.deep.equal(['TP9'])
    expect(bot.allowToPlaceOrders.get('d1')).to.equal(false)
    expect(bot.splitCloses.get('d1').sizes).to.deep.equal([0.25, 0.25])
  })

  it('a limit close past its timeout resumes at market', async () => {
    const { bot, calls, deal } = make({})
    deal.deal.closeExecution = {
      mode: 'chase',
      triggerPrice: 100,
      startedAt: Date.now() - 120_000,
      timeoutSec: 35,
      repriceSec: 10,
    }
    await bot.resumeExecutionState()
    expect(calls.close[0][2]).to.equal(CloseDCATypeEnum.closeByMarket)
    expect(calls.close[0][4]).to.equal(true)
  })

  it('a limit close within its timeout resumes by limit, keeping its start', async () => {
    const { bot, calls, deal } = make({})
    const startedAt = Date.now() - 5_000
    deal.deal.closeExecution = {
      mode: 'chase',
      triggerPrice: 100,
      startedAt,
      timeoutSec: 35,
      repriceSec: 10,
      maxChasePerc: 1,
    }
    await bot.resumeExecutionState()
    expect(calls.close[0][2]).to.equal(CloseDCATypeEnum.closeByLimit)
    expect(bot.closeExecutionContext.get('d1')).to.deep.include({ startedAt })
    expect(bot.closeExecutionContext.get('d1').execution.maxChasePerc).to.equal(
      1,
    )
  })
})

describe('spec 242 §4.3.1 — chasing slices price from the top of the book', () => {
  let bots: any[] = []
  afterEach(() => {
    bots.forEach(clearTimers)
    bots = []
  })
  const chaseTp = {
    ...splitTp,
    tpExecution: { ...splitTp.tpExecution, sliceMode: 'chase', repriceSec: 5 },
  }

  it('a sell slice waits at the best ask, not the last trade', async () => {
    const { bot, calls } = make(chaseTp, { last: 100 })
    bots.push(bot)
    bot.exchange = {
      bookTicker: async () => ({
        status: 'OK',
        data: { bid: 99.9, ask: 100.1 },
      }),
    }
    await bot.maybeStartSplitClose(
      'd1',
      bot.getDeal(),
      CloseDCATypeEnum.closeByMarket,
      false,
      '',
      false,
      DCACloseTriggerEnum.indicator,
    )
    await new Promise((r) => setImmediate(r))
    expect(calls.reduce[0].useLimitPrice).to.equal(true)
    expect(+calls.reduce[0].limitPrice).to.equal(100.1)
  })

  it('no book (unsupported, failed, crossed): the last trade, as before', async () => {
    for (const exchange of [
      {
        bookTicker: async () => ({
          status: 'NOTOK',
          data: null,
          reason: 'Method not supported',
        }),
      },
      {
        bookTicker: async () => {
          throw new Error('down')
        },
      },
      {
        bookTicker: async () => ({
          status: 'OK',
          data: { bid: 101, ask: 100 },
        }),
      },
      undefined,
    ]) {
      const { bot, calls } = make(chaseTp, { last: 100 })
      bots.push(bot)
      bot.exchange = exchange
      await bot.maybeStartSplitClose(
        'd1',
        bot.getDeal(),
        CloseDCATypeEnum.closeByMarket,
        false,
        '',
        false,
        DCACloseTriggerEnum.indicator,
      )
      await new Promise((r) => setImmediate(r))
      expect(+calls.reduce[0].limitPrice).to.equal(100)
    }
  })

  it('the book never takes a slice past the max chase', async () => {
    const { bot, calls } = make(
      { ...chaseTp, tpExecution: { ...chaseTp.tpExecution, maxChasePerc: 1 } },
      { last: 100 },
    )
    bots.push(bot)
    // trigger at 100; book has collapsed to 95/95.5 — the floor is 99
    bot.exchange = {
      bookTicker: async () => ({ status: 'OK', data: { bid: 95, ask: 95.5 } }),
    }
    await bot.maybeStartSplitClose(
      'd1',
      bot.getDeal(),
      CloseDCATypeEnum.closeByMarket,
      false,
      '',
      false,
      DCACloseTriggerEnum.indicator,
    )
    await new Promise((r) => setImmediate(r))
    expect(+calls.reduce[0].limitPrice).to.equal(99)
  })
})

describe('spec 242 §5.3 — a stored limit stop-loss split chases and times out', () => {
  let bots: any[] = []
  afterEach(() => {
    bots.forEach(clearTimers)
    bots = []
  })
  it('the slice chases the market below the stop and has a timer', async () => {
    const { bot, calls, deal } = make(
      {
        slExecution: {
          mode: 'split',
          slices: 3,
          pace: 'iceberg',
          sliceIntervalSec: 5,
          sliceMode: 'limit',
          timeoutSec: 0,
        },
      },
      { last: 90, qty: 3 },
    )
    bots.push(bot)
    bot.prepareTpOrder = async () => ({ qty: 3, price: 95, side: 'SELL' })
    await bot.maybeStartSplitClose(
      'd1',
      deal,
      CloseDCATypeEnum.closeByMarket,
      false,
      '',
      true,
      DCACloseTriggerEnum.sl,
    )
    await new Promise((r) => setImmediate(r))
    expect(calls.reduce).to.have.length(1)
    expect(+calls.reduce[0].qty).to.equal(1)
    expect(calls.reduce[0].useLimitPrice).to.equal(true)
    // priced from the market (90), not resting at the stop price (95)
    expect(+calls.reduce[0].limitPrice).to.equal(90)
    const st = bot.splitCloses.get('d1')
    expect(st.execution.sliceMode).to.equal('chase')
    expect(st.execution.timeoutSec).to.equal(35)
    expect(st.timer).to.not.equal(undefined)
  })
})
