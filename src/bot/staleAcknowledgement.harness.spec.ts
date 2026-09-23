process.env.NODE_ENV = 'testing'

/**
 * Spec `090` §1.2/§4.2 — a `NEW` acknowledgement delivered after the fill it
 * precedes must not rewind the order.
 *
 * Driven over the REAL `convertExecutionReportToOrder` (`main.ts`), because the
 * defect IS that method's merge: it copies `msg.orderStatus` and
 * `msg.totalTradeQuantity` onto the row it holds with no reference to which
 * report is newer. Replaying the production sequence through it is the only
 * way to show the rewind and then its absence.
 *
 * The production sequence (Kraken spot, a DCA base entry, 2026-09-20; the
 * quantities are the real ones, the identifiers are synthetic because this
 * file is public):
 *
 *   12:35:50.972  PARTIALLY_FILLED  base 27.66356  quote 100.24998  t 1789907750866
 *   12:35:50.982  NEW               base 0         quote 0          t 1789907750864
 *   12:35:50.984  NEW               base 0         quote 0          t 1789907750864
 *
 * Ten seconds later the reposition timer read the rewound row and took
 * `checkBaseOrder`'s "not filled. Create new one" arm.
 *
 * Run: `npm test` (mocha). No network / DB.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import { ExchangeEnum, type ExecutionReport, type Order } from '../../types'
import { shouldSettlePartialBaseEntry } from './dca/partialBaseEntry'
import { DCADealStatusEnum } from '../../types'

const SYMBOL = 'NEAR-USD'
const CLIENT_ORDER_ID = 'D-BO-0000000000000090'
const DEAL_ID = '000000000000000000000d90'
const BOT_ID = '000000000000000000000b90'
const USER_ID = '000000000000000000000490'

const FILLED_AT = 1789907750866
const ACK_AT = 1789907750864

/** The base entry as it was placed: acknowledged, nothing executed yet. */
const restingBaseOrder = () =>
  ({
    symbol: SYMBOL,
    baseAsset: 'NEAR',
    quoteAsset: 'USD',
    orderId: 'AAAAAA-BBBBB-CCCCCC',
    clientOrderId: CLIENT_ORDER_ID,
    dealId: DEAL_ID,
    typeOrder: 'dealStart',
    type: 'LIMIT',
    side: 'BUY',
    price: '3.6239',
    origPrice: '3.6239',
    origQty: '27.66356687',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    updateTime: ACK_AT - 2,
    transactTime: ACK_AT - 2,
    botId: BOT_ID,
    userId: USER_ID,
    exchange: ExchangeEnum.kraken,
    exchangeUUID: '',
  }) as unknown as Order

const report = (
  orderStatus: string,
  totalTradeQuantity: string,
  totalQuoteTradeQuantity: string,
  orderTime: number,
): ExecutionReport =>
  ({
    eventType: 'executionReport',
    eventTime: orderTime,
    creationTime: orderTime,
    orderTime,
    newClientOrderId: CLIENT_ORDER_ID,
    originalClientOrderId: CLIENT_ORDER_ID,
    orderId: 'AAAAAA-BBBBB-CCCCCC',
    orderStatus,
    orderType: 'LIMIT',
    price: '3.6239',
    quantity: '27.66356687',
    side: 'BUY',
    symbol: SYMBOL,
    totalTradeQuantity,
    totalQuoteTradeQuantity,
  }) as unknown as ExecutionReport

/** The venue's own order of events. */
const PART_FILL = report('PARTIALLY_FILLED', '27.66356', '100.24998', FILLED_AT)
/** Delivered after it, dated before it. */
const ACKNOWLEDGEMENT = report('NEW', '0', '0', ACK_AT)

const loadModule = createRequire(__filename)
let Helper: ReturnType<typeof requireHelper>
const requireHelper = () =>
  loadModule('./dcaHelper').default() as new (...args: unknown[]) => unknown

