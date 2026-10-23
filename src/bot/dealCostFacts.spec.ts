process.env.NODE_ENV = 'testing'

/**
 * `recordDealCostFacts` (main-app spec 050 §4.1): at close the engine writes
 * the deal's MARKET slippage and whether its fee figure includes an estimate,
 * from the orders it holds, so the API never rescans a closed deal.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'

let Helper: any

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0050'

const makeBot = (orders: any[], settings: any = {}, combo = false) => {
  const saves: any[] = []
  class TestBot extends Helper {
    public math = new MathHelper()
    public combo = combo
    public data: any = { settings }
    getOrdersByStatusAndDealId() {
      return orders
    }
    saveDeal(_d: any, update: any, send: boolean) {
      saves.push({ update, send })
    }
    handleDebug() {}
  }
  const bot: any = Object.create(TestBot.prototype)
  bot.combo = combo
  bot.data = { settings }
  return { bot, saves }
}

const fullDeal = { deal: { _id: DEAL_ID } }

describe('close-time cost facts (spec 050 §4.1)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('writes slippage and feesEstimated without emitting a deal update', () => {
    const { bot, saves } = makeBot(
      [
        {
          type: 'MARKET',
          status: 'FILLED',
          side: 'BUY',
          typeOrder: 'dealStart',
          origPrice: '99.5',
          executedQty: '1',
          price: '100',
          feePaid: '0.1',
        },
        {
          type: 'MARKET',
          status: 'FILLED',
          side: 'SELL',
          typeOrder: 'dealTP',
          origPrice: '110',
          refPrice: '110',
          executedQty: '1',
          price: '109.89',
        },
        {
          type: 'LIMIT',
          status: 'CANCELED',
          side: 'BUY',
          typeOrder: 'dealRegular',
          executedQty: '0',
          price: '90',
        },
      ],
      { type: 'regular', startOrderType: 'MARKET' },
    )
    bot.recordDealCostFacts(fullDeal)
    expect(saves).to.have.length(1)
    expect(saves[0].send).to.equal(false)
    const { slippage, feesEstimated } = saves[0].update
    expect(feesEstimated).to.equal(true)
    expect(slippage.orders).to.equal(2)
    expect(slippage.reconstructed).to.equal(true)
    expect(slippage.quote).to.be.closeTo(0.11, 1e-9)
  })

  it('combo base orders are not reconstructed; no counted order → no slippage key', () => {
    const { bot, saves } = makeBot(
      [
        {
          type: 'LIMIT',
          status: 'FILLED',
          side: 'BUY',
          typeOrder: 'dealStart',
          executedQty: '1',
          price: '100',
          feePaid: '0.1',
        },
      ],
      {},
      true,
    )
    bot.recordDealCostFacts(fullDeal)
    expect(saves[0].update).to.deep.equal({ feesEstimated: false })
  })
})
