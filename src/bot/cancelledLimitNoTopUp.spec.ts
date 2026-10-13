process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `156.kucoin-cancelled-safety-order-topped-up-at-market`.
 *
 * A KuCoin spot safety order (LIMIT, 58778.9383 STX) filled 59.9214 and was
 * then cancelled on the exchange. KuCoin's stream reports that cancel as
 * `FILLED` with the partial quantity, and `buyRemainder` sold the other
 * 58719.0169 at market as `GA-BR-…`.
 *
 * Drives the REAL `buyRemainder` off the prototype (harness shape from
 * `unfillableTopUp.spec.ts`). Nothing opens a connection.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, BotType, TypeOrderEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

type Row = Record<string, any>

/** KuCoin spot STX-USDT. */
const STX_INFO = {
  pair: 'STX-USDT',
  priceAssetPrecision: 4,
  baseAsset: {
    minAmount: 0.0001,
    maxAmount: 10000000,
    step: 0.0001,
    maxMarketAmount: 10000000,
    name: 'STX',
  },
  quoteAsset: { minAmount: 0.1, name: 'USDT' },
}

/** `D-RO-y9yZ…` as the stream delivered it at 2026-10-13T16:56:03Z. */
const makeSafetyOrder = (over: Row = {}) => ({
  clientOrderId: 'D-RO-y9yZedgZghgkgfsmxjgmQHOwi2SNPF',
  symbol: 'STX-USDT',
  side: 'SELL',
  type: 'LIMIT',
  status: 'FILLED',
  orderId: '123',
  origQty: '58778.9383',
  executedQty: '59.9214',
  price: '0.4646',
  origPrice: '0.4646',
  exchange: ExchangeEnum.kucoin,
  typeOrder: TypeOrderEnum.dealRegular,
  dealId: '6abae1e7f8528e59bae2ef86',
  reduceOnly: false,
  positionSide: undefined,
  ...over,
})

const makeBot = () => {
  const bot: any = Object.create(MainBot.prototype)
  const sent: Row[] = []
  const logs: string[] = []
  Object.assign(bot, {
    botId: '6aa9a20703617d48a1920c6c',
    botType: BotType.dca,
    math: new MathHelper(),
    partiallyFilledFilledSet: new Set(),
    data: { exchange: ExchangeEnum.kucoin, settings: {} },
    sent,
    logs,
    getExchangeInfo: async () => STX_INFO,
    getLatestPrice: async () => 0.4267,
    baseAssetPrecision: async () => 4,
    getOrderId: (p: string) => `${p}-test`,
    handleLog: (m: string) => {
      logs.push(m)
    },
    sendGridToExchange: async (grid: Row) => {
      sent.push(grid)
      return {
        clientOrderId: grid.newClientOrderId,
        side: 'SELL',
        status: 'FILLED',
        executedQty: `${grid.qty}`,
        price: '0.4267',
        transactTime: 1,
      }
    },
  })
  Object.defineProperty(bot, 'coinm', { value: false, configurable: true })
  return bot
}

describe('spec 156 — cancelled KuCoin safety order is not topped up', () => {
  it('§1.1 a cancelled, partly filled LIMIT safety order sends no remainder order and keeps what filled', async () => {
    const bot = makeBot()
    const result = await bot.buyRemainder(makeSafetyOrder())
    expect(bot.sent).to.have.length(0)
    expect(result.executedQty).to.equal('59.9214')
    expect(result.price).to.equal('0.4646')
    expect(
      bot.logs.some((l: string) => l.includes('cancelled on the exchange')),
    ).to.equal(true)
  })

  it('§1.1 the same holds for a long (BUY) safety order', async () => {
    const bot = makeBot()
    await bot.buyRemainder(makeSafetyOrder({ side: 'BUY' }))
    expect(bot.sent).to.have.length(0)
  })

  it('§1.2 a KuCoin MARKET safety order the venue ended short is still completed', async () => {
    const bot = makeBot()
    const result = await bot.buyRemainder(makeSafetyOrder({ type: 'MARKET' }))
    expect(bot.sent).to.have.length(1)
    expect(result.executedQty).to.equal('58778.9383')
  })

  it('§1.3 a KuCoin LIMIT base entry is still completed', async () => {
    const bot = makeBot()
    await bot.buyRemainder(
      makeSafetyOrder({ typeOrder: TypeOrderEnum.dealStart }),
    )
    expect(bot.sent).to.have.length(1)
  })

  it('§1.3 a KuCoin LIMIT take-profit is still completed', async () => {
    const bot = makeBot()
    await bot.buyRemainder(makeSafetyOrder({ typeOrder: TypeOrderEnum.dealTP }))
    expect(bot.sent).to.have.length(1)
  })

  it('§1.3 another venue’s short FILLED LIMIT safety order is still completed', async () => {
    const bot = makeBot()
    await bot.buyRemainder(makeSafetyOrder({ exchange: ExchangeEnum.binance }))
    expect(bot.sent).to.have.length(1)
  })
})
