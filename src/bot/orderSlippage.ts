/**
 * Slippage of MARKET orders, and the fee / slippage decomposition of a deal's
 * booked result.
 *
 * Pure: no I/O, no clock. The engine stamps the inputs at placement
 * (`refPrice`, `refPriceAt`, `sentAt` — see `marketReference`) and the API
 * computes everything else at read time from documents it already holds.
 *
 * Slippage is measured against a REFERENCE price: the market price the engine
 * acted on. It is signed so that POSITIVE is adverse — paid more on a buy,
 * received less on a sell:
 *
 *   bps   = side · (fill − ref) / ref · 10 000      side = +1 BUY, −1 SELL
 *   quote = side · (fill − ref) · qty
 *
 * Where the reference comes from:
 *
 *   - `refPrice` on the order — recorded by the engine at send time. Source
 *     `recorded`.
 *   - otherwise `origPrice`, for the order kinds whose `origPrice` is the
 *     unshifted price the engine sent: take profit / stop, safety and
 *     add-funds orders, fee top-ups, a combo bot's base order and a terminal
 *     bot's base order. For a close that is the trigger / target price, not
 *     the market at send. Source `reconstructed`.
 *   - a regular DCA bot's MARKET base order is sent at a price shifted by a
 *     protective allowance (`getBaseOrder`: `0.005 · (1 + count/10)` against
 *     the side, flipped under compound reduce). The shift is inverted here at
 *     `count = 0` — retries are not recorded on the order, so a retried entry
 *     reads with the first rung's shift — and kept only within ±25 bp. Source
 *     `reconstructed`.
 *
 * Every reference not recorded at send is dropped beyond ±100 bp.
 *
 * Never computed: LIMIT orders (they do not slip; they risk not filling),
 * inverse / coin-margined contracts (their quantity and quote semantics
 * differ), virtual funding rows, and any order kind not listed above that
 * carries no recorded reference.
 */
