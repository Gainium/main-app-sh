process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `055.the-refused-close-restore-deadlocks-on-the-deal-lock` (issue #797).
 *
 * Drives the REAL `dcaHelper.closeDealById` over a minimal base class, with
 * the REAL `@IdMute` decorators in the path — no stack, DB, Redis or exchange
 * connection.
 *
 * The defect: `closeDealById` and `placeOrders` are guarded by the same
 * `${botId}${dealId}` key on the same non-reentrant `IdMutex`, which has no
 * lock timeout. The refused-close restore (spec `053`) awaits `placeOrders`
 * from inside `closeDealById`, so it waits on a lock it is already holding.
 * `closeDealById` never returns, the key is never released, and the bot's own
 * `stop()` — which awaits `closeDealById` for that deal — blocks with it. In
 * production that left a combo bot `open` through six stop attempts, none of
 * which wrote a status event or a document.
 *
 * Why the spec `053` harness cannot see this: it overrides `placeOrders` on
 * its subclass, and an own-prototype method shadows the decorated one, so the
 * `@IdMute` wrapper is not in its path at all. Nothing here overrides
 * `placeOrders`.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  CloseDCATypeEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  TypeOrderEnum,
} from '../../../types'

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b55'
const DEAL_ID = '000000000000000000000d55'
const PAIR = 'VTHOUSDT'

/** The production refusal this reproduces. */
const REFUSAL = 'Not enough balance'

const SIZE = 1708.67
const TP_QTY = 1706.96
const TP_PRICE = 0.0007285

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 7,
  baseAsset: { name: 'VTHO', minAmount: 1 },
  quoteAsset: { name: 'USDT', minAmount: 0.1 },
}

/**
 * How long a call gets before we call it deadlocked. The whole blocked path is
 * in-process and holds no timers, so a call that is going to return has
 * returned long before this.
 */
const DEADLOCK_MS = 2000

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000455'
  botType = 'dca'
  loadingComplete = true
  closeAfterTpFilled = false
  isLong = true
  futures = false
  coinm = false
  combo = false
  hedge = false
  orders = new Map()
  exchange: any = {}
  allowToPlaceOrders = new Map()
  openNewDealTimer = new Map()
  data: any = {
    settings: { type: 'regular', pair: [PAIR], adaptiveClose: false },
    status: 'open',
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'uuid-55',
    flags: [],
    paperContext: false,
    workingShift: [{ start: 1 }],
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = () => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: DCADealStatusEnum.open,
    symbol: { symbol: PAIR, baseAsset: 'VTHO', quoteAsset: 'USDT' },
    size: SIZE,
    avgPrice: 0.0007,
    initialPrice: 0.0007,
    lastPrice: TP_PRICE,
    tpHistory: [],
    reduceFunds: [],
    settings: {},
    tpSlTargetFilled: [],
    levels: { complete: 1 },
  }

  class TestBot extends Helper {
    public logs: string[] = []
    public warns: string[] = []
    public written: any[] = []
    public liveOrders: any[] = []
    /**
     * Flipped by `getTPOrder`, which in this flow is reached only from
     * `restoreCloseAfterRefusal`. From then on `getExchangeInfo` answers
     * `undefined`, which is the cheapest early exit inside the REAL
     * `placeOrders` body — so the body runs for real and returns, rather than
     * needing the whole order-placement graph stubbed.
     */
    public restoring = false

    data: any = { ...new FakeBase().data }

    getDeal(id: string) {
      if (id !== DEAL_ID) return undefined
      return { deal, initialOrders: [], currentOrders: [] }
    }
    getOpenDeals() {
      return [{ deal, initialOrders: [], currentOrders: [] }]
    }
    getOrdersByStatusAndDealId({ status }: any) {
      const wanted = Array.isArray(status) ? status : [status]
      return this.liveOrders.filter((x) => wanted.includes(x.status))
    }
    async cancelAllOrder() {
      this.liveOrders = []
    }
    async prepareTpOrder() {
      return {
        qty: TP_QTY,
        price: TP_PRICE,
        side: OrderSideEnum.sell,
        type: TypeOrderEnum.dealTP,
        newClientOrderId: 'D-TP-fixture55',
      }
    }
    async getExchangeInfo() {
      return this.restoring ? undefined : EXCHANGE_INFO
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    async sendGridToExchange() {
      return REFUSAL
    }
    async checkAssets() {
      return new Map([['VTHO', { free: 1141.9, locked: 0 }]])
    }
    async baseAssetPrecision() {
      return 2
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async getTPOrder() {
      this.restoring = true
      return [{ qty: TP_QTY, price: TP_PRICE }]
    }
    async handleOrderErrors() {}
    async processError() {}
    getErrorSubType() {
      return REFUSAL
    }
    async handleTrailingCloseRefusal() {
      return false
    }
    async disarmTrailing() {}
    async closeDeal() {}
    saveDeal() {}
    async clearDealTimer() {}
    async updateData(d: any) {
      this.written.push(d)
    }
    emit() {}
    trimWorkingShift(w: any) {
      return w
    }
    getWorkingTimeNumber() {
      return 0
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
    handleLog(m: string) {
      this.logs.push(m)
      return m
    }
    handleWarn(m: string) {
      this.warns.push(m)
      return m
    }
    handleDebug() {}
    handleErrors(m: string) {
      this.warns.push(m)
    }
  }
  return new TestBot()
}

/** Resolves `'returned'`, or `'deadlocked'` if the call never settles. */
const settleOrDeadlock = async (run: Promise<unknown>) => {
  let timer: NodeJS.Timeout | undefined
  const result = await Promise.race([
    run.then(() => 'returned'),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('deadlocked'), DEADLOCK_MS)
    }),
  ])
  if (timer) clearTimeout(timer)
  return result
}

