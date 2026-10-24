/**
 * Fees and slippage at read time (main-app spec 050 §4–§5): the order and deal
 * fields `slippage*` / `costBreakdown`, the bot field `tradingCosts`, and the
 * `tradingCostsSummary` query.
 *
 * The arithmetic lives in `bot/orderSlippage.ts`; this file only decides what
 * to load and caches it. Cost bounds, all through existing indexes:
 *
 *   - order fields: no read at all, except a MARKET base order with no
 *     recorded reference, whose bot settings are read once per batch
 *     (`dcaBots` / `comboBots` by `_id`).
 *   - deal fields: none for a deal whose close-time facts are recorded; else
 *     one `orders` read per batch of deals, by `dealId` (`dealId_1`). Closed
 *     deals are immutable, so their result is cached.
 *   - bot / account aggregates: one projected read of the closed deals by
 *     `botId` (`botId_1`) or `userId` (`userId_1_status_1_createTime_-1`,
 *     `userId_1`); historical deals without recorded facts read the bot's
 *     MARKET orders once by `botId` (`botId_1`), cached for hours.
 *
 * Fees charged in a third asset (an exchange token) are valued from that
 * asset's market price at the fill (`feeAssetPrices.ts`), only for deals and
 * orders on a venue that lets fees be paid in its token
 * (`FEE_TOKEN_VENUES`): per order, through the per-tick price batch; per
 * deal, from the same `orders` read by `dealId` (now also for deals whose
 * close-time facts are recorded); per bot / account, from one read of the
 * bot's fee-bearing FILLED deal orders by `botId` (`botId_1`). Those fees
 * are reported beside the breakdown (`unbookedFees*`) and never change
 * `feesQuote`, `grossQuote` or `netQuote`: the deal's books did not deduct
 * them.
 */
import {
  BotType,
  DCADealStatusEnum,
  DCATypeEnum,
  StatusEnum,
} from '../../../types'
import {
  comboBotDb,
  comboDealsDb,
  dcaBotDb,
  dcaDealsDb,
  feeDb,
  orderDb,
  userDb,
} from '../../db/dbInit'
import { zeroFeeApplies } from '../../bot/zeroFee'
import logger from '../../utils/logger'
import {
  convertedFeeQuote,
  feeLegsByPair,
  feePriceVenueOf,
  feeTimeOf,
} from '../../bot/feeAssetPrice'
import {
  type FeePriceRequest,
  feeAssetPrices,
  priceKey,
} from './feeAssetPrices'
import {
  type CostDeal,
  type DealCostBreakdown,
  type DealSlippageFacts,
  type OrderFeeQuote,
  type OrderSlippage,
  type SlippageBotContext,
  type SlippageOrder,
  type TradingCostsRow,
  type UnbookedFees,
  dealCostBreakdown,
  dealSlippage,
  feesEstimatedOf,
  fillOf,
  isMarketOrder,
  isUnbookedFeeOrder,
  needsBotContext,
  needsStoredFeeRate,
  orderFeeQuote,
  orderSlippage,
  slippageContextFromBot,
  sumTradingCosts,
  sumUnbookedFees,
  usdProfitFeeDeduction,
  withUnbookedFees,
} from '../../bot/orderSlippage'

const logPrefix = 'TradingCosts |'

const IN_CHUNK = 500
const BOT_CONTEXT_TTL_MS = 60_000
const CLOSED_DEAL_TTL_MS = 6 * 60 * 60_000
const HISTORICAL_TTL_MS = 6 * 60 * 60_000
const AGGREGATE_TTL_MS = 60_000
const FEE_RATE_TTL_MS = 5 * 60_000

type FeeRate = { maker: number; taker: number }

/** A user's stored fee rates by `exchangeUUID@pair`, and their zero-fee connections. */
type UserFeeRates = { rates: Map<string, FeeRate>; zeroFee: Set<string> }

type FeeOrder = SlippageOrder & {
  userId?: string
  exchangeUUID?: string
  symbol?: string
  paperContext?: boolean
}
const CACHE_MAX = 20_000

