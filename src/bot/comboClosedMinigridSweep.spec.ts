process.env.NODE_ENV = 'testing'

/**
 * Spec 259: when a combo minigrid closes, every grid order still resting for
 * it is cancelled, including ones the in-memory grid lost track of.
 *
 * Fixture: a DCA-level minigrid that sold out during a fast rally. While fills
 * raced each other it had four buys resting at once and was tracking two; the
 * close cancelled those two and left the others on the book, where a fall back
 * to their prices buys for a grid that no longer exists. Synthetic ids.
 *
 * Drives the REAL `comboHelper.cancelOrdersOfClosedMinigrid` off the mixin.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { TypeOrderEnum } from '../../types'

const CLOSED = '000000000000000000000c59'
const OTHER = '000000000000000000000a59'

const order = (price: number, over: Record<string, unknown> = {}): any => ({
  clientOrderId: `CMB-GR-${price}`,
  dealId: 'deal-a',
  minigridId: CLOSED,
  symbol: 'RXYZUSDT',
  side: 'BUY',
  status: 'NEW',
  typeOrder: TypeOrderEnum.dealGrid,
  price: `${price}`,
  ...over,
})

let Helper: any

const build = (opts: { minigridStatus?: string } = {}) => {
  const resting = [
    order(152.88),
    order(154.49),
    order(156.1),
    order(157.71),
    order(160.93, { minigridId: OTHER }),
    order(152.88, { typeOrder: TypeOrderEnum.dealRegular, minigridId: '' }),
  ]
  const cancelled: string[] = []
  class TestBot extends (Helper as any) {
    botId = 'bot'
    getMinigrid(id: string) {
      return id === CLOSED && opts.minigridStatus
        ? { schema: { _id: id, status: opts.minigridStatus } }
        : undefined
    }
    getOrdersByStatusAndDealId() {
      return resting
    }
    async cancelOrderOnExchange(o: any) {
      cancelled.push(o.clientOrderId)
    }
    handleLog() {}
    handleWarn() {}
  }
  return { bot: new TestBot() as any, cancelled }
}

describe('closed minigrid leaves no resting orders (spec 259)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./comboHelper').default()
  })

  it("cancels every resting order of the closed grid, tracked or not", async () => {
    const { bot, cancelled } = build()
    await bot.cancelOrdersOfClosedMinigrid(CLOSED)
    expect(cancelled).to.deep.equal([
      'CMB-GR-152.88',
      'CMB-GR-154.49',
      'CMB-GR-156.1',
      'CMB-GR-157.71',
    ])
  })

  it("leaves other grids' orders and the deal's DCA order alone", async () => {
    const { bot, cancelled } = build()
    await bot.cancelOrdersOfClosedMinigrid(CLOSED)
    expect(cancelled).to.not.include('CMB-GR-160.93')
    expect(cancelled.filter((c) => c === 'CMB-GR-152.88')).to.have.length(1)
  })

  it('does nothing for a grid that is still active', async () => {
    const { bot, cancelled } = build({ minigridStatus: 'active' })
    await bot.cancelOrdersOfClosedMinigrid(CLOSED)
    expect(cancelled).to.have.length(0)
  })
})
