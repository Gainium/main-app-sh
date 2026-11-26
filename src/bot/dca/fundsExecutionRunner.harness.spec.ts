process.env.NODE_ENV = 'testing'

/**
 * Add funds dialog — a chasing limit or a split add runs on the base-order
 * split runner (the REAL DCA helper mixin over a minimal base). Exchange calls
 * are stubbed and recorded; timers are inspected and cleared, never awaited.
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  DCADealStatusEnum,
  OrderSizeTypeEnum,
  AddFundsTypeEnum,
} from '../../../types'
import { MathHelper } from '../../utils/math'

class FakeBase {
  botId = '000000000000000000000b64'
  data: any = { settings: {} }
  constructor(..._a: any[]) {}
}

let Helper: any
before(() => {
  Helper = createRequire(__filename)('../dcaHelper').default(FakeBase as any)
})

const ED = {
  baseAsset: { step: 0.001, minAmount: 0.001, name: 'BTC' },
  quoteAsset: { minAmount: 5, name: 'USDT' },
  priceAssetPrecision: 2,
}

const make = () => {
  const bot: any = Object.create(Helper.prototype)
  const calls = {
    add: [] as any[],
    cancelled: [] as string[],
    saved: [] as any[],
    errors: [] as string[],
    unknown: [] as any[],
  }
  const deal: any = {
    deal: {
      _id: 'd1',
      status: DCADealStatusEnum.open,
      symbol: { symbol: 'BTCUSDT' },
      settings: {},
      pendingAddFunds: [] as any[],
      levels: { all: 3, complete: 2 },
    },
  }
  const orders = new Map<string, any>()
  bot.botId = 'b1'
  bot.data = { settings: {} }
  bot.combo = false
  bot.isLong = true
  bot.allowToPlaceOrders = new Map()
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = (m: string) => {
    calls.errors.push(m)
  }
  bot.getExchangeInfo = async () => ED
  bot.getDeal = () => deal
  bot.getLastStreamData = () => ({ price: 100 })
  bot.getOrderFromMap = (id: string) => orders.get(id)
  bot.handleUnknownOrder = async (o: any) => {
    calls.unknown.push(o)
  }
  let n = 0
  // A resting slice: an add-funds order with its pending entry, as the real
  // addDealFunds leaves it.
  bot.addDealFunds = async (_b: string, _d: string, s: any) => {
    calls.add.push(s)
    const id = `A${++n}`
    orders.set(id, {
      clientOrderId: id,
      addFundsId: `F${n}`,
      status: 'NEW',
      executedQty: '0',
      origQty: s.qty,
    })
    deal.deal.pendingAddFunds.push({ ...s, id: `F${n}` })
    deal.deal.levels.all += 1
    bot.lastAddOrderId = new Map([['d1', id]])
  }
  bot.saveDeal = (_d: any, patch: any) => {
    calls.saved.push(patch)
  }
  return { bot, calls, deal, orders }
}

const clearTimers = (bot: any) => {
  for (const st of bot.entrySplits?.values() ?? []) {
    if (st.timer) clearTimeout(st.timer)
  }
}

const chase = { mode: 'chase', repriceSec: 10, maxChasePerc: 0, timeoutSec: 35 }

describe('add funds — chase / split run', () => {
  let bots: any[] = []
  afterEach(() => {
    bots.forEach(clearTimers)
    bots = []
  })

  it('a chasing add places one limit slice at the chase price and persists the run', async () => {
    const { bot, calls } = make()
    bots.push(bot)
    bot.startFundsRun('d1', chase, [1], 100)
    const st = bot.entrySplits.get('d1')
    expect(st).to.include({ funds: true, index: 1, remaining: 1 })
    expect(st.sizes).to.deep.equal([0, 1])
    expect(
      calls.saved.some((p) => p.executionSplit?.stage === 'entry'),
    ).to.equal(true)
    clearTimeout(st.timer)
    await bot.placeEntrySlice('d1')
    expect(calls.add).to.have.length(1)
    expect(calls.add[0]).to.include({ qty: '1', useLimitPrice: true })
    expect(calls.add[0]).to.not.have.property('execution')
    expect(st.orderId).to.equal('A1')
  })

  it('the fill completes the run', async () => {
    const { bot } = make()
    bots.push(bot)
    bot.startFundsRun('d1', chase, [1], 100)
    clearTimeout(bot.entrySplits.get('d1').timer)
    await bot.placeEntrySlice('d1')
    bot.onEntrySliceFilled('d1', 'A1')
    expect(bot.entrySplits.has('d1')).to.equal(false)
  })

  it("a re-price with nothing filled drops the cancelled slice's pending entry, then re-places", async () => {
    const { bot, calls, deal } = make()
    bots.push(bot)
    bot.cancelOrderOnExchange = async (o: any) => {
      calls.cancelled.push(o.clientOrderId)
      return { ...o, status: 'CANCELED', executedQty: '0' }
    }
    bot.startFundsRun('d1', chase, [1], 100)
    clearTimeout(bot.entrySplits.get('d1').timer)
    await bot.placeEntrySlice('d1')
    expect(deal.deal.pendingAddFunds.map((p: any) => p.id)).to.deep.equal([
      'F1',
    ])
    clearTimeout(bot.entrySplits.get('d1').timer)
    await bot.repriceEntrySlice('d1')
    expect(calls.cancelled).to.deep.equal(['A1'])
    // Only the re-placed slice is pending: a reload re-sends nothing extra.
    expect(deal.deal.pendingAddFunds.map((p: any) => p.id)).to.deep.equal([
      'F2',
    ])
    expect(deal.deal.levels.all).to.equal(4)
    expect(calls.add.map((a) => a.qty)).to.deep.equal(['1', '1'])
  })

  it('a part fill under the re-price cancel: the part is booked, the rest goes on', async () => {
    const { bot, calls } = make()
    bots.push(bot)
    bot.cancelOrderOnExchange = async (o: any) => ({
      ...o,
      status: 'FILLED',
      executedQty: '0.4',
    })
    bot.startFundsRun('d1', chase, [1], 100)
    clearTimeout(bot.entrySplits.get('d1').timer)
    await bot.placeEntrySlice('d1')
    clearTimeout(bot.entrySplits.get('d1').timer)
    await bot.repriceEntrySlice('d1')
    expect(calls.unknown.map((o) => o.clientOrderId)).to.deep.equal(['A1'])
    // The booked part's own fill event does not advance the run.
    bot.onEntrySliceFilled('d1', 'A1')
    const st = bot.entrySplits.get('d1')
    expect(st.index).to.equal(1)
    expect(+calls.add[1].qty).to.equal(0.6)
    expect(st.orderId).to.equal('A2')
  })

  it('a split add places its slices one after another, then completes', async () => {
    const { bot, calls } = make()
    bots.push(bot)
    bot.startFundsRun(
      'd1',
      {
        mode: 'split',
        slices: 3,
        pace: 'iceberg',
        sliceMode: 'market',
        sliceIntervalSec: 5,
      },
      [0.3, 0.3, 0.4],
      100,
    )
    for (let i = 0; i < 3; i++) {
      clearTimeout(bot.entrySplits.get('d1').timer)
      await bot.placeEntrySlice('d1')
      bot.onEntrySliceFilled('d1', bot.lastAddOrderId.get('d1'))
    }
    expect(calls.add.map((a) => [+a.qty, a.useLimitPrice])).to.deep.equal([
      [0.3, false],
      [0.3, false],
      [0.4, false],
    ])
    expect(bot.entrySplits.has('d1')).to.equal(false)
  })

  describe('addDealFunds routing', () => {
    const real = () => {
      const { bot, calls } = make()
      bots.push(bot)
      bot.addDealFunds = Helper.prototype.addDealFunds
      bot.math = new MathHelper()
      bot.startMethod = () => 'm'
      bot.endMethod = () => undefined
      bot.getLatestPrice = async () => 100
      bot.baseAssetPrecision = async () => 3
      const sent: any[] = []
      bot.sendOrderToExchange = async (o: any) => {
        sent.push(o)
        return { ...o, status: 'NEW' }
      }
      bot.getOrderId = (p: string) => `${p}-x`
      bot.saveDeal = (_d: any, patch: any) => {
        calls.saved.push(patch)
        return Promise.resolve()
      }
      bot.updateUsage = () => undefined
      bot.updateAssets = () => undefined
      bot.updateDealBalances = () => undefined
      return { bot, calls, sent }
    }
    const req = (execution: any) => ({
      qty: '100',
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.fixed,
      useLimitPrice: false,
      execution,
    })

    it('chase: no order of its own, the run starts with the whole amount', async () => {
      const { bot, sent } = real()
      await bot.addDealFunds('b1', 'd1', req(chase))
      expect(sent).to.have.length(0)
      const st = bot.entrySplits.get('d1')
      expect(st).to.include({ funds: true, remaining: 1 })
    })

    it('market: the plain order, and the execution is not stored on the pending entry', async () => {
      const { bot, sent } = real()
      await bot.addDealFunds('b1', 'd1', req({ mode: 'market' }))
      expect(sent).to.have.length(1)
      expect(sent[0].type).to.equal('MARKET')
      await new Promise((r) => setImmediate(r))
      const pending = bot.getDeal().deal.pendingAddFunds
      expect(pending).to.have.length(1)
      expect(pending[0]).to.not.have.property('execution')
    })

    it('refused while a run is still adding, and for an invalid execution', async () => {
      const { bot, calls, sent } = real()
      await bot.addDealFunds('b1', 'd1', req(chase))
      await bot.addDealFunds('b1', 'd1', req(chase))
      await bot.addDealFunds('b1', 'd1', req({ mode: 'teleport' }))
      expect(sent).to.have.length(0)
      expect(calls.errors).to.have.length(2)
      expect(calls.errors[0]).to.match(/still adding/)
      expect(calls.errors[1]).to.match(/^Add funds execution mode/)
    })
  })
})