const FINISHED = [DCADealStatusEnum.closed, DCADealStatusEnum.canceled]

const ORDER_PROJECTION = {
  _id: 0,
  type: 1,
  side: 1,
  status: 1,
  typeOrder: 1,
  exchange: 1,
  price: 1,
  origPrice: 1,
  origQty: 1,
  executedQty: 1,
  cummulativeQuoteQty: 1,
  refPrice: 1,
  fundingSource: 1,
  botId: 1,
  dealId: 1,
  feePaid: 1,
  feeBreakdown: 1,
  feeAsset: 1,
  feeSide: 1,
  baseAsset: 1,
  quoteAsset: 1,
  transactTime: 1,
  updateTime: 1,
}

const BOT_PROJECTION = {
  'settings.type': 1,
  'settings.orderSizeType': 1,
  'settings.strategy': 1,
  'settings.profitCurrency': 1,
  'settings.futures': 1,
  'settings.useRiskReduction': 1,
  'settings.useReinvest': 1,
  'settings.startOrderType': 1,
}

const DEAL_PROJECTION = {
  _id: 1,
  botId: 1,
  status: 1,
  exchange: 1,
  'profit.total': 1,
  commission: 1,
  lastPrice: 1,
  avgPrice: 1,
  'settings.profitCurrency': 1,
  'settings.futures': 1,
  'settings.coinm': 1,
  'symbol.quoteAsset': 1,
  'symbol.baseAsset': 1,
  slippage: 1,
  feesEstimated: 1,
  flags: 1,
  feeByAsset: 1,
}

const OBJECT_ID = /^[0-9a-f]{24}$/i

type DealFacts = {
  slippage: DealSlippageFacts | null
  feesEstimated: boolean
  /** True when no order of the deal could be read (e.g. a cold-archived bot). */
  ordersUnavailable?: boolean
}

/** Unbooked fees by dealId for one bot; `complete` = nothing left unpriced. */
type BotUnbooked = { byDeal: Map<string, UnbookedFees>; complete: boolean }

const UNBOOKED_COMPLETE_TTL_MS = 6 * 60 * 60_000
const UNBOOKED_PARTIAL_TTL_MS = 5 * 60_000

type DealDoc = CostDeal & {
  _id?: unknown
  botId?: string
  symbol?: { quoteAsset?: string; baseAsset?: string }
  flags?: string[]
  feeByAsset?: { asset?: string; total?: number; totalUsd?: number }[]
  slippage?: DealSlippageFacts
  feesEstimated?: boolean
}

type HistoricalFacts = {
  byDeal: Map<string, DealSlippageFacts>
  feesEstimated: boolean
}

const chunks = <T>(items: T[], size = IN_CHUNK): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/** Time-bounded memo with a hard size cap (cleared whole when exceeded). */
class TtlCache<V> {
  private items = new Map<string, { value: V; at: number }>()
  constructor(private ttlMs: number) {}
  get(key: string): V | undefined {
    const hit = this.items.get(key)
    if (!hit) return undefined
    if (+new Date() - hit.at > this.ttlMs) {
      this.items.delete(key)
      return undefined
    }
    return hit.value
  }
  set(key: string, value: V) {
    if (this.items.size >= CACHE_MAX) {
      this.items.clear()
    }
    this.items.set(key, { value, at: +new Date() })
  }
}

/**
 * Coalesces the keys asked for in one tick into one load. GraphQL resolves the
 * fields of every item of a list in the same tick, so a page of N deals costs
 * one query, not N.
 */
