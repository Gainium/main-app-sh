/**
 * Valuing a fee the venue charged in an asset that is NEITHER side of the
 * pair (an exchange token such as BNB, BGB or KCS) in the pair's quote asset.
 *
 * Pure: no I/O, no clock. The caller resolves prices; this module decides
 * which price is needed and does the arithmetic.
 *
 * The price used is the fee asset's market price at the fill, read from the
 * one-minute candle that contains the fill time, on the spot market of the
 * same venue. The candle is reduced to one number as `(open + high + low +
 * close) / 4`: the fill can be anywhere inside the minute, and the four-point
 * average is the one value that is not biased toward either end of it (the
 * close is the price at the END of the minute, which a fill near the start
 * of a fast minute did not see).
 *
 * Route, in order:
 *
 *   1. the direct pair `<FEE>/<QUOTE>` on that venue;
 *   2. `<FEE>/USDT`, when the quote is a USD stablecoin (`USD_PEGGED`): the
 *      stablecoin is taken at 1 USDT. Only used when (1) does not exist;
 *   3. `<FEE>/USDT ÷ <QUOTE>/USDT`, for any other quote that has a USDT pair.
 *
 * Anything else, or any candle that cannot be read, leaves the fee UNPRICED:
 * the caller reports it as unknown. An unpriced fee is never 0 and never
 * replaced by the stored-rate estimate.
 */
import type { Order } from '../../types'
import { observedFeeLegs } from './feeLedger'

export const FEE_PRICE_INTERVAL = '1m'
export const MINUTE_MS = 60_000

/** USD stablecoins taken at 1 USDT when no direct pair exists (route 2). */
export const USD_PEGGED = new Set(['USDT', 'USDC', 'USD', 'FDUSD'])

/**
 * The spot venue whose market prices an exchange token for an order on
 * `exchange`. Only venues that let an account pay trading fees in their own
 * token are listed; an order elsewhere has no third-asset fee to value, so
 * callers can skip reading it at all. Inverse contracts are absent: their
 * costs are not decomposed.
 */
export const FEE_TOKEN_VENUES: Readonly<Record<string, string>> = {
  binance: 'binance',
  binanceUS: 'binanceUS',
  binanceUsdm: 'binance',
  bitget: 'bitget',
  bitgetUsdm: 'bitget',
  kucoin: 'kucoin',
  kucoinLinear: 'kucoin',
}

export const feePriceVenueOf = (exchange?: string | null): string | null =>
  (exchange && FEE_TOKEN_VENUES[exchange]) || null

export type FeeLeg = { asset: string; amount: number }

export type FeeOrder = Partial<
  Pick<
    Order,
    | 'feePaid'
    | 'feeSide'
    | 'feeAsset'
    | 'feeBreakdown'
    | 'baseAsset'
    | 'quoteAsset'
    | 'type'
    | 'transactTime'
    | 'updateTime'
  >
>

/** Every fee leg, split into the pair's own legs and the off-pair ones. */
export function feeLegsByPair(
  order: FeeOrder,
  baseAsset?: string,
  quoteAsset?: string,
): { base: number; quote: number; offPair: FeeLeg[] } {
  const base = `${baseAsset ?? order?.baseAsset ?? ''}`.toUpperCase()
  const quote = `${quoteAsset ?? order?.quoteAsset ?? ''}`.toUpperCase()
  const out = { base: 0, quote: 0, offPair: [] as FeeLeg[] }
  for (const leg of observedFeeLegs(order as Partial<Order>, base, quote)) {
    const asset = leg.asset.toUpperCase()
    if (base && asset === base) out.base += leg.amount
    else if (quote && asset === quote) out.quote += leg.amount
    else out.offPair.push({ asset, amount: leg.amount })
  }
  return out
}

/** True when the venue charged at least part of this order's fee off-pair. */
export const hasOffPairFee = (
  order: FeeOrder,
  baseAsset?: string,
  quoteAsset?: string,
): boolean => feeLegsByPair(order, baseAsset, quoteAsset).offPair.length > 0

