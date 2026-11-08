process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `227` — a base order the venue cancelled with
 * nothing filled, which the bot only hears about through the user-stream
 * reconnect check, must cancel its deal like the other three routes do
 * (queue report, reposition tick, placement reply — specs 203 / 205).
 *
 * Drives the REAL `checkOrdersAfterReconnect` of the DCA helper and of the
 * Combo helper (which inherits it) over a venue whose answer for a resting
 * MARKET entry is CANCELED / 0. Venue, DB and stream are stubbed on the
 * instance; nothing else of the pass is replaced.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import sinon from 'sinon'
import { canceledBaseEntryDelayMs } from './dca/partialBaseEntry'
import {
  DCADealStatusEnum,
  OrderTypeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'

const DEAL_ID = '000000000000000000000d27'
const BOT_ID = '000000000000000000000b27'
const SYMBOL = 'IAGUSDT'
const ENTRY_ID = 'D-BO-0000000000000000000000000227'

const restingEntry = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: '1000000000000000227',
    clientOrderId: ENTRY_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.market,
    side: 'BUY',
    price: '0.017',
    origQty: '88',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    updateTime: 1793938245063,
    ...over,
  }) as any

const loadModule = createRequire(__filename)
let Dca: any
let Combo: any

class FakeBase {
  constructor(..._a: any[]) {}
}

type Opts = {
  /** The venue's answer, merged over the held row. */
  answer?: Record<string, unknown>
  /** The row the bot holds open. */
  held?: any
  dealStatus?: DCADealStatusEnum
  ownCancels?: string[]
}

/** An instance of `Cls` with only I/O and the venue replaced. */
const buildBot = (Cls: any, opts: Opts = {}) => {
  const {
    answer = { status: 'CANCELED', executedQty: '0' },
    held = restingEntry(),
    dealStatus = DCADealStatusEnum.start,
    ownCancels = [],
  } = opts
  const closed: string[] = []
  const persisted: any[] = []
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'IAG', quoteAsset: 'USDT' },
      settings: {},
    },
  }
  const bot: any = Object.create(Cls.prototype)
  Object.assign(bot, {
    botId: BOT_ID,
    data: { status: 'open', settings: { pair: [SYMBOL] }, flags: [] },
    blockCheck: false,
    serviceRestart: false,
    reconcileViaSweep: false,
    reconcileBatch: null,
    orderStatuses: ['NEW', 'PARTIALLY_FILLED'],
    orders: new Map<string, any>([[held.clientOrderId, held]]),
    dealTimersMap: new Map<string, any>(),
    unsettledBaseEntries: new Set<string>(),
    closed,
    persisted,
  })
  const stubs: Record<string, any> = {
    shouldProceed: () => true,
    startMethod: () => '1',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleDebug: () => undefined,
    handleWarn: (m: string) => {
      throw new Error(`unexpected warn: ${m}`)
    },
    emit: () => true,
    spreadReconcileStart: async () => undefined,
    primeReconcileBatch: async () => undefined,
    adoptExchangeOrderId: async () => undefined,
    checkTpCoverage: async () => undefined,
    processOrdersAfterCheck: () => undefined,
    noteReconciledBaseEntry: () => undefined,
    getOrderForReconcile: async (o: any) => ({
      status: StatusEnum.ok,
      data: { ...o, ...answer },
    }),
    mergeCommonOrderWithOrder: async (co: any, o: any) => ({ ...o, ...co }),
    getOrderFromMap: (id: string) => bot.orders.get(id),
    setOrder: (o: any) => bot.orders.set(o.clientOrderId, o),
    deleteOrder: (id: string) => bot.orders.delete(id),
    getOrdersByStatusAndDealId: (
      q: { status?: string | string[]; dealId?: string; defaultStatuses?: boolean } = {},
    ) => {
      const wanted = q.defaultStatuses
        ? ['NEW', 'PARTIALLY_FILLED']
        : q.status === undefined
          ? undefined
          : ([] as string[]).concat(q.status)
      return [...bot.orders.values()].filter(
        (o: any) =>
          (!wanted || wanted.includes(o.status)) &&
          (!q.dealId || o.dealId === q.dealId),
      )
    },
    updateOrderOnDb: (o: any) => persisted.push({ ...o }),
    getDeal: (id?: string) => (id === DEAL_ID ? deal : undefined),
    isOwnCancel: (id: string) => ownCancels.includes(id),
    clearDealTimer: async () => undefined,
    closeDealById: async (_b: string, dealId: string) => {
      closed.push(dealId)
    },
    // Spec 228's refusal counter runs before the close; it has its own
    // harness, and here it would only reach a real Redis.
    noteRefusedBaseEntry: async () => undefined,
  }
  Object.assign(bot, stubs)
  return bot
}