class KeyBatcher<V> {
  private pending = new Map<string, ((v: V) => void)[]>()
  private scheduled = false
  constructor(
    private run: (keys: string[]) => Promise<Map<string, V>>,
    private fallback: V,
  ) {}
  load(key: string): Promise<V> {
    return new Promise<V>((resolve) => {
      const waiting = this.pending.get(key) ?? []
      waiting.push(resolve)
      this.pending.set(key, waiting)
      if (!this.scheduled) {
        this.scheduled = true
        setImmediate(() => void this.flush())
      }
    })
  }
  private async flush() {
    const batch = this.pending
    this.pending = new Map()
    this.scheduled = false
    let result = new Map<string, V>()
    try {
      result = await this.run([...batch.keys()])
    } catch (e) {
      logger.warn(
        `${logPrefix} batch load failed: ${(e as Error)?.message ?? e}`,
      )
    }
    for (const [key, waiting] of batch) {
      const value = result.has(key) ? (result.get(key) as V) : this.fallback
      for (const resolve of waiting) resolve(value)
    }
  }
}

export class TradingCostsService {
  private static _instance: TradingCostsService | null = null
  static getInstance(): TradingCostsService {
    if (!TradingCostsService._instance) {
      TradingCostsService._instance = new TradingCostsService()
    }
    return TradingCostsService._instance
  }

  private botContextCache = new TtlCache<SlippageBotContext | null>(
    BOT_CONTEXT_TTL_MS,
  )
  private closedDealCache = new TtlCache<DealFacts>(CLOSED_DEAL_TTL_MS)
  private historicalCache = new TtlCache<Promise<HistoricalFacts>>(
    HISTORICAL_TTL_MS,
  )
  private aggregateCache = new TtlCache<Promise<TradingCostsRow[]>>(
    AGGREGATE_TTL_MS,
  )
  private orderMemo = new WeakMap<object, Promise<OrderSlippage | null>>()
  private feeMemo = new WeakMap<object, Promise<OrderFeeQuote>>()
  private feeRateCache = new TtlCache<UserFeeRates | null>(FEE_RATE_TTL_MS)
  private userFeeRates = new KeyBatcher<UserFeeRates | null>(
    (ids) => this.readUserFeeRates(ids),
    null,
  )
  private dealMemo = new WeakMap<object, Promise<DealFacts>>()
  private unbookedMemo = new WeakMap<object, Promise<UnbookedFees | null>>()
  private closedUnbookedCache = new TtlCache<UnbookedFees | null>(
    CLOSED_DEAL_TTL_MS,
  )
  private botUnbookedCache = new Map<
    string,
    { at: number; ttl: number; value: Promise<BotUnbooked> }
  >()

  private botContexts = new KeyBatcher<SlippageBotContext | null>(
    (ids) => this.readBotContexts(ids),
    null,
  )
  private dealOrders = new KeyBatcher<SlippageOrder[] | null>(
    (ids) => this.readDealOrders(ids),
    null,
  )

  // ── order level ────────────────────────────────────────────────────────

  orderSlippage(order: SlippageOrder | null | undefined) {
    if (!order || typeof order !== 'object' || !isMarketOrder(order)) {
      return Promise.resolve(null)
    }
    let memo = this.orderMemo.get(order)
    if (!memo) {
      memo = (
        needsBotContext(order)
          ? this.botContext(order.botId)
          : Promise.resolve(null)
      ).then((ctx) => orderSlippage(order, ctx))
      this.orderMemo.set(order, memo)
    }
    return memo
  }

  /**
   * The order's fee in quote (spec 050 §4.4). No read when the venue reported
   * the fee; otherwise the stored rate of its connection and pair, read once
   * per user per batch (`fees` by `userId`, `users` by `_id` for the zero-fee
   * switch) and cached for minutes.
   */
  orderFee(order: FeeOrder | null | undefined): Promise<OrderFeeQuote> {
    if (!order || typeof order !== 'object') {
      return Promise.resolve(orderFeeQuote(null))
    }
    let memo = this.feeMemo.get(order)
    if (!memo) {
      memo = (
        needsStoredFeeRate(order)
          ? this.storedFeeRate(order)
          : Promise.resolve(null)
      )
        .then((rate) => orderFeeQuote(order, rate))
        .then(async (fee) => {
          // A venue-reported fee with no pair-side value: an off-pair leg.
          if (fee.feeQuote !== null || fee.feeEstimated !== false) return fee
          const [converted] = await this.offPairFeesQuote([order])
          return converted === null
            ? fee
            : { feeQuote: converted, feeEstimated: false, feeConverted: true }
        })
      this.feeMemo.set(order, memo)
    }
    return memo
  }

