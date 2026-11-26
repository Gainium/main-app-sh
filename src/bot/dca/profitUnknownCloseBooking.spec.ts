process.env.NODE_ENV = 'testing'

/**
 * Spec `282` — the REAL `closeDeal` books nothing it cannot account for on a
 * deal closed flagged `profitUnknown` (spec `277` §1.1).
 *
 * The ledger is a bybitLinear TRXUSDT LONG DCA deal's as stored at close:
 * 6371 base held at an average of 0.3233, 0.88809308 of entry fees and
 * 18.55969204548399 USDT of settled funding. Its position was closed on the
 * venue outside the bot, and bybitLinear publishes no account fills, so the
 * close went down the no-price branch. That branch subtracted the entry fees
 * and then folded the funding in: the deal and the bot stored +17.67 for a
 * position whose price move alone lost about 122, and its "Deal closed" event
 * said -0.887$ (the fees, before the funding fold).
 *
 * Run: npx mocha -r ts-node/register src/bot/dca/profitUnknownCloseBooking.spec.ts
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  DCADealFlags,
  DCADealStatusEnum,
  ExchangeEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000282'
const ENTRY_FEES = 0.88809308
const FUNDING = 18.55969204548399
const FUNDING_USD = 18.534401562122593

class FakeBase {
  botId = '000000000000000000000b82'
  userId = '000000000000000000000482'
  botType = 'dca'
  loadingComplete = true
  data: any = {
    exchange: ExchangeEnum.bybitUsdm,
    paperContext: false,
    flags: [],
    profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
  }
  orders = new Map()
  get futures() {
    return true
  }
  get isLong() {
    return true
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (opts: { flags: string[]; preProfit?: number }) => {
  const pre = opts.preProfit ?? 0
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      status: DCADealStatusEnum.open,
      flags: opts.flags,
      symbol: { symbol: 'TRXUSDT', baseAsset: 'TRX', quoteAsset: 'USDT' },
      initialBalances: { base: 0, quote: 3503.7634 },
      currentBalances: { base: 6371, quote: 1443.6115 },
      profit: { total: pre, totalUsd: pre, pureBase: 0, pureQuote: 0 },
      funding: { total: FUNDING, totalUsd: FUNDING_USD },
      lastPrice: 0.3041,
      avgPrice: 0.3233,
      size: 6371,
    },
  }
  const saved: any[] = []
  const userProfit: any[] = []
  const closeEvents: any[] = []
  class TestBot extends Helper {
    saved = saved
    userProfit = userProfit
    closeEvents = closeEvents
    getDeal() {
      return deal
    }
    async finishDealFunding() {}
    async profitBase() {
      return false
    }
    async getUsdRate() {
      return 1
    }
    async getCommDeal() {
      return ENTRY_FEES
    }
    saveProfitToDb(...args: any[]) {
      userProfit.push(args)
    }
    saveDeal(_d: any, u: any) {
      saved.push(u)
    }
    updateData() {}
    emit() {}
    // The "Deal closed" event is written here, before the funding fold.
    async processDealClose() {
      closeEvents.push(await this.dealCloseEventDescription(deal.deal))
      return false
    }
    updateUserProfitStep() {}
    persistExecutionState() {}
    clearSplitClose() {}
    clearEntrySplit() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
    handleLog() {}
    handleDebug() {}
  }
  return { bot: new TestBot() as any, deal }
}

const unknownFlags = [
  DCADealFlags.newMultiTp,
  DCADealFlags.closedExternally,
  DCADealFlags.profitUnknown,
]

describe('spec 282 — a "profit unknown" close books no invented profit', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§1.1 the reported deal: stored profit is 0, not fees + funding (+17.67)', async () => {
    const { bot, deal } = buildBot({ flags: unknownFlags })
    await bot.closeDeal(bot.botId, DEAL_ID)
    expect(deal.deal.status).to.equal(DCADealStatusEnum.closed)
    expect(deal.deal.profit.total).to.equal(0)
    expect(deal.deal.profit.totalUsd).to.equal(0)
    // The breakdown stays on the record: what was paid and received is known.
    expect(deal.deal.commission).to.equal(ENTRY_FEES)
    expect(deal.deal.funding.total).to.equal(FUNDING)
    const lastProfit = [...bot.saved].reverse().find((u: any) => u.profit)
    expect(lastProfit.profit.total).to.equal(0)
  })

  it('§1.2 the bot total and the user profit record take nothing from it', async () => {
    const { bot } = buildBot({ flags: unknownFlags })
    await bot.closeDeal(bot.botId, DEAL_ID)
    expect(bot.data.profit.total).to.equal(0)
    expect(bot.data.profit.totalUsd).to.equal(0)
    for (const [usd, , part] of bot.userProfit) {
      expect(usd).to.equal(0)
      expect(part?.amount ?? 0).to.equal(0)
    }
  })

  it('§1.3 the "Deal closed" event says the profit is unknown, not -0.887$', async () => {
    const { bot } = buildBot({ flags: unknownFlags })
    await bot.closeDeal(bot.botId, DEAL_ID)
    expect(bot.closeEvents).to.have.length(1)
    expect(bot.closeEvents[0]).to.contain('profit: unknown')
    expect(bot.closeEvents[0]).to.not.match(/profit:\s*-?\d/)
    // V2 classifies any deal line containing "open" as an opening.
    expect(bot.closeEvents[0].toLowerCase()).to.not.contain('open')
  })

  it('§1.4 profit realised before the close (combo grid levels) is real and is still booked', async () => {
    const { bot, deal } = buildBot({ flags: unknownFlags, preProfit: 2.5 })
    await bot.closeDeal(bot.botId, DEAL_ID)
    expect(deal.deal.profit.total).to.equal(2.5)
    expect(bot.data.profit.total).to.equal(2.5)
  })

  it('§1.5 unchanged: a deal closed with no order and no "profit unknown" flag books fees and funding as before', async () => {
    const { bot, deal } = buildBot({ flags: [DCADealFlags.newMultiTp] })
    await bot.closeDeal(bot.botId, DEAL_ID)
    expect(deal.deal.profit.total).to.be.closeTo(FUNDING - ENTRY_FEES, 1e-12)
    expect(bot.data.profit.total).to.be.closeTo(FUNDING - ENTRY_FEES, 1e-12)
    expect(bot.closeEvents[0]).to.equal(
      `Deal closed, id: ${DEAL_ID}, profit: ${-ENTRY_FEES}$`,
    )
  })
})
