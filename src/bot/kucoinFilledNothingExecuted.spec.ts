process.env.NODE_ENV = 'testing'

/**
 * A FILLED order with nothing executed and no fills is not booked at its
 * requested size on a venue that always reports the executed size. KuCoin
 * closes a market order it cannot execute (e.g. for lack of funds) and an
 * older connector reported it FILLED with `executedQty` 0; booking `origQty`
 * then claimed coins the deal never bought.
 *
 * Drives the REAL `convertOrderExecutedQty` off the prototype. Fixture ids are
 * synthetic — this file is public. Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum } from '../../types'
import MainBot from './main'

const makeBot = (exchange: ExchangeEnum) => {
  const bot: any = Object.create(MainBot.prototype)
  const logs: string[] = []
  bot.data = { exchange, settings: {} }
  bot.getExchangeInfo = async () => null
  bot.handleLog = (m: string) => logs.push(m)
  return { bot, logs }
}

const order = (o: Record<string, unknown> = {}) =>
  ({
    clientOrderId: 'D-RO-test1',
    symbol: 'AAA-USDT',
    type: 'MARKET',
    status: 'FILLED',
    origQty: '379.7',
    executedQty: '0',
    fills: [],
    ...o,
  }) as any

describe('FILLED with nothing executed', () => {
  for (const ex of [
    ExchangeEnum.kucoin,
    ExchangeEnum.kucoinLinear,
    ExchangeEnum.kucoinInverse,
  ]) {
    it(`${ex}: is not booked at origQty`, async () => {
      const { bot, logs } = makeBot(ex)
      expect(await bot.convertOrderExecutedQty(order())).to.equal('0')
      expect(logs.join('\n')).to.contain('no real fill')
    })
  }

  it('kucoin: a real fill keeps its executed size', async () => {
    const { bot } = makeBot(ExchangeEnum.kucoin)
    expect(
      await bot.convertOrderExecutedQty(order({ executedQty: '379.7' })),
    ).to.equal('379.7')
    expect(
      await bot.convertOrderExecutedQty(
        order({ fills: [{ qty: '100' }, { qty: '50' }] }),
      ),
    ).to.equal('150')
  })

  it('a venue that may not echo the size still falls back to origQty', async () => {
    const { bot } = makeBot(ExchangeEnum.binance)
    expect(await bot.convertOrderExecutedQty(order())).to.equal('379.7')
  })
})
