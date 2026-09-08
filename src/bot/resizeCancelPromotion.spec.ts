process.env.NODE_ENV = 'testing'

/**
 * A re-size cancel must never be written FILLED.
 *
 * `promotePartialToFilled: false` is the caller declaring intent: this cancel
 * is a deliberate RE-SIZE of a still-live order, not a close. Both call sites
 * (`dcaHelper.ts:10244`, the #696 tp-coverage repair, and `dcaHelper.ts:13838`,
 * `placeOrders`) pass it for the same reason — the fills the order carries are a
 * partial take profit `tpHistory` already accounts for, and promoting them to
 * FILLED sends the row to `processFilledOrder` -> `closeDeal`.
 *
 * The defect: `cancelOrderOnExchange` copies every field of the venue's cancel
 * response onto the row — `status` included — BEFORE it consults the flag, and
 * the flag is only reachable inside `order.status === 'CANCELED'`. A venue that
 * answers FILLED walks straight past the opt-out.
 *
 * Production, deal `6a90e161a76e7fe63ea3118f` (B3-USDC), 2026-09-08:
 *   13:18:25.597Z  cancelling stale take-profit D-TP-TNTUXFh6… (opt-out passed)
 *   13:18:26.055Z  row persisted FILLED, origQty 878966, executedQty 54103
 *   13:18:26.092Z  the venue's own user-stream event says CANCELED
 *
 * Spec: `specs/026.resize-cancel-promoted-and-gross-entry-double-counts-closes.md`
 * §1.1 / §4.1. Issue #717.
 * Run: `npm test` (mocha).
 *
 * No network / DB — the real method is driven off the prototype against a
 * recording transport, same shape as `cancelNoExchangeOrderId.spec.ts`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

/** The stale take-profit as production held it, verbatim. */
function tpOrder(over: Record<string, unknown> = {}) {
  return {
    symbol: 'B3-USDC',
    orderId: '9f0b2b1e-0000-0000-0000-000000000001',
    clientOrderId: 'D-TP-TNTUXFh6ohYEWhi6dK8cYPufQgEYqj',
    dealId: '6a90e161a76e7fe63ea3118f',
    typeOrder: 'dealTP',
    price: '0.0004776',
    origQty: '878966',
    executedQty: '54103',
    status: 'PARTIALLY_FILLED',
    side: 'SELL',
    updateTime: 1788873506039,
    transactTime: 1788873506039,
    ...over,
  } as any
}

/**
 * @param responseStatus what the venue's CANCEL response reports. Coinbase
 * answered `FILLED` for the order above.
 */
function botAnswering(
  responseStatus: string,
  responseExecutedQty = '54103',
  exchange = ExchangeEnum.coinbase,
) {
  const saved: any[] = []
  const bot: any = Object.create((MainBot as any).prototype)
  bot.data = { exchange, exchangeUUID: '', paperContext: false }
  bot.orders = new Map()
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    async cancelOrder() {
      return {
        status: StatusEnum.ok,
        reason: '',
        data: {
          // A cancel response echoes the whole order back. `origQty` /
          // `origPrice` / `clientOrderId` are excluded from the copy by the
          // method itself; everything else lands on the row.
          status: responseStatus,
          executedQty: responseExecutedQty,
          updateTime: 1788873506055,
          transactTime: 1788873506055,
        },
      }
    },
  }
  bot.startMethod = () => 1
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = () => undefined
  bot.emit = () => undefined
  bot.setOrder = () => undefined
  bot.deleteOrder = () => undefined
  bot.updateOrderOnDb = (o: any) => saved.push({ ...o })
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  bot.setFilledInsteadOfCanceled = async () => true
  bot.ordersDb = { readData: async () => ({ data: { result: undefined } }) }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  return { bot, saved }
}

const cancel = async (
  bot: any,
  order: any,
  promotePartialToFilled: boolean,
) => {
  bot.orders.set(order.clientOrderId, order)
  return await bot.cancelOrderOnExchange(
    order,
    true,
    true,
    promotePartialToFilled,
  )
}

describe('cancelOrderOnExchange re-size opt-out (spec 026 §4.1, issue #717)', () => {
  it('§1.1 a FILLED cancel response cannot promote a partial re-size cancel', async () => {
    // The exact production event: 54103 of 878966 sold, venue answers FILLED,
    // opt-out passed. Before the fix the row was persisted FILLED.
    const { bot, saved } = botAnswering('FILLED')
    const result = await cancel(bot, tpOrder(), false)
    expect(result.status, 'returned row').to.equal('CANCELED')
    expect(
      saved.map((o) => o.status),
      'persisted row',
    ).to.deep.equal(['CANCELED'])
  })

  it('§1.1 a PARTIALLY_FILLED cancel response is not left resting either', async () => {
    // The 19 stranded `dealTP` PARTIALLY_FILLED rows: the order is gone from
    // the venue, so the row must be terminal.
    const { bot, saved } = botAnswering('PARTIALLY_FILLED')
    const result = await cancel(bot, tpOrder(), false)
    expect(result.status).to.equal('CANCELED')
    expect(saved.map((o) => o.status)).to.deep.equal(['CANCELED'])
  })

  it('§4.1 the fills the venue reported are still kept on the row', async () => {
    const { bot } = botAnswering('FILLED')
    const result = await cancel(bot, tpOrder(), false)
    expect(+result.executedQty).to.equal(54103)
    // Never copied from the response — the row's own size is what `restingTpQty`
    // and `getTPOrder` compare against.
    expect(result.origQty).to.equal('878966')
  })

  it('§4.1 a cancel that raced a GENUINE complete fill is left FILLED', async () => {
    // executedQty >= origQty is a real close, not a re-size that lost the race.
    // The `result.status === 'FILLED'` compensation at dcaHelper.ts:13844 still
    // has to see it.
    const { bot, saved } = botAnswering('FILLED', '878966')
    const result = await cancel(bot, tpOrder(), false)
    expect(result.status).to.equal('FILLED')
    expect(saved.map((o) => o.status)).to.deep.equal(['FILLED'])
  })

  it('§5 the DEFAULT path still promotes a cancelled order carrying fills', async () => {
    // Every close / teardown caller depends on this; only the opt-out changes.
    const { bot, saved } = botAnswering('CANCELED')
    const result = await cancel(bot, tpOrder(), true)
    expect(result.status).to.equal('FILLED')
    expect(saved.map((o) => o.status)).to.deep.equal(['FILLED'])
  })

  it('§5 an untouched NEW order still cancels the way it always did', async () => {
    const { bot, saved } = botAnswering('CANCELED', '0')
    const result = await cancel(
      bot,
      tpOrder({ executedQty: '0', status: 'NEW' }),
      true,
    )
    expect(result.status).to.equal('CANCELED')
    expect(saved.map((o) => o.status)).to.deep.equal(['CANCELED'])
  })
})