const buildBot = () => {
  const order = restingBaseOrder()
  const logs: string[] = []
  const bot: any = Object.create((Helper as any).prototype)
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.data = {
    exchange: ExchangeEnum.kraken,
    exchangeUUID: '',
    settings: {},
  }
  bot.math = new MathHelper()
  bot.orders = new Map<string, Order>([[order.clientOrderId, order]])
  bot.logs = logs
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.setOrder = (o: Order) => bot.orders.set(o.clientOrderId, o)
  bot.getExchangeInfo = async () => ({
    baseAsset: { name: 'NEAR', minAmount: 0 },
    quoteAsset: { name: 'USD', minAmount: 0 },
    priceAssetPrecision: 4,
    baseAssetPrecision: 8,
  })
  bot.ordersDb = { readData: async () => ({ data: { result: undefined } }) }
  bot.handleLog = (l: string) => logs.push(l)
  bot.handleDebug = (l: string) => logs.push(l)
  bot.handleWarn = (l: string) => logs.push(l)
  bot.handleErrors = () => undefined
  return bot
}

/**
 * What the stream consumer does with a converted report: `processOrderQueue`
 * writes back whatever it is handed, and drops the message when the converter
 * answers `null`.
 */
const deliver = async (bot: any, msg: ExecutionReport) => {
  const converted = (await bot.convertExecutionReportToOrder(
    msg,
    true,
  )) as Order | null
  if (converted) {
    bot.setOrder(converted)
  }
  return converted
}

describe('an acknowledgement delivered after the fill (spec 090)', () => {
  before(function () {
    // One ts-node compile of the helper over the real MainBot.
    this.timeout(180000)
    Helper = requireHelper()
  })

  it('§1.2 does not rewind the part-filled row to NEW / 0', async () => {
    const bot = buildBot()
    await deliver(bot, PART_FILL)
    expect(bot.getOrderFromMap(CLIENT_ORDER_ID).status).to.equal(
      'PARTIALLY_FILLED',
    )

    await deliver(bot, ACKNOWLEDGEMENT)
    await deliver(bot, ACKNOWLEDGEMENT)

    const held = bot.getOrderFromMap(CLIENT_ORDER_ID)
    expect(held.status, 'status after the stale acknowledgements').to.equal(
      'PARTIALLY_FILLED',
    )
    expect(held.executedQty, 'executed quantity').to.equal('27.66356')
    expect(held.updateTime, 'the row keeps the newest report it saw').to.equal(
      FILLED_AT,
    )
  })

  it('§1.2 leaves the part-filled entry settleable, not re-placeable', async () => {
    const bot = buildBot()
    await deliver(bot, PART_FILL)
    await deliver(bot, ACKNOWLEDGEMENT)
    const held = bot.getOrderFromMap(CLIENT_ORDER_ID)

    // The reading `checkBaseOrder` does ten seconds later. Rewound, this is
    // false and the entry falls through to "not filled. Create new one",
    // which cancels it and places a second base order on the same position.
    expect(
      shouldSettlePartialBaseEntry({
        orderStatus: held.status,
        dealStatus: DCADealStatusEnum.start,
        executedQty: held.executedQty,
        updateTime: held.updateTime,
        hasPendingCheck: false,
      }),
      'the settle is still reachable',
    ).to.equal(true)
  })

  it('§4.2 says so where it can be read in production', async () => {
    const bot = buildBot()
    await deliver(bot, PART_FILL)
    bot.logs.length = 0
    const dropped = await deliver(bot, ACKNOWLEDGEMENT)
    expect(dropped, 'the report is not processed').to.equal(null)
    expect(bot.logs.join('\n')).to.match(/older than/i)
  })

  it('§4.1 still applies an acknowledgement that is the newest report', async () => {
    const bot = buildBot()
    // Ordinary delivery: the ack arrives first, against the resting row.
    const converted = await deliver(bot, ACKNOWLEDGEMENT)
    expect(converted, 'a NEW that is not older is processed').to.not.equal(null)
    expect(bot.getOrderFromMap(CLIENT_ORDER_ID).status).to.equal('NEW')
  })

  it('§4.1 still applies every report that moves the order forward', async () => {
    const bot = buildBot()
    await deliver(bot, PART_FILL)
    // The venue's terminal report, dated BEFORE the fill it follows — an
    // ordering this rule must never touch, because it is how the engine
    // learns the order ended.
    const cancel = await deliver(
      bot,
      report('CANCELED', '27.66356', '100.24998', ACK_AT),
    )
    expect(cancel, 'a terminal report is never refused').to.not.equal(null)
    expect(bot.getOrderFromMap(CLIENT_ORDER_ID).status).to.equal('CANCELED')
  })
})