  /**
   * Each order's whole fee in quote, valuing its off-pair legs at the fee
   * asset's price in the minute of the fill. Null per order where any leg
   * cannot be valued, or the order has no off-pair leg. One price batch for
   * all of them.
   */
  private async offPairFeesQuote(
    orders: FeeOrder[],
  ): Promise<(number | null)[]> {
    const plans = orders.map((o) => {
      const venue = feePriceVenueOf(o.exchange)
      const fill = fillOf(o)
      const at = feeTimeOf(o)
      const quote = o.quoteAsset ? `${o.quoteAsset}` : ''
      if (!venue || !fill || at === null || !quote) return null
      const legs = feeLegsByPair(o)
      if (!legs.offPair.length) return null
      const reqs: FeePriceRequest[] = legs.offPair.map((l) => ({
        venue,
        asset: l.asset,
        quote,
        at,
      }))
      return { o, fill, reqs }
    })
    const reqs = plans.flatMap((p) => p?.reqs ?? [])
    if (!reqs.length) return orders.map(() => null)
    const prices = feeAssetPrices().hasSource()
      ? await feeAssetPrices().prices(reqs)
      : new Map<string, number | null>()
    return plans.map((p) => {
      if (!p) return null
      return convertedFeeQuote(p.o, p.fill.price, (asset) => {
        const r = p.reqs.find((x) => x.asset === asset)
        return r ? prices.get(priceKey(r)) : null
      })
    })
  }

  /** Off-pair fees of a deal's orders that its books record as 0. */
  private async unbookedOf(orders: FeeOrder[]): Promise<UnbookedFees | null> {
    const rows = orders.filter((o) => isUnbookedFeeOrder(o))
    if (!rows.length) return null
    const values = await this.offPairFeesQuote(rows)
    return sumUnbookedFees(
      rows.map((o, i) => ({
        assets: feeLegsByPair(o).offPair.map((l) => l.asset),
        feeQuote: values[i],
      })),
    )
  }

  private async storedFeeRate(order: FeeOrder): Promise<FeeRate | null> {
    const userId = order.userId ? `${order.userId}` : ''
    if (!userId || !OBJECT_ID.test(userId) || !order.exchangeUUID) {
      return null
    }
    let user = this.feeRateCache.get(userId)
    if (user === undefined) {
      user = await this.userFeeRates.load(userId)
      this.feeRateCache.set(userId, user)
    }
    if (!user) {
      return null
    }
    const rate = user.rates.get(`${order.exchangeUUID}@${order.symbol}`)
    if (!rate) {
      return null
    }
    const zero =
      order.exchange &&
      user.zeroFee.has(order.exchangeUUID) &&
      zeroFeeApplies(
        { zeroFee: true, provider: order.exchange as never },
        order.paperContext,
      )
    return zero ? { maker: 0, taker: 0 } : rate
  }

  private async readUserFeeRates(ids: string[]) {
    const out = new Map<string, UserFeeRates>()
    for (const part of chunks(ids)) {
      for (const id of part) {
        out.set(id, { rates: new Map(), zeroFee: new Set() })
      }
      const fees = await feeDb.readData(
        { userId: { $in: part } } as never,
        { userId: 1, exchangeUUID: 1, pair: 1, maker: 1, taker: 1 } as never,
        undefined,
        true,
      )
      for (const f of (fees.data?.result ?? []) as {
        userId: string
        exchangeUUID: string
        pair: string
        maker: number
        taker: number
      }[]) {
        out.get(`${f.userId}`)?.rates.set(`${f.exchangeUUID}@${f.pair}`, {
          maker: +f.maker,
          taker: +f.taker,
        })
      }
      const users = await userDb.readData(
        { _id: { $in: part } } as never,
        { 'exchanges.uuid': 1, 'exchanges.zeroFee': 1 } as never,
        undefined,
        true,
      )
      for (const u of (users.data?.result ?? []) as {
        _id: unknown
        exchanges?: { uuid?: string; zeroFee?: boolean }[]
      }[]) {
        for (const e of u.exchanges ?? []) {
          if (e?.zeroFee && e.uuid) out.get(`${u._id}`)?.zeroFee.add(e.uuid)
        }
      }
    }
    return out
  }

