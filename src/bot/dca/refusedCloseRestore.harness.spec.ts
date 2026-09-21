process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `053.a-refused-deal-close-leaves-the-position-with-nothing-on-the-book`
 * (issue #784).
 *
 * Drives the REAL `dcaHelper.closeDealById` over a minimal base class — no
 * stack, DB, Redis or exchange connection — so a broken wiring shows up as a
 * missing `placeOrders` call rather than as a stubbed assertion.
 *
 * The defect: closing a deal is a replacement, but the engine cancels first and
 * places second. `cancelAllOrder(0, dealId, true)` pulls the resting
 * take-profit, the replacement is refused for funds, and the refusal branch
 * reports and returns. The deal stays `open` holding its whole position with
 * NOTHING on the book, and since coverage is only re-established as a side
 * effect of a fill, there is no longer anything that can fill.
 *
 * Production, 2026-09-17: 420 live open deals across 14 users in exactly that
 * state, the oldest uncovered since 2026-08-14. The fixture below is the shape
 * of one of them — a filled entry, a cancelled take-profit, nothing resting.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import RedisClient from '../../db/redis'
import { matchesNotEnoughBalance } from '../main'
import {
  CloseDCATypeEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  TypeOrderEnum,
} from '../../../types'

/**
 * Spec `074` §4.2 bounds the restore with a `RetryBackoff`, which is
 * Redis-backed. `RetryBackoff` fails OPEN, so with no store every attempt reads
 * as the first one and the window under test could never be observed. Back it
 * with a Map instead — the idiom `retryBackoff.memory.spec.ts` and
 * `tpDustClose.harness.spec.ts` already use — and drive the clock by rewinding
 * the stored windows (see `passRestoreWindow`).
 */
const backoffStore = new Map<string, string>()
/**
 * Borrowed for the duration of this file's cases and handed straight back —
 * `RedisClient.getInstance` is one static, and sibling harnesses
 * (`tpDustClose`) install their own store on it at module load. Overwriting it
 * from here permanently is what silently breaks whichever file mocha happens to
 * run next.
 */
let previousGetInstance: unknown
const useBackoffStore = () => {
  previousGetInstance = (RedisClient as any).getInstance
  ;(RedisClient as any).getInstance = async () => ({
    get: async (k: string) => backoffStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      backoffStore.set(k, v)
    },
    del: async (k: string) => {
      backoffStore.delete(k)
    },
  })
}
const releaseBackoffStore = () => {
  if (previousGetInstance) {
    ;(RedisClient as any).getInstance = previousGetInstance
  }
}

/** The cooldown elapses: every open window falls into the past. */
const passRestoreWindow = () => {
  for (const [k, v] of backoffStore) {
    backoffStore.set(k, JSON.stringify({ ...JSON.parse(v), until: 0 }))
  }
}

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b53'
const DEAL_ID = '000000000000000000000d53'
const PAIR = 'VTHOUSDT'

/** The production refusal (spec §2.1), verbatim from a venue. */
const REFUSAL = 'EOrder:Insufficient funds'