const armed = (bot: any) => bot.canceledBaseEntryTimers?.has(DEAL_ID) ?? false
const drain = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

for (const [name, get] of [
  ['DCA', () => Dca],
  ['Combo', () => Combo],
] as const) {
  describe(`${name}: a base entry the reconnect check finds cancelled cancels its deal (spec 227)`, () => {
    before(function () {
      // One ts-node compile of the 22k-line helper (and the combo mixin).
      this.timeout(300000)
      Dca ??= loadModule('./dcaHelper').default(FakeBase as any)
      Combo ??= loadModule('./comboHelper').default()
    })
    let clock: sinon.SinonFakeTimers | undefined
    afterEach(() => {
      clock?.restore()
      clock = undefined
    })

    it('§4.1 CANCELED with nothing filled arms the check, and the deal is cancelled', async () => {
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const bot = buildBot(get())
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      expect(bot.persisted.map((o: any) => o.status), 'row written').to.deep.equal(['CANCELED'])
      expect(armed(bot), 'deal check armed').to.equal(true)
      clock.tick(canceledBaseEntryDelayMs)
      await drain()
      expect(bot.closed, 'deal cancelled').to.deep.equal([DEAL_ID])
      expect(bot.blockCheck, 'block released').to.equal(false)
    })

    it('§4.2 the stream report arriving late leaves one check; the deal is cancelled once', async () => {
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const bot = buildBot(get())
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      bot.checkUnfilledBaseEntryCancel(
        restingEntry({ status: 'CANCELED', executedQty: '0' }),
      )
      expect(bot.canceledBaseEntryTimers.size).to.equal(1)
      clock.tick(canceledBaseEntryDelayMs * 2)
      await drain()
      expect(bot.closed).to.deep.equal([DEAL_ID])
    })

    it('§4.3 a resting answer, a fill, the bot’s own cancel, or a deal past start arms nothing', async () => {
      for (const [over, why] of [
        [{ answer: { status: 'NEW', executedQty: '0' } }, 'still resting'],
        [{ answer: { status: 'CANCELED', executedQty: '5' } }, 'part filled'],
        [{ ownCancels: [ENTRY_ID] }, 'the bot cancelled it'],
        [{ dealStatus: DCADealStatusEnum.open }, 'deal already open'],
      ] as const) {
        const bot = buildBot(get(), over as Opts)
        bot.processOrdersAfterCheck = () => undefined
        await bot.checkOrdersAfterReconnect(BOT_ID, false)
        expect(armed(bot), why).to.equal(false)
        for (const t of bot.canceledBaseEntryTimers?.values() ?? []) clearTimeout(t)
      }
    })

    it('§4.4 a cancelled take-profit or safety order arms nothing', async () => {
      for (const typeOrder of [TypeOrderEnum.dealTP, TypeOrderEnum.dealRegular]) {
        const bot = buildBot(get(), {
          held: restingEntry({ typeOrder, clientOrderId: `X-${typeOrder}` }),
        })
        await bot.checkOrdersAfterReconnect(BOT_ID, false)
        expect(armed(bot), typeOrder).to.equal(false)
      }
    })
  })
}