  private async botContext(botId?: string) {
    if (!botId || !OBJECT_ID.test(botId)) {
      return null
    }
    const cached = this.botContextCache.get(botId)
    if (cached !== undefined) {
      return cached
    }
    const ctx = await this.botContexts.load(botId)
    this.botContextCache.set(botId, ctx)
    return ctx
  }

  private async readBotContexts(ids: string[]) {
    const out = new Map<string, SlippageBotContext | null>()
    for (const part of chunks(ids)) {
      const dca = await dcaBotDb.readData(
        { _id: { $in: part } } as never,
        BOT_PROJECTION as never,
        undefined,
        true,
      )
      for (const b of dca.data?.result ?? []) {
        out.set(`${b._id}`, slippageContextFromBot('dca', b.settings as never))
      }
      const rest = part.filter((id) => !out.has(id))
      if (!rest.length) continue
      const combo = await comboBotDb.readData(
        { _id: { $in: rest } } as never,
        BOT_PROJECTION as never,
        undefined,
        true,
      )
      for (const b of combo.data?.result ?? []) {
        out.set(
          `${b._id}`,
          slippageContextFromBot('combo', b.settings as never),
        )
      }
    }
    return out
  }

  // ── deal level ─────────────────────────────────────────────────────────

  dealSlippage(deal: DealDoc | null | undefined) {
    return this.dealFacts(deal).then((f) => {
      const s = f?.slippage
      return s
        ? {
            quote: s.quote,
            bps: s.bps,
            orders: s.orders,
            reconstructed: s.reconstructed,
          }
        : null
    })
  }

  dealCostBreakdown(
    deal: DealDoc | null | undefined,
  ): Promise<DealCostBreakdown | null> {
    if (!deal || !FINISHED.includes(deal.status as DCADealStatusEnum)) {
      return Promise.resolve(null)
    }
    // A deal whose orders cannot be read still has its booked result; it is
    // decomposed with no slippage and its fee figure marked as estimated.
    return Promise.all([this.dealFacts(deal), this.dealUnbooked(deal)]).then(
      ([f, unbooked]) =>
        f
          ? withUnbookedFees(
              dealCostBreakdown(deal, f.slippage, f.feesEstimated),
              unbooked,
              usdProfitFeeDeduction(deal),
            )
          : null,
    )
  }

  /**
   * The deal's off-pair fees. Only for a closed deal on a fee-token venue;
   * reads the deal's orders through the same per-page batch as the facts.
   */
  private dealUnbooked(deal: DealDoc): Promise<UnbookedFees | null> {
    if (
      deal.status !== DCADealStatusEnum.closed ||
      !feePriceVenueOf(deal.exchange)
    ) {
      return Promise.resolve(null)
    }
    const id = deal._id ? `${deal._id}` : ''
    if (!id) return Promise.resolve(null)
    let memo = this.unbookedMemo.get(deal)
    if (!memo) {
      const cached = this.closedUnbookedCache.get(id)
      memo =
        cached !== undefined
          ? Promise.resolve(cached)
          : this.dealOrders.load(id).then(async (orders) => {
              const u = orders?.length ? await this.unbookedOf(orders) : null
              if (!u?.partial) this.closedUnbookedCache.set(id, u)
              return u
            })
      this.unbookedMemo.set(deal, memo)
    }
    return memo
  }

  private dealFacts(deal: DealDoc | null | undefined) {
    if (!deal || typeof deal !== 'object') {
      return Promise.resolve(null)
    }
    let memo = this.dealMemo.get(deal)
    if (!memo) {
      memo = this.loadDealFacts(deal)
      this.dealMemo.set(deal, memo)
    }
    return memo
  }