/** The position the deal holds, and the close that was pulled off the book. */
const SIZE = 1708.67
const TP_QTY = 1706.96
const TP_PRICE = 0.0007285

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 7,
  baseAsset: { name: 'VTHO', minAmount: 1 },
  // Small enough that the §4.3 fixtures clear the notional floor — this pair
  // really is worth fractions of a cent per coin, and the branch under test is
  // the sizing, not the floor.
  quoteAsset: { name: 'USDT', minAmount: 0.1 },
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000453'
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
  data: any = {
    settings: { type: 'regular', pair: [PAIR], adaptiveClose: false },
    status: 'open',
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'uuid-53',
    flags: [],
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  /**
   * The real base's predicate (`main.ts`), delegating to the very same exported
   * venue-string list. Stubbing it `false` here would make spec `074` §4.1
   * untestable; stubbing it `true` would hide the gate entirely.
   */
  isErrorNotEnoughBalance(errorString: string) {
    return matchesNotEnoughBalance(errorString)
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Opts = {
  /** Orders the bot's own map reports for this deal AFTER the cancel. */
  restingAfterCancel?: any[]
  /** Deal status the second `getDeal` sees — the close may have landed. */
  statusAfterCancel?: DCADealStatusEnum
  /** Does the restore's `placeOrders` succeed in resting something? */
  restorePlaces?: boolean
  /** What `getTPOrder` offers to re-arm with. */
  rearm?: { qty: number; price: number }[] | null
  adaptiveClose?: boolean
  /** Wallet-wide free base `checkAssets` reports — siblings' coins included. */
  walletFree?: number
  /** What `prepareTpOrder` sizes the close at. */
  tpQty?: number
  /** Base this deal has already sold, so its own position is smaller. */
  tpHistory?: { id?: string; qty: number }[]
  /** What the venue answered the close with. Defaults to the funding refusal. */
  refusal?: string
  /** Spec 074 §4.2 — the window is keyed per deal, so fixtures need ids. */
  dealId?: string
  botId?: string
}

const buildBot = (o: Opts = {}) => {
  const DEAL = o.dealId ?? DEAL_ID
  const BOT = o.botId ?? BOT_ID
  const deal: any = {
    _id: DEAL,
    botId: BOT,
    status: DCADealStatusEnum.open,
    symbol: { symbol: PAIR, baseAsset: 'VTHO', quoteAsset: 'USDT' },
    size: SIZE,
    avgPrice: 0.0007,
    initialPrice: 0.0007,
    lastPrice: TP_PRICE,
    tpHistory: o.tpHistory ?? [],
    reduceFunds: [],
    settings: {},
    tpSlTargetFilled: [],
    levels: { complete: 1 },
  }

  class TestBot extends Helper {
    public placed: any[] = []
    public sent: any[] = []
    public cancels: any[] = []
    public logs: string[] = []
    public warns: string[] = []
    public reported: any[][] = []
    public orderErrors: any[][] = []
    /** The bot's live order map, keyed the way the engine reads it. */
    public liveOrders: any[] = []
    private cancelled = false

    data: any = {
      ...new FakeBase().data,
      settings: {
        type: 'regular',
        pair: [PAIR],
        adaptiveClose: o.adaptiveClose ?? false,
      },
    }

    botId = BOT
    getDeal(id: string) {
      if (id !== DEAL) return undefined
      const status = this.cancelled
        ? (o.statusAfterCancel ?? DCADealStatusEnum.open)
        : DCADealStatusEnum.open
      return {
        deal: { ...deal, status },
        initialOrders: [],
        currentOrders: [],
      }
    }
    getOpenDeals() {
      return [{ deal }]
    }
    /**
     * The engine's own view of what the venue is still holding for this deal.
     * Empty after the cancel unless the fixture says otherwise — which is the
     * whole production shape.
     */
    getOrdersByStatusAndDealId({ status }: any) {
      const wanted = Array.isArray(status) ? status : [status]
      return this.liveOrders.filter((x) => wanted.includes(x.status))
    }
    async cancelAllOrder(...args: any[]) {
      this.cancels.push(args)
      this.cancelled = true
      this.liveOrders = o.restingAfterCancel ?? []
    }
    async prepareTpOrder() {
      return {
        qty: o.tpQty ?? TP_QTY,
        price: TP_PRICE,
        side: OrderSideEnum.sell,
        type: TypeOrderEnum.dealTP,
        newClientOrderId: 'D-TP-fixture53',
      }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    async sendGridToExchange(order: any, options: any) {
      this.sent.push({ ...order, acAfter: options?.acAfter })
      return o.refusal ?? REFUSAL
    }
    async checkAssets() {
      return new Map([['VTHO', { free: o.walletFree ?? 1141.9, locked: 0 }]])
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
      return o.rearm === null
        ? []
        : (o.rearm ?? [{ qty: TP_QTY, price: TP_PRICE }])
    }
    /**
     * The restore's seam is `placeOrdersHoldingDealLock`, not `placeOrders` —
     * the caller already holds the deal's `IdMutex` key and the guarded
     * wrapper would deadlock on it (spec `055`). Stubbing here leaves that
     * wrapper on the prototype where every other caller still meets it;
     * `refusedCloseDeadlock.harness.spec.ts` is what exercises it.
     */
    async placeOrdersHoldingDealLock(
      _b: string,
      _s: string,
      _d: string,
      orders: any,
    ) {
      this.placed.push(orders)
      if (o.restorePlaces ?? true) {
        this.liveOrders = (orders.new ?? []).map((x: any, i: number) => ({
          clientOrderId: `restored-${i}`,
          status: 'NEW',
          typeOrder: TypeOrderEnum.dealTP,
          side: OrderSideEnum.sell,
          origQty: `${x.qty}`,
          executedQty: '0',
        }))
      }
    }
    async handleOrderErrors(...args: any[]) {
      this.orderErrors.push(args)
    }
    async processError(...args: any[]) {
      this.reported.push(args)
    }
    getErrorSubType() {
      return 'Not enough balance'
    }
    async handleTrailingCloseRefusal() {
      return false
    }
    async disarmTrailing() {}
    async closeDeal() {}
    saveDeal() {}
    async clearDealTimer() {}
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
    stop() {}
  }
  return new TestBot()
}

const closeRefused = async (o: Opts = {}) => {
  const bot: any = buildBot(o)
  await bot.closeDealById(
    o.botId ?? BOT_ID,
    o.dealId ?? DEAL_ID,
    CloseDCATypeEnum.closeByMarket,
    false,
    false,
    false,
    false,
  )
  return bot
}

/**
 * The re-sized send adaptive close makes, identified the way the engine marks
 * it — `acBefore`/`acAfter` on the send options — not by its quantity, which
 * can legitimately equal the original.
 */
const adaptiveSend = (bot: any) => {
  const hits = bot.sent.filter((x: any) => x.acAfter !== undefined)
  expect(hits.length, 'adaptive close did not re-size').to.equal(1)
  return hits[0]
}

/** What the venue is left holding for this deal when the dust settles. */
const restingCount = (bot: any) =>
  bot.liveOrders.filter((x: any) =>
    ['NEW', 'PARTIALLY_FILLED'].includes(x.status),
  ).length

describe('a refused deal close leaves nothing on the book (spec 053)', () => {
  before(function () {
    // Loading the helper pulls the whole engine graph in through ts-node.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  // Spec 074 §4.2's window is keyed on (botId, dealId) and deliberately
  // outlives a bot instance, so every case starts from an empty store.
  beforeEach(() => {
    useBackoffStore()
    backoffStore.clear()
  })
  afterEach(() => releaseBackoffStore())

  describe('§4.1 the close is restored', () => {
    it('an open deal is never left with no close on the book', async () => {
      const bot = await closeRefused()
      // The production state this reproduces: cancelled, refused, and bare.
      expect(
        bot.cancels.length,
        'the resting take-profit was pulled',
      ).to.be.greaterThan(0)
      expect(bot.sent.length, 'a replacement close was attempted').to.equal(1)
      expect(bot.orderErrors.length, 'the refusal was reported').to.equal(1)
      // The invariant.
      expect(
        restingCount(bot),
        'deal left with no close on the book',
      ).to.be.greaterThan(0)
    })

    it('restores it from the deal own position, not a wallet total', async () => {
      const bot = await closeRefused()
      expect(bot.placed.length, 'no restore was attempted').to.equal(1)
      const qtys = (bot.placed[0].new ?? []).map((x: any) => x.qty)
      expect(qtys).to.deep.equal([TP_QTY])
      // §3.4 — the restore must not consult the wallet at all. The fixture's
      // wallet holds far less than the position; a restore sized off it would
      // come out at 1141.9.
      expect(qtys.every((q: number) => q !== 1141.9)).to.equal(true)
    })

    it('cancels nothing while restoring — it has nothing to replace', async () => {
      const bot = await closeRefused()
      expect(bot.placed[0].cancel).to.deep.equal([])
    })
  })

  describe('§4.1 the restore is guarded', () => {
    it('does not place when a resting order survived the cancel', async () => {
      const survivor = {
        clientOrderId: 'still-there',
        status: 'NEW',
        typeOrder: TypeOrderEnum.dealTP,
        side: OrderSideEnum.sell,
        origQty: `${TP_QTY}`,
        executedQty: '0',
      }
      const bot = await closeRefused({ restingAfterCancel: [survivor] })
      expect(bot.placed.length, 'restored on top of a live order').to.equal(0)
      expect(restingCount(bot)).to.equal(1)
    })

    it('does not place when the deal is no longer open', async () => {
      for (const status of [
        DCADealStatusEnum.closed,
        DCADealStatusEnum.canceled,
      ]) {
        const bot = await closeRefused({ statusAfterCancel: status })
        expect(bot.placed.length, `restored onto a ${status} deal`).to.equal(0)
      }
    })
  })

  describe('§4.2 an unfundable close is surfaced, not swallowed', () => {
    it('reports to the user when the restore leaves nothing resting', async () => {
      const bot = await closeRefused({ restorePlaces: false })
      expect(restingCount(bot)).to.equal(0)
      expect(
        bot.reported.length,
        'the deal is uncovered and the user was told nothing',
      ).to.be.greaterThan(0)
      // `force` — the ninth argument — is what stops this being collapsed into
      // the daily-coalesced message the latched guard has stopped refreshing.
      expect(bot.reported[0][8], 'reported without force').to.equal(true)
    })

    it('names the deal in a greppable line an operator can act on', async () => {
      const bot = await closeRefused({ restorePlaces: false })
      const line = bot.warns.find((w: string) => w.includes(DEAL_ID))
      expect(
        line,
        `no warn names the deal; saw ${JSON.stringify(bot.warns)}`,
      ).to.be.a('string')
      expect(line).to.include(PAIR)
    })

    it('says nothing extra when the restore worked', async () => {
      const bot = await closeRefused()
      expect(bot.reported.length, 'reported a deal that is covered').to.equal(0)
    })

    it('stays quiet when there is nothing to re-arm with', async () => {
      // No take-profit to place is the same uncovered outcome, and must report
      // rather than fall through silently.
      const bot = await closeRefused({ rearm: null })
      expect(bot.placed.length).to.equal(0)
      expect(bot.reported.length).to.be.greaterThan(0)
    })
  })

  describe('§4.3 adaptive close is clamped to the deal own position', () => {
    it('never sizes a close above what the deal still holds', async () => {
      // The wallet is flush because sibling deals' base is sitting unreserved,
      // and the take-profit is oversized by the drift family (#694/#696). Today
      // `Math.min(find.free, tpOrder.qty)` would happily place the whole 5000.
      const bot = await closeRefused({
        adaptiveClose: true,
        walletFree: 99999,
        tpQty: 5000,
      })
      expect(adaptiveSend(bot).qty).to.be.at.most(SIZE)
    })

    it('subtracts what the deal has already sold', async () => {
      const bot = await closeRefused({
        adaptiveClose: true,
        walletFree: 99999,
        tpQty: 5000,
        tpHistory: [{ qty: 708.67 }],
      })
      expect(adaptiveSend(bot).qty).to.be.at.most(SIZE - 708.67)
    })

    it('still lets the wallet cap the close when it is the smaller term', async () => {
      // §3.4 cuts both ways: the clamp is a THIRD term of a `Math.min`, so a
      // genuinely short wallet must still win. No sibling arithmetic anywhere.
      const bot = await closeRefused({
        adaptiveClose: true,
        walletFree: 900,
        tpQty: 5000,
      })
      expect(adaptiveSend(bot).qty).to.equal(900)
    })
  })

  describe('spec 074 §4.1 the restore is qualified by the refusal reason', () => {
    // A re-armed take-profit sells exactly the base the close was sizing, so
    // the only refusal it can answer is one about funding that base. In
    // production 6.1% of restores went out after one of these instead, each
    // producing a second refused order and a message naming funding as the
    // cause when funding is not the cause.
    const unanswerable: [string, string][] = [
      [
        'a revoked or unpermitted API key',
        'Invalid API-key, IP, or permissions for action.',
      ],
      ['an IP allow-list rejection', 'invalid ip,current request ip 1.2.3.4'],
      [
        'a position that is already flat',
        "Order failed because you don't have any positions in this direction for this contract to reduce or close.",
      ],
    ]

    for (const [what, refusal] of unanswerable) {
      it(`does not re-arm after ${what}`, async () => {
        const bot = await closeRefused({ refusal, restorePlaces: false })
        expect(bot.placed.length, 'a doomed restore was sent').to.equal(0)
        expect(
          bot.reported.length,
          'reported an unfunded close for a refusal that is not about funds',
        ).to.equal(0)
        // §3.3 — the venue's own reason still reaches the user, unchanged.
        expect(
          bot.orderErrors.length,
          'the venue refusal went unreported',
        ).to.equal(1)
      })
    }

    it('still re-arms after every funding refusal the shared list knows', async () => {
      for (const refusal of [
        'Not enough balance',
        'Account has insufficient balance for requested action.',
        'EOrder:Insufficient funds',
      ]) {
        backoffStore.clear()
        const bot = await closeRefused({ refusal })
        expect(bot.placed.length, `did not re-arm after "${refusal}"`).to.equal(
          1,
        )
      }
    })
  })

  describe('spec 074 §4.2 a stuck deal is not re-armed on every attempt', () => {
    /** Re-enter the refusal branch `n` times, as the close retry does. */
    const attempts = async (n: number, o: Opts = {}) => {
      const bots: any[] = []
      for (let i = 0; i < n; i++) {
        bots.push(await closeRefused({ restorePlaces: false, ...o }))
      }
      return {
        restores: bots.reduce((a, b) => a + b.placed.length, 0),
        reports: bots.reduce((a, b) => a + b.reported.length, 0),
      }
    }

    it('re-arms once per window, not once per close attempt', async () => {
      // Production: the same deal re-entered this branch 16 times in 8 minutes,
      // sending the quantity the close had just been refused for each time.
      const { restores, reports } = await attempts(16)
      expect(restores, 'every attempt re-sent the refused quantity').to.equal(1)
      expect(reports, 'every attempt re-raised the same warning').to.equal(1)
    })

    it('re-arms again once the window has elapsed', async () => {
      await attempts(3)
      passRestoreWindow()
      const { restores } = await attempts(1)
      expect(restores, 'the deal was never retried again').to.equal(1)
    })

    it('keeps the window per deal, so a sibling deal is unaffected', async () => {
      await attempts(3)
      const other = await closeRefused({
        restorePlaces: false,
        dealId: '000000000000000000000d74',
      })
      expect(
        other.placed.length,
        "one deal's window silenced another",
      ).to.equal(1)
    })

    it('releases the window as soon as a restore rests an order', async () => {
      // A shortfall that clears must not be held off for the rest of the
      // ladder: the successful restore drops the key outright.
      await attempts(2)
      passRestoreWindow()
      const ok = await closeRefused()
      expect(ok.placed.length, 'the recovering deal was suppressed').to.equal(1)
      expect(backoffStore.size, 'a covered deal kept its cooldown').to.equal(0)
    })
  })
})
