process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `295.dca-take-profit-not-replaced-over-a-refused-cancel`.
 *
 * Drives the REAL `dcaHelper.checkTPOrder` (and its re-check) over the OKX
 * sequence recorded in prod (spec §2): the take-profit reposition found the
 * old TP unfilled, its cancel was refused with "Systems are busy", and a
 * replacement was placed 0.6 s later anyway — a second closing order for the
 * same deal while the first was still resting.
 *
 * Nothing here opens a connection: the venue cancel is answered by the test,
 * and `closeDealById` (which places the replacement) is recorded.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0295'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0295'
const TP_ID = 'D-TP-old0295'

const tpRow = (status = 'NEW') => ({
  clientOrderId: TP_ID,
  orderId: '3100000000000000001',
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'XRP-USDT-SWAP',
  side: 'BUY',
  type: 'LIMIT',
  typeOrder: 'dealTP',
  status,
  price: '2.1',
  origQty: '10',
  executedQty: '0',
  updateTime: 1795700788993,
})

let Helper: any

type Answer = 'busy' | 'unresolved' | 'CANCELED' | 'NEW' | 'FILLED'

const makeBot = (answers: Answer[]) => {
  const placed: any[] = []
  const cancels: string[] = []
  const unknown: any[] = []
  const stored: { row: any } = { row: tpRow() }
  class TestBot extends Helper {
    public math = new MathHelper()
    public orders = new Map<string, any>([[TP_ID, tpRow()]])
    public deals = new Map()
    public dealTimersMap = new Map()
    public botId = BOT_ID
    public hyperliquid = false
    public data: any = { exchange: ExchangeEnum.okxLinear, settings: {} }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    async findOwnOrder(id: string) {
      return this.orders.get(id) ?? (id === TP_ID ? stored.row : undefined)
    }
    getOrdersByStatusAndDealId() {
      return [...this.orders.values()]
    }
    async cancelOrderOnExchange(o: any) {
      cancels.push(o.clientOrderId)
      const a = answers.shift() ?? 'busy'
      // `cancelOrderOnExchange` returns nothing on a refusal it only reports
      // ("Systems are busy", rate limit, lockout), and `_handleUnknownOrder`
      // answers `null` when it cannot settle the order.
      if (a === 'busy') return undefined
      if (a === 'unresolved') return null
      this.orders.delete(o.clientOrderId)
      return { ...o, status: a }
    }
    handleUnknownOrder(o: any) {
      unknown.push(o)
    }
    closeDealById(...args: any[]) {
      placed.push({ args, replacement: this.closeReplacements?.has(DEAL_ID) })
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
  }
  const bot = new (TestBot as any)()
  return { bot, placed, cancels, unknown, stored }
}

const check = (bot: any) =>
  bot.checkTPOrder(BOT_ID, TP_ID, DEAL_ID, 'leave', true, false, false)

/** Run the armed re-check now instead of waiting out the back-off. */
const fireRecheck = async (bot: any) => {
  const timer = bot.dealTimersMap.get(DEAL_ID)?.limitTimer
  expect(timer, 're-check armed').to.not.equal(null)
  expect(timer, 're-check armed').to.not.equal(undefined)
  const run = timer._onTimeout
  clearTimeout(timer)
  await run()
}

const clearTimers = (bot: any) => {
  for (const t of bot.dealTimersMap.values()) {
    if (t.limitTimer) clearTimeout(t.limitTimer)
  }
}

describe('take profit not replaced over a refused cancel (spec 295)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§1.1 an unanswered cancel places nothing', () => {
    it('OKX "Systems are busy": no replacement, a re-check is armed', async () => {
      const { bot, placed, cancels } = makeBot(['busy'])
      await check(bot)
      expect(cancels).to.deep.equal([TP_ID])
      expect(placed).to.have.length(0)
      expect(bot.closeReplacements?.has(DEAL_ID) ?? false).to.equal(false)
      expect(bot.dealTimersMap.get(DEAL_ID)?.limitTimer).to.be.ok
      clearTimers(bot)
    })

    it('a lookup that could not settle the order (null): no replacement', async () => {
      const { bot, placed } = makeBot(['unresolved'])
      await check(bot)
      expect(placed).to.have.length(0)
      expect(bot.dealTimersMap.get(DEAL_ID)?.limitTimer).to.be.ok
      clearTimers(bot)
    })
  })

  describe('§1.3 the re-check places the replacement once the old TP is gone', () => {
    it('busy, then the re-cancel answers not-found → CANCELED: one replacement', async () => {
      const { bot, placed, cancels } = makeBot(['busy', 'CANCELED'])
      await check(bot)
      expect(placed).to.have.length(0)
      await fireRecheck(bot)
      expect(cancels).to.deep.equal([TP_ID, TP_ID])
      expect(placed).to.have.length(1)
      expect(placed[0].replacement).to.equal(true)
      expect(placed[0].args.slice(0, 3)).to.deep.equal([BOT_ID, DEAL_ID, 'leave'])
    })

    it('busy twice: still held, the back-off grows', async () => {
      const { bot, placed } = makeBot(['busy', 'busy'])
      await check(bot)
      await fireRecheck(bot)
      expect(placed).to.have.length(0)
      expect(bot.tpRecheckAttempts.get(TP_ID)).to.equal(2)
      clearTimers(bot)
    })

    it('the venue report dropped the order from the map, row CANCELED: replaced with no second cancel', async () => {
      const { bot, placed, cancels, stored } = makeBot(['busy'])
      await check(bot)
      // The cancel landed late; the stream report finished the row.
      bot.orders.delete(TP_ID)
      stored.row = tpRow('CANCELED')
      await fireRecheck(bot)
      expect(cancels).to.deep.equal([TP_ID])
      expect(placed).to.have.length(1)
      expect(placed[0].replacement).to.equal(true)
    })

    it('the old TP filled meanwhile: nothing is placed', async () => {
      const { bot, placed, stored } = makeBot(['busy'])
      await check(bot)
      bot.orders.delete(TP_ID)
      stored.row = tpRow('FILLED')
      await fireRecheck(bot)
      expect(placed).to.have.length(0)
    })
  })

  describe('§1.4 an answered cancel is unchanged', () => {
    it('CANCELED: replaced at once', async () => {
      const { bot, placed } = makeBot(['CANCELED'])
      await check(bot)
      expect(placed).to.have.length(1)
      expect(placed[0].replacement).to.equal(true)
      expect(bot.dealTimersMap.get(DEAL_ID)?.limitTimer ?? null).to.equal(null)
    })

    it('accepted but read back NEW (OKX asynchronous cancel): replaced at once, as before', async () => {
      const { bot, placed } = makeBot(['NEW'])
      await check(bot)
      expect(placed).to.have.length(1)
    })

    it('FILLED: handed to handleUnknownOrder, nothing placed', async () => {
      const { bot, placed, unknown } = makeBot(['FILLED'])
      await check(bot)
      expect(placed).to.have.length(0)
      expect(unknown).to.have.length(1)
    })
  })
})