import type { Order } from '../../types'
import {
  DCADealStatusEnum,
  DCATypeEnum,
  OrderSideEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../types'
import { isCoinm } from '../utils'
import { hasObservedFee, observedFeeOnSide, observedFeeSplit } from './orderFee'

/** `getBaseOrder`'s MARKET allowance for a regular DCA bot at `count = 0`. */
export const DCA_START_MARKET_SHIFT = 0.005

/**
 * A reconstructed reference is only trusted when it lands this close to the
 * fill. Outside it the shift was evidently not the count-0 one (absent,
 * flipped, or widened by a retry), and showing the result would present a
 * shift artefact as a cost the user paid — so the order reads as unknown.
 */
export const RECONSTRUCTED_MAX_ABS_BPS = 25

/**
 * Any reference NOT recorded at send (`origPrice`-based or reconstructed) is
 * only trusted within this distance of the fill. A historical close's
 * `origPrice` can be a TP / SL target the market had already moved past, so a
 * figure beyond this is the target's distance, not slippage. A recorded
 * `refPrice` is never capped.
 */
export const UNRECORDED_MAX_ABS_BPS = 100

export type SlippageSource = 'recorded' | 'reconstructed'

/** What a regular DCA base order's shift depends on, read from its bot. */
export type SlippageBotContext = {
  kind: 'dca' | 'combo'
  terminal: boolean
  /** `useCompountReduce` in the engine: flips the direction of the shift. */
  compoundReduce: boolean
  /**
   * The bot enters with a LIMIT. A MARKET entry on such a bot was either a
   * forced market entry (shifted) or a risk-reward entry (not shifted) — the
   * order does not say which, so it is not reconstructed.
   */
  startOrderLimit: boolean
}

/** The order fields this module reads. */
export type SlippageOrder = Partial<
  Pick<
    Order,
    | 'type'
    | 'side'
    | 'status'
    | 'typeOrder'
    | 'exchange'
    | 'price'
    | 'origPrice'
    | 'origQty'
    | 'executedQty'
    | 'cummulativeQuoteQty'
    | 'refPrice'
    | 'fundingSource'
    | 'botId'
    | 'feePaid'
    | 'feeBreakdown'
    | 'feeSide'
    | 'feeAsset'
    | 'baseAsset'
    | 'quoteAsset'
  >
>

export type OrderSlippage = {
  refPrice: number
  source: SlippageSource
  bps: number
  quote: number
  /** `refPrice × qty` — the weight a deal's average bps is taken over. */
  notional: number
}

export type DealSlippageFacts = {
  quote: number
  bps: number | null
  orders: number
  reconstructed: boolean
  notional: number
}

export type DealCostBreakdown = {
  grossQuote: number
  feesQuote: number
  feesEstimated: boolean
  slippageQuote: number | null
  netQuote: number
}

export type TradingCostsRow = {
  quoteAsset: string | null
  feesQuote: number
  slippageQuote: number
  grossQuote: number
  netQuote: number
  deals: number
  slippageReconstructed: boolean
  feesEstimated: boolean
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(`${v ?? ''}`)
  return Number.isFinite(n) ? n : NaN
}

const positive = (v: unknown): number | null => {
  const n = num(v)
  return n > 0 ? n : null
}

/** Order kinds whose `origPrice` is the unshifted decision price. */
const ORIG_PRICE_IS_REFERENCE = new Set<string>([
  TypeOrderEnum.dealTP,
  TypeOrderEnum.dealRegular,
  TypeOrderEnum.fee,
])

/**
 * Rows that are not one of the deal's own trades, or are already counted
 * through another row (a MARKET_LOT_SIZE split is booked on its parent).
 */
const NOT_A_DEAL_TRADE = new Set<string>([
  TypeOrderEnum.split,
  TypeOrderEnum.br,
  TypeOrderEnum.rebalance,
  TypeOrderEnum.funding,
])

const sideSign = (side: unknown): 1 | -1 | 0 =>
  side === OrderSideEnum.buy ? 1 : side === OrderSideEnum.sell ? -1 : 0

/** The engine's `useCompountReduce`, from bot settings. */
export function compoundReduceOf(settings: Record<string, any>): boolean {
  return !!(
    settings.orderSizeType &&
    [OrderSizeTypeEnum.base, OrderSizeTypeEnum.quote].includes(
      settings.orderSizeType,
    ) &&
    ((settings.strategy === StrategyEnum.long &&
      settings.profitCurrency === 'quote') ||
      (settings.strategy === StrategyEnum.short &&
        settings.profitCurrency === 'base') ||
      settings.futures) &&
    (settings.useRiskReduction || settings.useReinvest)
  )
}

export function slippageContextFromBot(
  kind: 'dca' | 'combo',
  settings: Record<string, any> | undefined | null,
): SlippageBotContext {
  const s = settings ?? {}
  return {
    kind,
    terminal: s.type === DCATypeEnum.terminal,
    compoundReduce: compoundReduceOf(s),
    startOrderLimit: s.startOrderType === OrderTypeEnum.limit,
  }
}

export const isMarketOrder = (o: SlippageOrder | null | undefined) =>
  !!o && o.type === OrderTypeEnum.market

/** True when the order's reference can only be known with its bot's context. */
export function needsBotContext(o: SlippageOrder): boolean {
  return (
    isMarketOrder(o) &&
    positive(o.refPrice) === null &&
    o.typeOrder === TypeOrderEnum.dealStart
  )
}

/** Executed quantity and average fill price, or null when nothing executed. */
export function fillOf(
  o: SlippageOrder,
): { price: number; qty: number } | null {
  const executed = positive(o.executedQty)
  const qty =
    executed ?? (o.status === 'FILLED' ? positive(o.origQty) : null) ?? null
  if (qty === null) {
    return null
  }
  const quote = positive(o.cummulativeQuoteQty)
  const price =
    quote !== null && executed !== null ? quote / executed : positive(o.price)
  return price === null ? null : { price, qty }
}

/** The reference price and how it was obtained, or null when unknown. */
export function referenceOf(
  o: SlippageOrder,
  ctx?: SlippageBotContext | null,
): { refPrice: number; source: SlippageSource; shifted: boolean } | null {
  const recorded = positive(o.refPrice)
  if (recorded !== null) {
    return { refPrice: recorded, source: 'recorded', shifted: false }
  }
  const orig = positive(o.origPrice)
  if (orig === null || !o.typeOrder) {
    return null
  }
  if (ORIG_PRICE_IS_REFERENCE.has(o.typeOrder)) {
    return { refPrice: orig, source: 'reconstructed', shifted: false }
  }
  if (o.typeOrder !== TypeOrderEnum.dealStart || !ctx) {
    return null
  }
  if (ctx.kind === 'combo' || ctx.terminal) {
    return { refPrice: orig, source: 'reconstructed', shifted: false }
  }
  if (ctx.startOrderLimit) {
    return null
  }
  const dir = sideSign(o.side)
  if (dir === 0) {
    return null
  }
  const shift = DCA_START_MARKET_SHIFT * dir * (ctx.compoundReduce ? -1 : 1)
  return {
    refPrice: orig / (1 - shift),
    source: 'reconstructed',
    shifted: true,
  }
}

/** Per-order slippage, or null where it does not apply or cannot be known. */
export function orderSlippage(
  o: SlippageOrder | null | undefined,
  ctx?: SlippageBotContext | null,
): OrderSlippage | null {
  if (!o || !isMarketOrder(o)) {
    return null
  }
  if (o.fundingSource === 'virtual') {
    return null
  }
  if (o.exchange && isCoinm(o.exchange)) {
    return null
  }
  const dir = sideSign(o.side)
  const fill = fillOf(o)
  const ref = referenceOf(o, ctx)
  if (dir === 0 || !fill || !ref) {
    return null
  }
  const diff = dir * (fill.price - ref.refPrice)
  const bps = (diff / ref.refPrice) * 10_000
  const quote = diff * fill.qty
  if (!Number.isFinite(bps) || !Number.isFinite(quote)) {
    return null
  }
  if (ref.shifted && Math.abs(bps) > RECONSTRUCTED_MAX_ABS_BPS) {
    return null
  }
  if (positive(o.refPrice) === null && Math.abs(bps) > UNRECORDED_MAX_ABS_BPS) {
    return null
  }
  return {
    refPrice: ref.refPrice,
    source: ref.source,
    bps,
    quote,
    notional: ref.refPrice * fill.qty,
  }
}

/** An order that executed and is one of the deal's own trades. */
export const isExecutedDealTrade = (o: SlippageOrder) =>
  (o.status === 'FILLED' ||
    (o.status === 'CANCELED' && (positive(o.executedQty) ?? 0) > 0)) &&
  !NOT_A_DEAL_TRADE.has(`${o.typeOrder ?? ''}`)

/**
 * Sum of the deal's MARKET slippage. `bps` is the reference-notional weighted
 * average, i.e. `quote / Σ(ref · qty) · 10 000`. Null when no order counted.
 */
export function dealSlippage(
  orders: SlippageOrder[],
  ctxOf: (botId?: string) => SlippageBotContext | null | undefined,
): DealSlippageFacts | null {
  let quote = 0
  let notional = 0
  let count = 0
  let reconstructed = false
  for (const o of orders) {
    if (!isMarketOrder(o) || !isExecutedDealTrade(o)) {
      continue
    }
    const s = orderSlippage(o, ctxOf(o.botId))
    if (!s) {
      continue
    }
    quote += s.quote
    notional += s.notional
    count += 1
    reconstructed = reconstructed || s.source === 'reconstructed'
  }
  if (count === 0) {
    return null
  }
  return {
    quote,
    bps: notional > 0 ? (quote / notional) * 10_000 : null,
    orders: count,
    reconstructed,
    notional,
  }
}

/**
 * True when at least one executed trade of the deal carries no venue-reported
 * fee, so the books' fee figure for it is the stored-rate estimate.
 */
export function feesEstimatedOf(orders: SlippageOrder[]): boolean {
  return orders.some((o) => isExecutedDealTrade(o) && !hasObservedFee(o))
}

export type OrderFeeQuote = {
  /** Fee in the pair's quote currency; null when it cannot be stated. */
  feeQuote: number | null
  /** True when `feeQuote` is the stored-rate estimate; null when unknown. */
  feeEstimated: boolean | null
}

const NO_FEE: OrderFeeQuote = { feeQuote: null, feeEstimated: null }

/**
 * True when the order's fee can only be stated with its connection's stored
 * fee rate: it executed and the venue reported no fee for it.
 */
export function needsStoredFeeRate(o: SlippageOrder): boolean {
  return (
    !!fillOf(o) && !hasObservedFee(o) && !(o.exchange && isCoinm(o.exchange))
  )
}

/**
 * One order's fee in quote, by the rules the deal books use (`getCommDeal`):
 *
 *   - the venue-reported fee when it resolves to the pair's sides
 *     (`observedFeeSplit`), converted to quote at the order's fill price
 *     (`observedFeeOnSide`);
 *   - a reported fee in a third asset (BNB / BGB / KCS…), or split across
 *     currencies not all on the pair, has no safe conversion here: null, and
 *     NOT an estimate — the books book 0 for it, never the estimate;
 *   - otherwise the stored-rate estimate `qty · fill · rate`, taker for
 *     MARKET, maker for LIMIT. `rate` is 0 on a zero-fee connection, as the
 *     engine's `getUserFee` makes it.
 *
 * Null for orders that did not execute and for inverse contracts.
 */
export function orderFeeQuote(
  o: SlippageOrder | null | undefined,
  rate?: { maker: number; taker: number } | null,
): OrderFeeQuote {
  if (!o) {
    return NO_FEE
  }
  if (o.exchange && isCoinm(o.exchange)) {
    return NO_FEE
  }
  const fill = fillOf(o)
  if (!fill) {
    return NO_FEE
  }
  const split = observedFeeSplit(o, o.baseAsset, o.quoteAsset)
  if (split) {
    const fee = observedFeeOnSide(split, 'quote', fill.price)
    return fee === null ? NO_FEE : { feeQuote: fee, feeEstimated: false }
  }
  if (hasObservedFee(o)) {
    return { feeQuote: null, feeEstimated: false }
  }
  const r = num(isMarketOrder(o) ? rate?.taker : rate?.maker)
  if (!rate || !Number.isFinite(r)) {
    return NO_FEE
  }
  return { feeQuote: fill.qty * fill.price * r, feeEstimated: true }
}

export type CostDeal = {
  status?: string
  exchange?: string
  profit?: { total?: number }
  commission?: number
  lastPrice?: number
  avgPrice?: number
  settings?: { profitCurrency?: string; futures?: boolean; coinm?: boolean }
}

/**
 * Decompose a finished deal's booked result. The books are not recomputed:
 *
 *   netQuote  = profit.total                  (what the deal reports)
 *   feesQuote = commission                    (the fee figure the books
 *                                              subtracted: venue-reported fee
 *                                              per order where observed, the
 *                                              stored-rate estimate otherwise)
 *   grossQuote = netQuote + feesQuote + slippageQuote
 *
 * so `gross − fees − slippage = net` holds to the books' own decimals. A deal
 * booked in base is converted at its `lastPrice`, the rate the books use for
 * its USD figure. CLOSED deals only: null for a deal still running, for a
 * cancelled deal (traded or not), and for inverse contracts.
 */
export function dealCostBreakdown(
  deal: CostDeal | null | undefined,
  slippage: DealSlippageFacts | null | undefined,
  feesEstimated: boolean,
): DealCostBreakdown | null {
  if (!deal) {
    return null
  }
  if (deal.status !== DCADealStatusEnum.closed) {
    return null
  }
  const total = num(deal.profit?.total ?? 0)
  const commission = num(deal.commission ?? 0)
  if (!Number.isFinite(total) || !Number.isFinite(commission)) {
    return null
  }
  const settings = deal.settings ?? {}
  if (settings.coinm || (deal.exchange && isCoinm(deal.exchange as never))) {
    return null
  }
  const profitBase = !settings.futures && settings.profitCurrency === 'base'
  const toQuote = profitBase
    ? (positive(deal.lastPrice) ?? positive(deal.avgPrice))
    : 1
  if (toQuote === null) {
    return null
  }
  const netQuote = total * toQuote
  const feesQuote = commission * toQuote
  const slippageQuote = slippage ? slippage.quote : null
  return {
    grossQuote: netQuote + feesQuote + (slippageQuote ?? 0),
    feesQuote,
    feesEstimated,
    slippageQuote,
    netQuote,
  }
}

/** Sum breakdowns per quote asset. */
export function sumTradingCosts(
  rows: {
    quoteAsset?: string | null
    breakdown: DealCostBreakdown | null
    reconstructed?: boolean
  }[],
): TradingCostsRow[] {
  const byQuote = new Map<string, TradingCostsRow>()
  for (const r of rows) {
    if (!r.breakdown) {
      continue
    }
    const key = r.quoteAsset ?? ''
    const acc = byQuote.get(key) ?? {
      quoteAsset: r.quoteAsset ?? null,
      feesQuote: 0,
      slippageQuote: 0,
      grossQuote: 0,
      netQuote: 0,
      deals: 0,
      slippageReconstructed: false,
      feesEstimated: false,
    }
    acc.feesQuote += r.breakdown.feesQuote
    acc.slippageQuote += r.breakdown.slippageQuote ?? 0
    acc.grossQuote += r.breakdown.grossQuote
    acc.netQuote += r.breakdown.netQuote
    acc.deals += 1
    acc.slippageReconstructed = acc.slippageReconstructed || !!r.reconstructed
    acc.feesEstimated = acc.feesEstimated || r.breakdown.feesEstimated
    byQuote.set(key, acc)
  }
  return [...byQuote.values()].sort((a, b) => b.deals - a.deals)
}

/**
 * The reference the engine stamps on a MARKET order at send time: the last
 * price it holds for the symbol, with that price's OWN observation time (the
 * stream tick's timestamp, or the moment a REST read refreshed it). Absent
 * when the engine holds no price younger than `maxAgeMs` — absent means "not
 * observed", never a stale guess.
 */
export function marketReference(
  last: { price?: number; time?: number } | null | undefined,
  now: number,
  maxAgeMs: number,
): { refPrice: string; refPriceAt: number } | null {
  const price = positive(last?.price)
  const time = num(last?.time)
  if (price === null || !Number.isFinite(time) || now - time >= maxAgeMs) {
    return null
  }
  return { refPrice: `${price}`, refPriceAt: time }
}

/**
 * The placement stamps an order carries, for a rebuild from a venue payload
 * that knows nothing about them. Only present keys are returned, so a spread
 * never writes an `undefined` over a stored value.
 */
type PlacementStamps = Partial<
  Pick<Order, 'refPrice' | 'refPriceAt' | 'sentAt' | 'ackAt'>
>

export function placementStampsOf(o: PlacementStamps): PlacementStamps {
  const out: PlacementStamps = {}
  if (o.refPrice !== undefined) out.refPrice = o.refPrice
  if (o.refPriceAt !== undefined) out.refPriceAt = o.refPriceAt
  if (o.sentAt !== undefined) out.sentAt = o.sentAt
  if (o.ackAt !== undefined) out.ackAt = o.ackAt
  return out
}