  private async loadDealFacts(deal: DealDoc): Promise<DealFacts> {
    if (typeof deal.feesEstimated === 'boolean') {
      return {
        slippage: deal.slippage ?? null,
        feesEstimated: deal.feesEstimated,
      }
    }
    const id = deal._id ? `${deal._id}` : ''
    if (!id) {
      return { slippage: null, feesEstimated: true, ordersUnavailable: true }
    }
    const finished = FINISHED.includes(deal.status as DCADealStatusEnum)
    const cached = finished ? this.closedDealCache.get(id) : undefined
    if (cached) {
      return cached
    }
    const orders = await this.dealOrders.load(id)
    if (!orders || !orders.length) {
      return { slippage: null, feesEstimated: true, ordersUnavailable: true }
    }
    const facts = await this.factsFromOrders(orders)
    if (finished) {
      this.closedDealCache.set(id, facts)
    }
    return facts
  }

  private async factsFromOrders(orders: SlippageOrder[]): Promise<DealFacts> {
    const contexts = new Map<string, SlippageBotContext | null>()
    for (const o of orders) {
      if (o.botId && needsBotContext(o) && !contexts.has(o.botId)) {
        contexts.set(o.botId, await this.botContext(o.botId))
      }
    }
    return {
      slippage: dealSlippage(orders, (botId) =>
        botId ? contexts.get(botId) : null,
      ),
      feesEstimated: feesEstimatedOf(orders),
    }
  }

  private async readDealOrders(ids: string[]) {
    const out = new Map<string, SlippageOrder[]>()
    for (const part of chunks(ids)) {
      const res = await orderDb.readData(
        {
          dealId: { $in: part },
          status: { $in: ['FILLED', 'CANCELED'] },
        } as never,
        ORDER_PROJECTION as never,
        undefined,
        true,
      )
      for (const o of (res.data?.result ?? []) as (SlippageOrder & {
        dealId?: string
      })[]) {
        const key = `${o.dealId}`
        const list = out.get(key) ?? []
        list.push(o)
        out.set(key, list)
      }
    }
    return out
  }

  // ── aggregates ─────────────────────────────────────────────────────────

  /** The bot's closed-deal costs, in its main quote asset; null when none. */
  async botTradingCosts(
    bot: { _id?: unknown; bots?: unknown[] } | null | undefined,
  ) {
    const ids = (
      bot?.bots?.length
        ? bot.bots.map((b) =>
            b && typeof b === 'object' ? (b as { _id?: unknown })._id : b,
          )
        : [bot?._id]
    )
      .filter(Boolean)
      .map((id) => `${id}`)
    if (!ids.length) {
      return null
    }
    const rows = await this.aggregate(`bot:${[...ids].sort().join(',')}`, [
      { collection: 'dca', filter: { botId: { $in: ids } } },
      { collection: 'combo', filter: { botId: { $in: ids } } },
    ])
    return rows[0] ?? null
  }

  /** Closed-deal costs of an account, one row per quote asset. */
  async accountTradingCosts(
    userId: string,
    paperContext: boolean,
    input: {
      from?: number | null
      to?: number | null
      botType?: string | null
    },
  ) {
    const base: Record<string, unknown> = {
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
    }
    const closeTime: Record<string, number> = {}
    if (Number.isFinite(input.from)) closeTime.$gte = input.from as number
    if (Number.isFinite(input.to)) closeTime.$lte = input.to as number
    if (Object.keys(closeTime).length) {
      base.closeTime = closeTime
    }
    const hedge = { parentBotId: { $exists: true } }
    const own = { parentBotId: { $exists: false } }
    const sources: { collection: 'dca' | 'combo'; filter: object }[] = []
    switch (input.botType) {
      case BotType.dca:
        sources.push({
          collection: 'dca',
          filter: { ...base, ...own, type: { $ne: DCATypeEnum.terminal } },
        })
        break
      case 'terminal':
        sources.push({
          collection: 'dca',
          filter: { ...base, type: DCATypeEnum.terminal },
        })
        break
      case BotType.hedgeDca:
        sources.push({ collection: 'dca', filter: { ...base, ...hedge } })
        break
      case BotType.combo:
        sources.push({ collection: 'combo', filter: { ...base, ...own } })
        break
      case BotType.hedgeCombo:
        sources.push({ collection: 'combo', filter: { ...base, ...hedge } })
        break
      default:
        sources.push({ collection: 'dca', filter: base })
        sources.push({ collection: 'combo', filter: base })
    }
    return this.aggregate(
      `user:${userId}:${!!paperContext}:${input.from ?? ''}:${input.to ?? ''}:${input.botType ?? ''}`,
      sources,
    )
  }