const closeRefused = (bot: any) =>
  bot.closeDealById(
    BOT_ID,
    DEAL_ID,
    CloseDCATypeEnum.closeByMarket,
    false,
    false,
    false,
    false,
  )

describe('a refused close deadlocks the deal lock (spec 055)', () => {
  before(function () {
    // Loading the helper pulls the whole engine graph in through ts-node.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  describe('§4.1 the restore runs to completion inside the deal lock', () => {
    it('closeDealById returns after the restore', async () => {
      const bot: any = buildBot()
      expect(await settleOrDeadlock(closeRefused(bot))).to.equal('returned')
    })

    it('really enters the placeOrders body, it does not skip the restore', async () => {
      const bot: any = buildBot()
      await settleOrDeadlock(closeRefused(bot))
      // Only `placeOrders` emits this line, and only after `getTPOrder` has
      // armed the fixture — so seeing it proves the restore reached the body
      // rather than the call being dropped to dodge the lock.
      expect(
        bot.warns.some((w: string) => w.includes('Exchange info not found')),
        `placeOrders body never ran; saw ${JSON.stringify(bot.warns)}`,
      ).to.equal(true)
    })

    it('releases the deal lock, so the next close is not blocked', async () => {
      const bot: any = buildBot()
      await settleOrDeadlock(closeRefused(bot))
      // The production shape: the user retries. Pre-fix the key is still held
      // by the first call and this one never starts.
      bot.restoring = false
      expect(await settleOrDeadlock(closeRefused(bot))).to.equal('returned')
    })
  })

  describe('§4.3 a stop reaching a refused close completes', () => {
    it('stop() returns and writes the bot closed', async () => {
      const bot: any = buildBot()
      const settled = await settleOrDeadlock(
        bot.stop(CloseDCATypeEnum.closeByMarket),
      )
      expect(settled, 'stop() never returned').to.equal('returned')
      expect(
        bot.written.some((d: any) => d.status === 'closed'),
        `bot never written closed; saw ${JSON.stringify(bot.written)}`,
      ).to.equal(true)
    })
  })
})
