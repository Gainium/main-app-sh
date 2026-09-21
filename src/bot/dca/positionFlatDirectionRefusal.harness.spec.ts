process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `075.a-close-refusal-naming-the-position-direction-is-not-read-as-flat`
 * (issue #845).
 *
 * Drives the REAL `dcaHelper.closeDealById` over a minimal base class — no
 * stack, DB, Redis or exchange connection — and asserts which of its three
 * string-refusal branches a given venue wording lands in.
 *
 * The defect: OKX words "there is nothing left to reduce" TWO ways, and
 * `positionAlreadyClosedReasons` carries only one of them. The other —
 * "…you don't have any positions in this direction for this contract to
 * reduce or close." — misses the list, so the close falls through to the
 * generic terminal-refusal branch and the deal is left `open` holding a
 * position the venue says does not exist. Every later close is refused the
 * same way.
 *
 * Booking a deal closed is terminal, so §4.1/§4.2 below are as much of the
 * point as §4.3: the refusal the branch now acts on is scoped by the venue to
 * the `positionSide` THIS deal asked to reduce, so a hedge account's opposite
 * leg — a different deal on a different bot, sending the other
 * `positionSide` — can never be closed by it.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a
 * minimal base class.
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
 * Spec `074` §4.2 puts a per-(bot, deal) cooldown around the refused-close
 * restore, which the funding control case below goes through. Borrow
 * `RedisClient.getInstance` for the case and hand it straight back; sibling
 * harnesses install their own store on the same static.
 */
const cooldownStore = new Map<string, string>()
let previousGetInstance: unknown
const useEmptyCooldownStore = () => {
  cooldownStore.clear()
  previousGetInstance = (RedisClient as any).getInstance
  ;(RedisClient as any).getInstance = async () => ({
    get: async (k: string) => cooldownStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      cooldownStore.set(k, v)
    },
    del: async (k: string) => {
      cooldownStore.delete(k)
    },
  })
}
const releaseCooldownStore = () => {
  if (previousGetInstance) {
    ;(RedisClient as any).getInstance = previousGetInstance
  }
}

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b75'
const DEAL_ID = '000000000000000000000d75'
const PAIR = 'ETC-USDT'

/**
 * The production refusal, verbatim from the venue, including its trailing
 * space. This is the whole subject of the spec: any normalisation or
 * substring choice that stops matching THIS string is the bug returning.
 */
const DIRECTION_REFUSAL =
  "Order failed because you don't have any positions in this direction for " +
  'this contract to reduce or close. '

/** The wording already on the list — must keep working. */
const CONTRACT_REFUSAL = "You don't have any positions in this contract"

/** A funding refusal: the control that must NOT reach the branch. */
const FUNDING_REFUSAL = 'Not enough balance'

