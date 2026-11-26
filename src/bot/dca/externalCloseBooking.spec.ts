process.env.NODE_ENV = 'testing'

/**
 * Spec `277` §1.1 — the REAL `closeDeal` books a deal closed outside the bot
 * at the price and fee of the venue's closing fills.
 *
 * The ledger is a long futures combo deal's as stored at close: 1083 base
 * still held, 7.35874 quote left of a 45.75782 allocation, 0.01363172 of
 * entry fees. Its position was liquidated at about 0.0295. Before spec 277 it
 * closed through the no-price branch and booked only its earlier realised
 * profit minus fees, a few cents; the 1083 base were never priced.
 *
 * Run: npx mocha -r ts-node/register src/bot/dca/externalCloseBooking.spec.ts
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  DCADealStatusEnum,
  ExchangeEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d78'
const ENTRY_FEES = 0.01363172
const EXIT = 0.0295
const EXIT_FEE = 1083 * EXIT * 0.0006

class FakeBase {
  botId = '000000000000000000000b78'
  userId = '000000000000000000000478'
  botType = 'combo'
  loadingComplete = true
  data: any = {
    exchange: ExchangeEnum.bitgetUsdm,
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

const buildBot = () => {
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
      initialBalances: { base: 0, quote: 45.75782 },
      currentBalances: { base: 1083, quote: 7.35874 },
      profit: { total: -0.0015, totalUsd: -0.0015, pureBase: 0, pureQuote: 0 },
      lastPrice: 0.03428,
      avgPrice: 0.03545,
    },
  }
  const saved: any[] = []
  class TestBot extends Helper {
    saved = saved
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
    saveProfitToDb() {}
    saveDeal(_d: any, u: any) {
      saved.push(u)
    }
    updateData() {}
    emit() {}
    async processDealClose() {
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

describe('spec 277 §1.1 — closeDeal books an outside close from the venue fills', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  const priced = 7.35874 + 1083 * EXIT - (45.75782 + -0.0015)

  it('with the fills’ fee: the 1083 base are sold at the fills’ price, net of entry and exit fees', async () => {
    const { bot, deal } = buildBot()
    await bot.closeDeal(bot.botId, DEAL_ID, undefined, EXIT, EXIT_FEE)
    expect(deal.deal.status).to.equal(DCADealStatusEnum.closed)
    expect(deal.deal.currentBalances.base).to.equal(0)
    expect(deal.deal.lastPrice).to.equal(EXIT)
    expect(deal.deal.commission).to.be.closeTo(ENTRY_FEES + EXIT_FEE, 1e-12)
    expect(deal.deal.profit.total).to.be.closeTo(
      -0.0015 + priced - ENTRY_FEES - EXIT_FEE,
      1e-9,
    )
    // A loss of several USDT, not a few cents.
    expect(deal.deal.profit.total).to.be.lessThan(-6)
    expect(bot.data.profit.total).to.be.closeTo(
      priced - ENTRY_FEES - EXIT_FEE,
      1e-9,
    )
    expect(bot.saved.at(-1).commission).to.be.closeTo(ENTRY_FEES + EXIT_FEE, 1e-12)
  })

  it('without the fee argument the liquidation branch books exactly as before (OKX/Bybit reports)', async () => {
    const { bot, deal } = buildBot()
    await bot.closeDeal(bot.botId, DEAL_ID, undefined, EXIT)
    expect(deal.deal.profit.total).to.be.closeTo(-0.0015 + priced, 1e-9)
    expect(deal.deal.commission).to.equal(undefined)
    expect(bot.saved.at(-1)).to.not.have.property('commission')
  })
})