  private aggregate(
    key: string,
    sources: { collection: 'dca' | 'combo'; filter: object }[],
  ) {
    const cached = this.aggregateCache.get(key)
    if (cached) {
      return cached
    }
    const run = this.runAggregate(sources).catch((e) => {
      logger.warn(
        `${logPrefix} aggregate ${key} failed: ${(e as Error)?.message ?? e}`,
      )
      return [] as TradingCostsRow[]
    })
    this.aggregateCache.set(key, run)
    return run
  }

  private async runAggregate(
    sources: { collection: 'dca' | 'combo'; filter: object }[],
  ) {
    const deals: DealDoc[] = []
    for (const s of sources) {
      // Closed deals only: a cancelled deal has no costBreakdown either, so
      // counting it here would make the aggregate disagree with its rows.
      const search = {
        ...s.filter,
        status: DCADealStatusEnum.closed,
      } as never
      const res =
        s.collection === 'dca'
          ? await dcaDealsDb.readData(
              search,
              DEAL_PROJECTION as never,
              undefined,
              true,
            )
          : await comboDealsDb.readData(
              search,
              DEAL_PROJECTION as never,
              undefined,
              true,
            )
      deals.push(...((res.data?.result ?? []) as DealDoc[]))
    }
    const rows = []
    for (const deal of deals) {
      let facts: DealFacts
      if (typeof deal.feesEstimated === 'boolean') {
        facts = {
          slippage: deal.slippage ?? null,
          feesEstimated: deal.feesEstimated,
        }
      } else {
        const hist = deal.botId
          ? await this.historicalFacts(deal.botId)
          : { byDeal: new Map(), feesEstimated: true }
        facts = {
          slippage: hist.byDeal.get(`${deal._id}`) ?? null,
          feesEstimated: hist.feesEstimated,
        }
      }
      const unbooked =
        deal.botId && feePriceVenueOf(deal.exchange)
          ? ((await this.botUnbooked(deal.botId)).byDeal.get(`${deal._id}`) ??
            null)
          : null
      rows.push({
        quoteAsset: deal.symbol?.quoteAsset ?? null,
        breakdown: withUnbookedFees(
          dealCostBreakdown(deal, facts.slippage, facts.feesEstimated),
          unbooked,
          usdProfitFeeDeduction(deal),
        ),
        reconstructed: !!facts.slippage?.reconstructed,
      })
    }
    return sumTradingCosts(rows)
  }

  /**
   * Slippage per deal for a bot's historical deals (closed before close-time
   * facts were recorded), from its MARKET orders only. Closed deals do not
   * change, so this is cached for hours.
   */
  private historicalFacts(botId: string): Promise<HistoricalFacts> {
    const cached = this.historicalCache.get(botId)
    if (cached) {
      return cached
    }
    const run = this.readHistoricalFacts(botId).catch((e) => {
      logger.warn(
        `${logPrefix} historical facts for ${botId} failed: ${(e as Error)?.message ?? e}`,
      )
      return { byDeal: new Map(), feesEstimated: true }
    })
    this.historicalCache.set(botId, run)
    return run
  }