/**
 * When the order was charged. A MARKET order's `transactTime` is its fill; a
 * LIMIT order can rest after placement, so its last update (the fill, for a
 * filled order) is used instead. Null when neither is a usable time.
 */
export function feeTimeOf(order: FeeOrder): number | null {
  const tx = Number(order?.transactTime)
  const up = Number(order?.updateTime)
  const ok = (v: number) => Number.isFinite(v) && v > 0
  const first = order?.type === 'MARKET' ? [tx, up] : [up, tx]
  return first.find(ok) ?? null
}

/** Start of the minute containing `ms`. */
export const minuteOf = (ms: number): number =>
  Math.floor(ms / MINUTE_MS) * MINUTE_MS

export type FeeCandle = {
  t: number
  o: number
  h: number
  l: number
  c: number
}

/** `(o + h + l + c) / 4`, or null for a candle that is not a usable price. */
export function candleMid(
  c: Partial<FeeCandle> | null | undefined,
): number | null {
  if (!c) return null
  const v = [c.o, c.h, c.l, c.c].map(Number)
  if (!v.every((x) => Number.isFinite(x) && x > 0)) return null
  return (v[0] + v[1] + v[2] + v[3]) / 4
}

export type FeePair = { pair: string; base: string; quote: string }

/**
 * How to price `asset` in `quote` from the venue's pairs: `num` is the pair
 * whose mid is the price, divided by `den`'s mid when present. Null when no
 * route exists. `pegged` marks route 2 (a stablecoin taken at 1 USDT).
 */
export type FeeRoute = { num: string; den?: string; pegged?: true }

export function feeRoute(
  asset: string,
  quote: string,
  pairs: readonly FeePair[],
): FeeRoute | null {
  const a = `${asset}`.toUpperCase()
  const q = `${quote}`.toUpperCase()
  if (!a || !q || a === q) return null
  const find = (b: string, qq: string) =>
    pairs.find(
      (p) => p.base.toUpperCase() === b && p.quote.toUpperCase() === qq,
    )
  const direct = find(a, q)
  if (direct) return { num: direct.pair }
  const viaUsdt = find(a, 'USDT')
  if (!viaUsdt) return null
  if (USD_PEGGED.has(q)) return { num: viaUsdt.pair, pegged: true }
  const quoteUsdt = find(q, 'USDT')
  return quoteUsdt ? { num: viaUsdt.pair, den: quoteUsdt.pair } : null
}

/** The route's price from two mids; null when a needed mid is missing. */
export function routePrice(
  route: FeeRoute,
  midOf: (pair: string) => number | null | undefined,
): number | null {
  const num = midOf(route.num)
  if (!(typeof num === 'number' && num > 0)) return null
  if (!route.den) return num
  const den = midOf(route.den)
  if (!(typeof den === 'number' && den > 0)) return null
  const p = num / den
  return Number.isFinite(p) && p > 0 ? p : null
}

/**
 * The order's WHOLE fee in quote when part or all of it was charged off-pair:
 * the on-pair legs at the fill price plus every off-pair leg at
 * `priceOf(asset)`. Null when the order has no off-pair leg, or when any
 * off-pair leg has no price (a partial figure would read as a complete one).
 */
export function convertedFeeQuote(
  order: FeeOrder,
  fillPrice: number,
  priceOf: (asset: string) => number | null | undefined,
  baseAsset?: string,
  quoteAsset?: string,
): number | null {
  if (!(fillPrice > 0) || !Number.isFinite(fillPrice)) return null
  const legs = feeLegsByPair(order, baseAsset, quoteAsset)
  if (!legs.offPair.length) return null
  let total = legs.quote + legs.base * fillPrice
  for (const leg of legs.offPair) {
    const p = priceOf(leg.asset)
    if (!(typeof p === 'number' && p > 0 && Number.isFinite(p))) return null
    total += leg.amount * p
  }
  return Number.isFinite(total) && total > 0 ? total : null
}
