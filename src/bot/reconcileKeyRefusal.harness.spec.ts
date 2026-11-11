process.env.NODE_ENV = 'testing'

/**
 * A reconcile pass on a key that may not read orders asks the venue once.
 *
 * Spec: `specs/237.reconcile-re-asks-a-key-that-may-not-read-orders.md`.
 *
 * The shape is a Kraken spot grid whose key could place orders but not read
 * them back: every `getOrder` came back `EGeneral:Permission denied`, and each
 * reconcile pass asked three times per resting order. A permission is a
 * property of the key, so every one of those calls was refused the same way.
 *
 * Drives the REAL `checkOrdersAfterReconnect` of the grid and the DCA helper
 * over the REAL `MainBot.getOrderForReconcile` and `reconcileLookup`; only the
 * venue call (`getOrder`), the pass's I/O and its sleeps are stubbed.
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import sinon from 'sinon'
import { ExchangeEnum, StatusEnum, TypeOrderEnum } from '../../types'
import MainBot, { reconcileLookupAttempts } from './main'
import utils from '../utils'

const SYMBOL = 'XBTUSD'
const BOT_ID = '00000000000000000000b237'
const DEAL_ID = '00000000000000000000d237'
const PERMISSION = 'EGeneral:Permission denied'

const loadModule = createRequire(__filename)
let Grid: any
let Dca: any

const resting = (i: number) => ({
  symbol: SYMBOL,
  orderId: `OTEST${i}-AAAAA-237${String(i).padStart(3, '0')}`,
  clientOrderId: `T-237-order${i}`,
  dealId: DEAL_ID,
  typeOrder: TypeOrderEnum.regular,
  type: 'LIMIT',
  side: 'BUY',
  price: `${80000 + i}`,
  origQty: '0.0001',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  status: 'NEW',
  updateTime: 1793900000000 + i,
  exchange: ExchangeEnum.kraken,
})

/** An instance of `Cls` with the venue call, the pass's I/O and timers stubbed. */
const buildBot = (Cls: any, n: number, answer: string) => {
  const calls: string[] = []
  const writes: string[] = []
  const warns: string[] = []
  const held = Array.from({ length: n }, (_, i) => resting(i + 1))
  const bot: any = Object.create(Cls.prototype)
  Object.assign(bot, {
    botId: BOT_ID,
    data: {
      _id: BOT_ID,
      status: 'open',
      exchange: ExchangeEnum.kraken,
      exchangeUUID: 'test-account-237',
      paperContext: false,
      settings: { pair: SYMBOL },
      flags: [],
    },
    exchange: {},
    blockCheck: false,
    serviceRestart: false,
    reconcileViaSweep: false,
    reconcileBatch: null,
    orderStatuses: ['NEW', 'PARTIALLY_FILLED'],
    orders: new Map<string, any>(held.map((o) => [o.clientOrderId, { ...o }])),
    calls,
    writes,
    warns,
  })
  Object.assign(bot, {
    shouldProceed: () => true,
    startMethod: () => '1',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleDebug: () => undefined,
    handleWarn: (m: string) => warns.push(m),
    spreadReconcileStart: async () => undefined,
    primeReconcileBatch: async () => undefined,
    checkTpCoverage: async () => undefined,
    processOrdersAfterCheck: () => undefined,
    processFilledOrder: () => writes.push('processFilledOrder'),
    // The venue. Everything between this and the pass is real.
    getOrder: async (id: string) => {
      calls.push(id)
      return { status: StatusEnum.notok, reason: answer, data: null }
    },
    getOrdersByStatusAndDealId: () => [...bot.orders.values()],
    getOrderFromMap: (id: string) => bot.orders.get(id),
    emit: () => writes.push('emit'),
    setOrder: () => writes.push('setOrder'),
    deleteOrder: () => writes.push('deleteOrder'),
    updateOrderOnDb: () => writes.push('updateOrderOnDb'),
    adoptExchangeOrderId: async () => writes.push('adoptExchangeOrderId'),
  })
  return { bot, held }
}

for (const [name, get] of [
  ['grid', () => Grid],
  ['DCA', () => Dca],
] as const) {
  describe(`${name}: reconcile on a key that may not read orders (spec 237)`, () => {
    before(function () {
      this.timeout(300000)
      class Base {
        constructor(..._a: any[]) {}
      }
      Object.setPrototypeOf(Base.prototype, (MainBot as any).prototype)
      Grid ??= loadModule('./helper').default(Base as any)
      Dca ??= loadModule('./dcaHelper').default(Base as any)
    })
    let sleep: sinon.SinonStub | undefined
    afterEach(() => {
      sleep?.restore()
      sleep = undefined
    })

    it('§4.1 a Permission denied answer costs exactly one lookup per pass', async () => {
      sleep = sinon.stub(utils, 'sleep').resolves()
      const { bot, held } = buildBot(get(), 3, PERMISSION)
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      expect(bot.calls, 'venue lookups').to.have.length(1)
      // A second pass is again one lookup — nothing is latched across passes.
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      expect(bot.calls, 'venue lookups after two passes').to.have.length(2)
      expect(bot.blockCheck, 'block released').to.equal(false)
      // §4.2 nothing about the orders changes.
      expect(bot.writes, 'writes').to.deep.equal([])
      expect(
        [...bot.orders.values()].map((o: any) => o.status),
        'held statuses',
      ).to.deep.equal(held.map((o) => o.status))
      // §4.3 every order is still reported as unread.
      const unresolved = bot.warns.find((w: string) =>
        w.startsWith('Reconcile could not read 3 order(s) after 1 lookup'),
      )
      expect(unresolved, bot.warns.join('\n')).to.be.a('string')
      for (const o of held) expect(unresolved).to.include(o.clientOrderId)
    })

    it('§4.4 any other refusal keeps its per-order retries', async () => {
      sleep = sinon.stub(utils, 'sleep').resolves()
      const { bot } = buildBot(get(), 3, 'EGeneral:Internal error')
      await bot.checkOrdersAfterReconnect(BOT_ID, false)
      expect(bot.calls, 'venue lookups').to.have.length(3 * reconcileLookupAttempts)
      expect(bot.writes, 'writes').to.deep.equal([])
    })
  })
}
