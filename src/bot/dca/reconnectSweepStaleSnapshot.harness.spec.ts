process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `211.a-reconnect-check-closes-a-deal-on-a-take-profit-it-already-re-sized`.
 *
 * Drives the REAL `checkOrdersAfterReconnect` over the real MainBot. The pass
 * reads the orders it will check once, at its start, then paces one venue
 * lookup per order. While a lookup is outstanding the bot cancels the deal's
 * partly filled take-profit as a re-size (the map copy goes `CANCELED`), and
 * the venue's answer comes back the way `getOrder` reports any cancelled
 * order that filled at all: `FILLED`. The fill handler, the DB write and the
 * coverage check are recorded, not run.
 *
 * Quantities are the production ones (spec §2); identifiers are synthetic
 * because this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { BotType, ExchangeEnum, StatusEnum } from '../../../types'

const DEAL_ID = '000000000000000000000d211'
const BOT_ID = '000000000000000000000b211'
const SYMBOL = 'SUP-USDC'

const row = (id: string, over: Record<string, unknown>) =>
  ({
    symbol: SYMBOL,
    clientOrderId: id,
    dealId: DEAL_ID,
    botId: BOT_ID,
    type: 'LIMIT',
    updateTime: 1793233803651,
    ...over,
  }) as any

/** The take-profit as the pass read it: resting, part sold. */
const partialTp = () =>
  row('D-TP-resized-partial', {
    typeOrder: 'dealTP',
    side: 'SELL',
    price: '0.003928',
    origQty: '6620.2',
    executedQty: '3929.2',
    status: 'PARTIALLY_FILLED',
  })

/** The venue's answer as `getOrder` returns it for that order once cancelled. */
const promotedAnswer = (o: any) => ({
  status: StatusEnum.ok,
  data: { ...o, status: 'FILLED', executedQty: '3929.2' },
})

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (opts: {
  orders: any[]
  /** Runs while the lookup of `id` is outstanding. */
  duringLookup?: (bot: any, id: string) => void
}) => {
  const raised = {
    filled: [] as any[],
    partial: [] as any[],
    dbWrites: [] as any[],
    coverage: 0,
  }
  const bot: any = Object.create(Helper.prototype)
  bot.raised = raised
  bot.botId = BOT_ID
  bot.botType = BotType.dca
  bot.isLong = true
  bot.math = new MathHelper()
  bot.blockCheck = false
  bot.serviceRestart = false
  bot.reconcileViaSweep = true
  bot.orderStatuses = ['NEW', 'PARTIALLY_FILLED']
  bot.data = { exchange: ExchangeEnum.coinbase, status: 'open', settings: {} }
  bot.orders = new Map<string, any>(opts.orders.map((o) => [o.clientOrderId, o]))
  bot.shouldProceed = () => true
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.getOrdersByStatusAndDealId = ({ defaultStatuses }: any) =>
    [...bot.orders.values()].filter(
      (o: any) =>
        !defaultStatuses || ['NEW', 'PARTIALLY_FILLED'].includes(o.status),
    )
  bot.primeReconcileBatch = async () => undefined
  bot.getOrderForReconcile = async (o: any) => {
    opts.duringLookup?.(bot, o.clientOrderId)
    return promotedAnswer(o)
  }
  bot.mergeCommonOrderWithOrder = async (co: any, o: any) => ({ ...o, ...co })
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.updateOrderOnDb = (o: any) => raised.dbWrites.push(o)
  bot.noteReconciledBaseEntry = () => undefined
  bot.adoptExchangeOrderId = async () => undefined
  bot.recordReconcileSweepCatch = () => undefined
  bot.processFilledOrder = (o: any) => raised.filled.push(o)
  bot.processPartiallyFilledOrder = (o: any) => raised.partial.push(o)
  bot.checkTpCoverage = async () => {
    raised.coverage++
  }
  bot.emit = () => true
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = () => undefined
  bot.startMethod = () => '1'
  bot.endMethod = () => undefined
  return bot
}

describe('reconnect check vs. an order the bot ended during the pass (spec 211)', function () {
  this.timeout(30_000)

  before(function () {
    // One ts-node compile of the helper over the real MainBot.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default()
  })

  describe('§1.1 the take-profit was cancelled as a re-size while its lookup was outstanding', () => {
    const drive = async (replace: (o: any) => any) => {
      const bot = buildBot({
        orders: [partialTp()],
        duringLookup: (b, id) => {
          const held = b.orders.get(id)
          const next = replace(held)
          if (next) b.orders.set(id, next)
          else b.orders.delete(id)
        },
      })
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      return bot
    }

    it('does not hand it to the fill handler', async () => {
      const bot = await drive((o) => ({ ...o, status: 'CANCELED' }))
      expect(bot.raised.filled).to.have.length(0)
    })

    it('does not write the FILLED answer over the cancelled row', async () => {
      const bot = await drive((o) => ({ ...o, status: 'CANCELED' }))
      expect(bot.raised.dbWrites).to.have.length(0)
      expect(bot.orders.get('D-TP-resized-partial').status).to.equal(
        'CANCELED',
      )
    })

    it('the same when the cancel mutated the very object the pass read', async () => {
      const bot = await drive((o) => {
        o.status = 'CANCELED'
        return o
      })
      expect(bot.raised.filled).to.have.length(0)
    })

    it('the same when the order has left the map', async () => {
      const bot = await drive(() => undefined)
      expect(bot.raised.filled).to.have.length(0)
      expect(bot.raised.dbWrites).to.have.length(0)
    })

    it('still runs the coverage check', async () => {
      const bot = await drive((o) => ({ ...o, status: 'CANCELED' }))
      expect(bot.raised.coverage).to.equal(1)
    })
  })

  it('§1.2 a fill the stream missed on an order still held open is still caught', async () => {
    const bot = buildBot({ orders: [partialTp()] })
    await bot.checkOrdersAfterReconnect(BOT_ID, false)
    expect(bot.raised.filled.map((o: any) => [o.clientOrderId, o.status])).to
      .deep.equal([['D-TP-resized-partial', 'FILLED']])
    expect(bot.raised.dbWrites).to.have.length(1)
  })
})