const SIZE = 0.8
const TP_QTY = 0.8
const TP_PRICE = 8.521

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 3,
  baseAsset: { name: 'ETC', minAmount: 0.01 },
  quoteAsset: { name: 'USDT', minAmount: 0.1 },
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000475'
  botType = 'dca'
  loadingComplete = true
  closeAfterTpFilled = false
  isLong = true
  /** The production shape: an OKX USD-M hedge-mode account. */
  futures = true
  coinm = false
  combo = false
  hedge = true
  orders = new Map()
  exchange: any = {}
  allowToPlaceOrders = new Map()
  openNewDealTimer = new Map()
  data: any = {
    settings: { type: 'regular', pair: [PAIR], adaptiveClose: false },
    status: 'open',
    exchange: ExchangeEnum.okxLinear,
    exchangeUUID: 'uuid-75',
    flags: [],
    paperContext: false,
    workingShift: [{ start: 1 }],
  }
  shouldProceed() {
    return true
  }
  /**
   * The real base's predicate (`main.ts`), delegating to the same exported
   * venue-string list. Spec `074` §4.1 gates the refused-close restore on it;
   * stubbing it would decide the control case by fiat.
   */
  isErrorNotEnoughBalance(errorString: string) {
    return matchesNotEnoughBalance(errorString)
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type BotOptions = { refusal: string; isLong?: boolean }

const buildBot = ({ refusal, isLong = true }: BotOptions) => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: DCADealStatusEnum.open,
    symbol: { symbol: PAIR, baseAsset: 'ETC', quoteAsset: 'USDT' },
    size: SIZE,
    avgPrice: 8.4,
    initialPrice: 8.4,
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
    public sent: any[] = []
    public closedDeals: string[] = []
    public orderErrors: string[] = []
    public liveOrders: any[] = []
    /** See the sibling deadlock harness — the cheapest early exit inside the
     * REAL `placeOrders` body, so the restore can run for real and return. */
    public restoring = false

    isLong = isLong
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
        side: isLong ? OrderSideEnum.sell : OrderSideEnum.buy,
        type: TypeOrderEnum.dealTP,
        newClientOrderId: 'D-TP-fixture75',
      }
    }
    async getExchangeInfo() {
      return this.restoring ? undefined : EXCHANGE_INFO
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    /** Records what was actually asked of the venue, then refuses it. */
    async sendGridToExchange(order: any, sendOptions: any) {
      this.sent.push({ order, sendOptions })
      return refusal
    }
    async checkAssets() {
      return new Map()
    }
    async baseAssetPrecision() {
      return 2
    }
    async getUserFee() {
      return { maker: 0.0005, taker: 0.0005 }
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async getTPOrder() {
      this.restoring = true
      return [{ qty: TP_QTY, price: TP_PRICE }]
    }
    async handleOrderErrors(reason: string) {
      this.orderErrors.push(`${reason}`)
    }
    async processError() {}
    getErrorSubType() {
      return refusal
    }
    async handleTrailingCloseRefusal() {
      return false
    }
    async disarmTrailing() {}
    async closeDeal(_botId: string, dealId: string) {
      this.closedDeals.push(dealId)
    }
    saveDeal() {}
    async clearDealTimer() {}
    async updateData() {}
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

describe('a close refusal naming the position direction (spec 075)', () => {
  before(function () {
    // Loading the helper pulls the whole engine graph in through ts-node.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  beforeEach(() => useEmptyCooldownStore())
  afterEach(() => releaseCooldownStore())

  describe('§4.3 the position-already-closed branch is taken', () => {
    it('books the deal closed instead of reporting a terminal refusal', async () => {
      const bot: any = buildBot({ refusal: DIRECTION_REFUSAL })
      await closeRefused(bot)
      expect(
        bot.closedDeals,
        `deal was not booked closed; logs ${JSON.stringify(bot.logs)}`,
      ).to.deep.equal([DEAL_ID])
      expect(
        bot.orderErrors,
        'the close fell through to the generic terminal-refusal branch',
      ).to.deep.equal([])
    })

    it('sends no replacement order after booking closed', async () => {
      const bot: any = buildBot({ refusal: DIRECTION_REFUSAL })
      await closeRefused(bot)
      // Exactly one attempt — the refused close itself. A second send would
      // mean a retry ladder or a restore ran against a flat position.
      expect(bot.sent).to.have.lengthOf(1)
    })

    it('says why, in the branch’s own words', async () => {
      const bot: any = buildBot({ refusal: DIRECTION_REFUSAL })
      await closeRefused(bot)
      expect(
        bot.logs.some((l: string) =>
          l.includes('rejected because the position is already closed'),
        ),
        `branch line missing; saw ${JSON.stringify(bot.logs)}`,
      ).to.equal(true)
    })

    it('still matches the wording that was already on the list', async () => {
      const bot: any = buildBot({ refusal: CONTRACT_REFUSAL })
      await closeRefused(bot)
      expect(bot.closedDeals).to.deep.equal([DEAL_ID])
    })
  })

  describe('§4.1 the refusal is scoped to this deal’s own leg', () => {
    it('a long deal asked to reduce LONG, and only LONG', async () => {
      const bot: any = buildBot({ refusal: DIRECTION_REFUSAL, isLong: true })
      await closeRefused(bot)
      // The venue scopes "in this direction" to the posSide it was sent. If
      // the close we booked on carried this deal's own side, the answer
      // cannot be about the hedge account's other leg.
      expect(bot.sent[0].sendOptions.positionSide).to.equal('LONG')
      expect(bot.sent[0].sendOptions.reduceOnly).to.equal(true)
      expect(bot.closedDeals).to.deep.equal([DEAL_ID])
    })

    it('a short deal asked to reduce SHORT, and only SHORT', async () => {
      const bot: any = buildBot({ refusal: DIRECTION_REFUSAL, isLong: false })
      await closeRefused(bot)
      expect(bot.sent[0].sendOptions.positionSide).to.equal('SHORT')
      expect(bot.closedDeals).to.deep.equal([DEAL_ID])
    })

    it('books closed only the deal whose close was refused', async () => {
      const bot: any = buildBot({ refusal: DIRECTION_REFUSAL })
      await closeRefused(bot)
      expect(bot.closedDeals).to.have.lengthOf(1)
      expect(bot.closedDeals[0]).to.equal(DEAL_ID)
    })
  })

  describe('§4.1 control — a refusal that is not about a flat position', () => {
    it('a funding refusal still takes the generic branch, not this one', async () => {
      const bot: any = buildBot({ refusal: FUNDING_REFUSAL })
      await closeRefused(bot)
      expect(
        bot.closedDeals,
        'a funding refusal must never book a deal closed',
      ).to.deep.equal([])
      expect(bot.orderErrors).to.have.lengthOf(1)
    })
  })
})