  /**
   * Off-pair fees per deal of a bot, from ONE read of its fee-bearing FILLED
   * deal orders by `botId`. Cached for hours when every fee was valued, for
   * minutes when some were not (so the next view values more of them).
   */
  private botUnbooked(botId: string): Promise<BotUnbooked> {
    const hit = this.botUnbookedCache.get(botId)
    if (hit && +new Date() - hit.at <= hit.ttl) {
      return hit.value
    }
    const entry = {
      at: +new Date(),
      ttl: UNBOOKED_PARTIAL_TTL_MS,
      value: this.readBotUnbooked(botId).catch((e) => {
        logger.warn(
          `${logPrefix} unbooked fees for ${botId} failed: ${(e as Error)?.message ?? e}`,
        )
        return { byDeal: new Map(), complete: false } as BotUnbooked
      }),
    }
    if (this.botUnbookedCache.size >= CACHE_MAX) this.botUnbookedCache.clear()
    this.botUnbookedCache.set(botId, entry)
    void entry.value.then((v) => {
      if (v.complete) entry.ttl = UNBOOKED_COMPLETE_TTL_MS
    })
    return entry.value
  }

  private async readBotUnbooked(botId: string): Promise<BotUnbooked> {
    const res = await orderDb.readData(
      {
        botId,
        status: 'FILLED',
        dealId: { $exists: true },
        $or: [
          { feeAsset: { $exists: true } },
          { 'feeBreakdown.0': { $exists: true } },
        ],
      } as never,
      ORDER_PROJECTION as never,
      undefined,
      true,
    )
    const byDealOrders = new Map<string, FeeOrder[]>()
    for (const o of (res.data?.result ?? []) as (FeeOrder & {
      dealId?: string
    })[]) {
      if (!o.dealId || !isUnbookedFeeOrder(o)) continue
      const list = byDealOrders.get(o.dealId) ?? []
      list.push(o)
      byDealOrders.set(o.dealId, list)
    }
    const all = [...byDealOrders.values()].flat()
    const values = await this.offPairFeesQuote(all)
    const valueOf = new Map(all.map((o, i) => [o, values[i]]))
    const byDeal = new Map<string, UnbookedFees>()
    let complete = true
    for (const [dealId, orders] of byDealOrders) {
      const u = sumUnbookedFees(
        orders.map((o) => ({
          assets: feeLegsByPair(o).offPair.map((l) => l.asset),
          feeQuote: valueOf.get(o) ?? null,
        })),
      )
      if (u) {
        byDeal.set(dealId, u)
        complete = complete && !u.partial
      }
    }
    return { byDeal, complete: complete && res.status === StatusEnum.ok }
  }

  private async readHistoricalFacts(botId: string): Promise<HistoricalFacts> {
    const res = await orderDb.readData(
      {
        botId,
        type: 'MARKET',
        status: { $in: ['FILLED', 'CANCELED'] },
      } as never,
      ORDER_PROJECTION as never,
      undefined,
      true,
    )
    const byDealOrders = new Map<string, SlippageOrder[]>()
    for (const o of (res.data?.result ?? []) as (SlippageOrder & {
      dealId?: string
    })[]) {
      if (!o.dealId) continue
      const list = byDealOrders.get(o.dealId) ?? []
      list.push(o)
      byDealOrders.set(o.dealId, list)
    }
    const ctx = await this.botContext(botId)
    const byDeal = new Map<string, DealSlippageFacts>()
    for (const [dealId, orders] of byDealOrders) {
      const s = dealSlippage(orders, () => ctx)
      if (s) byDeal.set(dealId, s)
    }
    // Conservative: any of the bot's executed deal trades without a
    // venue-reported fee. First match ends the read.
    const estimated = await orderDb.readData(
      {
        botId,
        status: 'FILLED',
        dealId: { $exists: true },
        typeOrder: { $nin: ['br', 'rebalance', 'funding', 'split'] },
        feePaid: { $exists: false },
        'feeBreakdown.0': { $exists: false },
      } as never,
      { _id: 1 } as never,
      { limit: 1 },
      true,
    )
    return {
      byDeal,
      feesEstimated:
        estimated.status !== StatusEnum.ok ||
        (estimated.data?.result?.length ?? 0) > 0,
    }
  }
}

// Functional facades for the resolver map.
export const tradingCosts = () => TradingCostsService.getInstance()
