process.env.NODE_ENV = 'testing'

/**
 * Spec 249 — a manual close runs the execution the person chose in the close
 * dialog (market, limit, chasing limit or split), on the REAL DCA helper mixin
 * over a minimal base. Exchange-facing calls are stubbed and recorded.
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

const ED = {
  baseAsset: { step: 0.001, minAmount: 0.001, name: 'BTC' },
  quoteAsset: { minAmount: 5, name: 'USDT' },
  priceAssetPrecision: 2,
}

const make = (opts: { qty?: number; combo?: boolean } = {}) => {
  const bot: any = Object.create(Helper.prototype)
  const calls = {
    close: [] as any[][],
    reduce: [] as any[],
    saved: [] as any[],
    warn: [] as string[],
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
  bot.data = { settings: {} }
  bot.combo = !!opts.combo
  bot.isLong = true
  bot.useCompountReduce = false
  bot.allowToPlaceOrders = new Map()
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleWarn = (m: string) => {
    calls.warn.push(m)
    return m
  }
  bot.getAggregatedSettings = async () => ({})
  bot.getExchangeInfo = async () => ED
  bot.getDeal = () => deal
  bot.getOpenDeals = () => [deal]
  bot.getLastStreamData = () => ({ price: 100 })
  bot.prepareTpOrder = async () => ({
    qty: opts.qty ?? 1,
    price: 100,
    side: 'SELL',
  })
  bot.getOrdersByStatusAndDealId = () => []
  bot.cancelOrderOnExchange = async (o: any) => ({ ...o, status: 'CANCELED' })
  bot.reduceDealFunds = async (_b: string, _d: string, s: any) => {
    calls.reduce.push(s)
    bot.lastReduceOrderId = new Map([['d1', 'R1']])
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
  for (const st of bot.splitCloses?.values() ?? []) {
    if (st.timer) clearTimeout(st.timer)
  }
}

describe('spec 249 — manual close with a chosen execution', () => {
  let bots: any[] = []
  afterEach(() => {
    bots.forEach(clearTimers)
    bots = []
  })

  it('market closes at market, as a manual close, with nothing left over', async () => {
    const { bot, calls } = make()
    bots.push(bot)
    await bot.closeDealByExecution('b1', 'd1', { mode: 'market' })
    expect(calls.close).to.have.length(1)
    expect(calls.close[0][2]).to.equal(CloseDCATypeEnum.closeByMarket)
    expect(calls.close[0][10]).to.equal(DCACloseTriggerEnum.manual)
    expect(bot.requestedCloseExecution?.get('d1')).to.equal(undefined)
  })

  it('a chasing limit closes by limit and hands the close its own timing', async () => {
    const { bot, calls } = make()
    bots.push(bot)
    const execution = {
      mode: 'chase',
      repriceSec: 15,
      maxChasePerc: 1,
      timeoutSec: 0,
    }
    await bot.closeDealByExecution('b1', 'd1', execution)
    expect(calls.close[0][2]).to.equal(CloseDCATypeEnum.closeByLimit)
    expect(bot.requestedCloseExecution.get('d1')).to.deep.equal(execution)
    // Read once, then gone: a later close is a new close.
    expect(bot.takeRequestedCloseExecution('d1')).to.deep.equal(execution)
    expect(bot.requestedCloseExecution.has('d1')).to.equal(false)
  })

  it("a limit at the person's own price is sent with that price", async () => {
    const { bot, calls } = make()
    bots.push(bot)
    await bot.closeDealByExecution(
      'b1',
      'd1',
      { mode: 'limit', timeoutSec: 0 },
      true,
      DCACloseTriggerEnum.manual,
      650.5,
    )
    expect(calls.close[0][2]).to.equal(CloseDCATypeEnum.closeByLimit)
    expect(calls.close[0][7]).to.equal('650.5')
  })

  it('refuses a limit price on anything but a limit', async () => {
    const { bot, calls } = make()
    bots.push(bot)
    await bot.closeDealByExecution(
      'b1',
      'd1',
      { mode: 'chase' },
      true,
      DCACloseTriggerEnum.manual,
      650,
    )
    expect(calls.close).to.have.length(0)
  })

  it('refuses an execution the engine cannot run, and closes nothing', async () => {
    const { bot, calls } = make()
    bots.push(bot)
    await bot.closeDealByExecution('b1', 'd1', {
      mode: 'chase',
      timeoutSec: -5,
    })
    expect(calls.close).to.have.length(0)
    expect(calls.warn.join(' ')).to.match(/refused/)
  })

  it('a combo bot turns a fixed limit or split into a chasing limit', async () => {
    const { bot } = make({ combo: true })
    bots.push(bot)
    await bot.closeDealByExecution('b1', 'd1', {
      mode: 'split',
      slices: 4,
      sliceMode: 'chase',
    })
    expect(bot.requestedCloseExecution.get('d1').mode).to.equal('chase')
  })

  it('a split manual close runs as a split, and stays manual', async () => {
    const { bot, calls, deal } = make({ qty: 1 })
    bots.push(bot)
    bot.requestedCloseExecution = new Map([
      [
        'd1',
        {
          mode: 'split',
          slices: 4,
          pace: 'iceberg',
          sliceIntervalSec: 5,
          sliceMode: 'market',
        },
      ],
    ])
    const owned = await bot.maybeStartSplitClose(
      'd1',
      deal,
      CloseDCATypeEnum.closeByLimit,
      false,
      '',
      false,
      DCACloseTriggerEnum.manual,
    )
    expect(owned).to.equal(true)
    const st = bot.splitCloses.get('d1')
    expect(st.sizes).to.have.length(4)
    expect(st.closeTrigger).to.equal(DCACloseTriggerEnum.manual)
    expect(deal.deal.closeTrigger).to.equal(DCACloseTriggerEnum.manual)
    expect(calls.saved.some((p) => p.closeTrigger === 'manual')).to.equal(true)
    expect(bot.requestedCloseExecution.has('d1')).to.equal(false)
  })

  it('a position too small to split closes in one chasing order instead', async () => {
    const { bot, deal } = make({ qty: 0.001 })
    bots.push(bot)
    bot.requestedCloseExecution = new Map([
      [
        'd1',
        {
          mode: 'split',
          slices: 4,
          sliceMode: 'chase',
          repriceSec: 20,
          timeoutSec: 60,
        },
      ],
    ])
    const owned = await bot.maybeStartSplitClose(
      'd1',
      deal,
      CloseDCATypeEnum.closeByLimit,
      false,
      '',
      false,
      DCACloseTriggerEnum.manual,
    )
    expect(owned).to.equal(false)
    expect(bot.requestedCloseExecution.get('d1')).to.deep.equal({
      mode: 'chase',
      repriceSec: 20,
      maxChasePerc: 0,
      timeoutSec: 60,
    })
  })

  it('a manual close with no chosen execution keeps the old behaviour', async () => {
    const { bot, deal } = make()
    bots.push(bot)
    const owned = await bot.maybeStartSplitClose(
      'd1',
      deal,
      CloseDCATypeEnum.closeByLimit,
      false,
      '',
      false,
      DCACloseTriggerEnum.manual,
    )
    expect(owned).to.equal(false)
    expect(bot.splitCloses?.has('d1') ?? false).to.equal(false)
  })
})
