process.env.NODE_ENV = 'testing'

/**
 * Adaptive close for the RESTING take-profit. A spot deal a few units short of
 * its own TP (fee dust, or a sibling bot on the same pair and account) had no
 * TP at all: every placement was refused for balance and error-stated the bot.
 * With `adaptiveClose` on, `sendTpAtFreeBalance` re-sends it at the wallet's
 * free base, never more than the deal holds, and marks it so `placeOrders`
 * keeps it instead of cancelling it back to full size.
 *
 * Drives the real `dcaHelper` over a minimal base class. Synthetic ids.
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, OrderSideEnum, TypeOrderEnum } from '../../../types'

const PAIR = 'BTC-USDC'
const ED: any = {
  pair: PAIR,
  priceAssetPrecision: 1,
  baseAsset: { name: 'BTC', minAmount: 0.00001 },
  quoteAsset: { name: 'USDC', minAmount: 1 },
}

class FakeBase {
  math = new MathHelper()
  botId = '000000000000000000000b99'
  userId = '000000000000000000000499'
  futures = false
  combo = false
  isLong = true
  orders = new Map()
  data: any = {
    settings: { pair: [PAIR], adaptiveClose: true },
    exchange: ExchangeEnum.okx,
    exchangeUUID: 'uuid-99',
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const build = (o: {
  walletFree: number
  dealSize: number
  quoteFree?: number
  precision?: number
}) => {
  class TestBot extends Helper {
    sent: any[] = []
    logs: string[] = []
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
    async checkAssets() {
      return new Map([
        ['BTC', { free: o.walletFree, locked: 0 }],
        ['USDC', { free: o.quoteFree ?? 0, locked: 0 }],
      ])
    }
    async baseAssetPrecision() {
      return o.precision ?? 8
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async sendGridToExchange(order: any, options: any) {
      this.sent.push({ order, options })
      return { ...order, status: 'NEW' }
    }
  }
  const bot: any = new TestBot()
  const deal: any = {
    deal: { _id: 'd1', size: o.dealSize, tpHistory: [] },
  }
  return { bot, deal }
}

const tp = {
  qty: 0.00048559,
  price: 84306.4,
  side: OrderSideEnum.sell,
  type: TypeOrderEnum.dealTP,
  newClientOrderId: 'D-TP-fixture99abc',
}
const opts: any = { dealId: 'd1', type: 'LIMIT' }

describe('adaptive close re-sizes a refused resting TP', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('places the TP at the free balance, tagged with what it was shrunk from', async () => {
    const { bot, deal } = build({
      walletFree: 0.000470188905,
      dealSize: 0.0004873,
    })
    const res = await bot.sendTpAtFreeBalance(deal, tp, opts, ED)
    expect(res?.status).to.equal('NEW')
    expect(bot.sent).to.have.length(1)
    expect(bot.sent[0].order.qty).to.equal(0.00047018)
    expect(bot.sent[0].options.acBefore).to.equal(tp.qty)
    expect(bot.sent[0].options.acAfter).to.equal(0.00047018)
    expect(bot.sent[0].order.newClientOrderId).to.not.equal(tp.newClientOrderId)
  })

  it('never sells more than the deal holds, however much the wallet has free', async () => {
    const { bot, deal } = build({ walletFree: 0.01, dealSize: 0.0004 })
    await bot.sendTpAtFreeBalance(deal, tp, opts, ED)
    expect(bot.sent[0].order.qty).to.equal(0.0004)
  })

  it('does nothing when the free balance already covers the TP', async () => {
    const { bot, deal } = build({ walletFree: 0.001, dealSize: 0.001 })
    expect(await bot.sendTpAtFreeBalance(deal, tp, opts, ED)).to.equal(
      undefined,
    )
    expect(bot.sent).to.have.length(0)
  })

  it('does nothing below the exchange minimum', async () => {
    const { bot, deal } = build({ walletFree: 0.000005, dealSize: 0.0004873 })
    expect(await bot.sendTpAtFreeBalance(deal, tp, opts, ED)).to.equal(
      undefined,
    )
    expect(bot.sent).to.have.length(0)
  })

  // Spec 053 §4.6. `deal.size` is a running float sum, so the deal-own term
  // can carry drift (`245.60000000000002`) that Binance refuses with -1111
  // "too much precision" — the retry failed for a reason it then repeated.
  it('sends the shrunken amount on the base step, even when the deal size carries float drift', async () => {
    const { bot, deal } = build({
      walletFree: 1000,
      dealSize: 245.60000000000002,
      precision: 2,
    })
    await bot.sendTpAtFreeBalance(
      deal,
      { ...tp, qty: 245.74, price: 0.5 },
      opts,
      ED,
    )
    expect(bot.sent).to.have.length(1)
    expect(bot.sent[0].order.qty).to.equal(245.6)
    expect(bot.sent[0].options.acAfter).to.equal(245.6)
  })

  // Spec 053 §4.7. A SHORT spot deal closes with a BUY, funded in QUOTE: the
  // free base of the wallet says nothing about whether it can be paid for.
  it('sizes a BUY close from the free quote at the TP price, rounded down', async () => {
    const { bot, deal } = build({
      walletFree: 1000,
      quoteFree: 50,
      dealSize: 0.001,
    })
    await bot.sendTpAtFreeBalance(
      deal,
      { ...tp, qty: 0.001, price: 60000, side: OrderSideEnum.buy },
      opts,
      ED,
    )
    expect(bot.sent).to.have.length(1)
    // 50 / 60000 = 0.000833333… → floored to 8 dp
    expect(bot.sent[0].order.qty).to.equal(0.00083333)
  })
})
