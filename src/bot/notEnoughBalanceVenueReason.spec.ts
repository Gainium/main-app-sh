process.env.NODE_ENV = 'testing'

/**
 * Spec `specs/265.not-enough-balance-message-quotes-the-venue-reply.md`.
 *
 * When the venue refuses an order for funds, `handleOrderErrors` writes the
 * "Not enough balance" bot event from OUR stored balance row. If that row
 * disagrees with the venue (the Bitget cross case: a free balance that
 * ignores open losses), the message read "free 2,000 / required 900" with
 * nothing saying the exchange was the one that refused, or why. The venue's
 * own reply now rides along in the message.
 *
 * Run: `npm test` (mocha). Drives the real method off the prototype; every
 * DB / balance read is stubbed.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { OrderSideEnum, TypeOrderEnum } from '../../types'

const REPLY = 'the order amount exceeds the balance'

function makeBot() {
  const bot: any = Object.create((MainBot as any).prototype)
  const events: any[] = []
  const errors: any[] = []
  bot.botId = 'b'
  bot.userId = 'u'
  bot.data = { settings: {}, notEnoughBalance: {} }
  bot.updateNotEnoughBalanceErrors = () => undefined
  bot.markGridOrderStuck = () => undefined
  bot.getAssetBalanceAndRequiredByOrder = async () => ({
    asset: 'USDT',
    balance: { free: 3000, locked: 7000 },
    required: 935,
  })
  bot.spendableForNotEnoughBalance = async (_a: string, free: number) => free
  bot.botEventDb = {
    createData: async (d: any) => {
      events.push(d)
      return { status: 'NOTOK' }
    },
  }
  bot.processError = (...args: any[]) => errors.push(args)
  return { bot, events, errors }
}

const order = {
  clientOrderId: 'D-RO-1',
  side: OrderSideEnum.buy,
  price: '47.61',
  typeOrder: TypeOrderEnum.dealRegular,
  symbol: 'XAGUSDT',
  quoteAsset: 'USDT',
  baseAsset: 'XAG',
} as any

describe('handleOrderErrors — Not enough balance quotes the venue reply', () => {
  it('§1.1 the bot event and the bot message carry the venue reason', async () => {
    const { bot, events, errors } = makeBot()
    await bot.handleOrderErrors(new Error(REPLY), order, 'placeOrder')
    expect(events).to.have.length(1)
    expect(events[0].description).to.contain(`exchange reply - ${REPLY}`)
    // processError(botId, subType, terminal, setError, sendError, message, …)
    expect(errors[0][1]).to.equal('Not enough balance')
    expect(errors[0][5]).to.contain(`exchange reply - ${REPLY}`)
  })

  it('§1.2 the existing message prefix and figures are unchanged', async () => {
    const { bot, events } = makeBot()
    await bot.handleOrderErrors(REPLY, order, 'placeOrder')
    expect(events[0].description).to.match(
      /^Error: Not enough balance Order id: D-RO-1, side: buy, price - 47\.61 , order type: DCA, balance total - 10000 USDT, free - 3000 USDT, required - 935 USDT/,
    )
  })
})
