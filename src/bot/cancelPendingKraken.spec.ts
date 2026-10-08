process.env.NODE_ENV = 'testing'

/**
 * Kraken answers a cancel it has accepted but not yet finalised with
 * `WOrder:Cancel pending` — a warning, not a refusal. The cancel path must
 * treat it like the other venues' "cancellation in progress" wordings: wait,
 * re-read the order, and raise no bot error.
 *
 * Run: `npm test` (mocha). No network / DB — the real method runs off the
 * prototype against a recording transport.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

function botAnswering(reason: string) {
  const rec = { unknown: [] as string[], errors: [] as string[] }
  const bot: any = Object.create((MainBot as any).prototype)
  bot.data = {
    exchange: ExchangeEnum.kraken,
    exchangeUUID: '',
    paperContext: false,
  }
  bot.orders = new Map()
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    cancelOrder: async () => ({ status: StatusEnum.notok, reason, data: null }),
  }
  bot.startMethod = () => 1
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = (r: string) => rec.errors.push(r)
  bot._handleUnknownOrder = async (id: string) => {
    rec.unknown.push(id)
    return null
  }
  const order = {
    symbol: 'ETH-EUR',
    orderId: 'OABCDE-FGHIJ-KLMNOP',
    clientOrderId: 'D-TP-hTAZXhwALx2wa',
    status: 'NEW',
  } as any
  bot.orders.set(order.clientOrderId, order)
  return { bot, rec, order }
}

describe('cancelOrderOnExchange: Kraken "WOrder:Cancel pending"', () => {
  it('re-reads the order instead of raising a bot error', async () => {
    const { bot, rec, order } = botAnswering('WOrder:Cancel pending')
    await bot.cancelOrderOnExchange(order)
    expect(rec.errors).to.deep.equal([])
    expect(rec.unknown).to.deep.equal(['D-TP-hTAZXhwALx2wa'])
  })

  it('still raises a bot error for an unrelated refusal', async () => {
    const { bot, rec, order } = botAnswering('EGeneral:Internal error')
    await bot.cancelOrderOnExchange(order)
    expect(rec.errors).to.deep.equal(['EGeneral:Internal error'])
    expect(rec.unknown).to.deep.equal([])
  })
})
