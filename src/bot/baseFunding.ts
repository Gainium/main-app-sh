/**
 * Base funding: how much of an asset a bot has to acquire before it can place
 * the orders it is about to commit to, and the one market order that gets it.
 *
 * A short spot deal sells base; a long one spends quote. When the account does
 * not hold enough of the asset the orders consume, the bot can either refuse,
 * or buy (sell) the shortfall first. Grid, hedge DCA and hedge combo each did
 * that maths on their own, and drifted apart — the hedge copies compared the
 * requirement against the balance of the asset being SPENT, so a user holding
 * plenty of quote bought nothing. This module is the single place it lives.
 *
 * The rule it encodes: never buy an asset only to sell it straight back. A
 * deal's base order on a funded leg is a virtual entry (recorded filled at the
 * current price, no trade), so only the orders that rest and fill later — the
 * safety orders and minigrid levels — need real funds, acquired upfront.
 *
 * Pure, so `baseFunding.spec.ts` can pin it.
 */
import { MathHelper } from '../utils/math'
import {
  ActionsEnum,
  BaseFundingEnum,
  Grid,
  OrderSideEnum,
  TypeOrderEnum,
} from '../../types'

const math = new MathHelper()

/**
 * Head-room over the exchange minimum when an order is raised to it, so a tick
 * of price movement between sizing and placement cannot drop it back below.
 * Same factor as the grid swap order.
 */
const MIN_NOTIONAL_HEADROOM = 1.005

export type FundingInput = {
  /**
   * The asset the committed orders consume: `base` for orders that sell base
   * (a short leg), `quote` for orders that spend quote (a long leg).
   */
  needAsset: 'base' | 'quote'
  /** What the committed orders consume, in `needAsset` units. */
  required: number
  /** Free balance of `needAsset`. */
  held: number
  /** Already locked in this bot's own resting orders, in `needAsset` units. */
  inOrders?: number
  /** Latest price, quote per base. */
  price: number
  /**
   * Fee rate taken from the RECEIVED asset of the funding trade. The trade is
   * grossed up by it so the net received still covers the need. 0 when the
   * fee is charged elsewhere.
   */
  feeRate?: number
  /** Exchange minimum order value, in quote. */
  minNotional?: number
  /** Exchange minimum order quantity, in base. */
  minBase?: number
  basePrecision: number
  /**
   * Free balance of the asset the funding trade SPENDS (quote for a buy, base
   * for a sell). Absent ⇒ affordability is unknown.
   */
  spendable?: number
}

export type FundingTrade = {
  side: OrderSideEnum
  /** Order quantity, in base, rounded up to `basePrecision`. */
  baseQty: number
  /** Approximate quote value of the order at `price`. */
  quoteValue: number
  /** The quantity was raised to meet the exchange minimum. */
  raisedToMin: boolean
  /** `spendable` covers the order; null when `spendable` was not given. */
  affordable: boolean | null
}

export type FundingPlan = {
  needAsset: 'base' | 'quote'
  required: number
  held: number
  inOrders: number
  /** max(0, required − held − inOrders), in `needAsset` units. */
  shortfall: number
  /** max(0, held + inOrders − required), in `needAsset` units. */
  surplus: number
  /** The order that acquires only the shortfall; null when nothing is short. */
  diff: FundingTrade | null
  /** The order that acquires the whole requirement; null when nothing is required. */
  all: FundingTrade | null
  status: 'covered' | 'partial' | 'missing'
}

const finiteOrZero = (v: number | undefined) =>
  v !== undefined && Number.isFinite(v) && v > 0 ? v : 0

/**
 * The single market order that leaves `want` of `needAsset` in the account
 * after fees. Buys base for a base need, sells base for a quote need.
 */
const tradeFor = (want: number, input: FundingInput): FundingTrade | null => {
  const price = finiteOrZero(input.price)
  if (!(want > 0) || !price) {
    return null
  }
  const feeRate = Math.min(Math.max(finiteOrZero(input.feeRate), 0), 0.5)
  const net = 1 - feeRate
  const side =
    input.needAsset === 'base' ? OrderSideEnum.buy : OrderSideEnum.sell
  let baseQty = input.needAsset === 'base' ? want / net : want / (price * net)
  let raisedToMin = false
  const minNotional = finiteOrZero(input.minNotional)
  if (minNotional && baseQty * price < minNotional) {
    baseQty = (minNotional / price) * MIN_NOTIONAL_HEADROOM
    raisedToMin = true
  }
  const minBase = finiteOrZero(input.minBase)
  if (minBase && baseQty < minBase) {
    baseQty = minBase
    raisedToMin = true
  }
  // Round UP so the trade never falls short — after first dropping float
  // noise, or 0.05 − 0.032 = 0.018000000000000002 buys a whole extra step.
  baseQty = math.round(
    math.round(baseQty, input.basePrecision + 8),
    input.basePrecision,
    false,
    true,
  )
  const quoteValue = baseQty * price
  const spendable = input.spendable
  const affordable =
    spendable === undefined || !Number.isFinite(spendable)
      ? null
      : side === OrderSideEnum.buy
        ? spendable >= quoteValue
        : spendable >= baseQty
  return { side, baseQty, quoteValue, raisedToMin, affordable }
}

export function planFunding(input: FundingInput): FundingPlan {
  const required = finiteOrZero(input.required)
  const held = finiteOrZero(input.held)
  const inOrders = finiteOrZero(input.inOrders)
  const covered = held + inOrders
  const shortfall = Math.max(0, required - covered)
  const surplus = Math.max(0, covered - required)
  return {
    needAsset: input.needAsset,
    required,
    held,
    inOrders,
    shortfall,
    surplus,
    diff: tradeFor(shortfall, input),
    all: tradeFor(required, input),
    status: shortfall <= 0 ? 'covered' : covered > 0 ? 'partial' : 'missing',
  }
}

/** Hedge leg actions that place a funding trade. */
export const HEDGE_FUNDING_ACTIONS: ActionsEnum[] = [
  ActionsEnum.buyDiff,
  ActionsEnum.buyForAll,
  ActionsEnum.sellDiff,
  ActionsEnum.sellForAll,
]

export type HedgeLegFundingInput = {
  isLong: boolean
  action: ActionsEnum
  /** The deal's initial orders; only the safety orders (`dealRegular`) count. */
  orders: Pick<Grid, 'qty' | 'price' | 'type'>[]
  price: number
  freeBase: number
  freeQuote: number
  feeRate?: number
  minNotional?: number
  minBase?: number
  basePrecision: number
}

/**
 * The funding order for one hedge leg at deal open (main-app spec 044 §6.5).
 *
 * The leg's base order is filled virtually, so the requirement is its safety
 * orders only — the TP row is sized like the base order and needs nothing. A
 * short leg's safety orders sell base: need Σ qty in base against free base,
 * bought with quote. A long leg's spend quote: need Σ qty × price against free
 * quote, obtained by selling base. `*Diff` buys only the shortfall, `*ForAll`
 * the whole need.
 *
 * Returns null when the action places no funding trade or nothing is needed.
 */
export function planHedgeLegFunding(
  input: HedgeLegFundingInput,
): { plan: FundingPlan; trade: FundingTrade | null } | null {
  if (!HEDGE_FUNDING_ACTIONS.includes(input.action)) {
    return null
  }
  const safety = input.orders.filter(
    (o) => o.type === TypeOrderEnum.dealRegular,
  )
  const required = input.isLong
    ? safety.reduce((acc, o) => acc + o.qty * o.price, 0)
    : safety.reduce((acc, o) => acc + o.qty, 0)
  const plan = planFunding({
    needAsset: input.isLong ? 'quote' : 'base',
    required,
    held: input.isLong ? input.freeQuote : input.freeBase,
    price: input.price,
    feeRate: input.feeRate,
    minNotional: input.minNotional,
    minBase: input.minBase,
    basePrecision: input.basePrecision,
    spendable: input.isLong ? input.freeBase : input.freeQuote,
  })
  const diffAction =
    input.action === ActionsEnum.buyDiff ||
    input.action === ActionsEnum.sellDiff
  return { plan, trade: diffAction ? plan.diff : plan.all }
}

export type ShortSpotFundingInput = {
  mode: BaseFundingEnum
  /** The deal's base order, in base. */
  baseOrderQty: number
  /** Every safety order (and minigrid sell level) the deal commits to, in base. */
  safetyQty: number
  price: number
  freeBase: number
  freeQuote: number
  /** Quote other open deals of this account hold for their virtual entries. */
  reservedQuote?: number
  feeRate?: number
  minNotional?: number
  minBase?: number
  basePrecision: number
}

export type ShortSpotFundingDecision =
  /** Run on the account's own base, as before (or not this deal's call). */
  | { kind: 'held' }
  | {
      kind: 'fund'
      /** The base order, recorded filled at `price` with no trade. */
      virtualEntryQty: number
      /** Quote the virtual entry holds until the deal closes. */
      quoteReserved: number
      /** The upfront buy for the safety orders; null when held base covers them. */
      trade: FundingTrade | null
      /** Free base counted toward the safety orders. */
      heldUsed: number
      /** Quote the deal needs free: the reserve plus the buy. */
      quoteNeeded: number
      /** No base of the account's own is sold by this deal. */
      sourcedByBot: boolean
    }
  /** The account's free quote cannot cover the reserve plus the buy. */
  | { kind: 'refuse'; required: number; available: number }

/**
 * Main-app spec 044 §2.1 — how a short spot deal opens when the free base does
 * not cover it. Never buys base only to sell it straight back: the base order
 * becomes a virtual entry backed by reserved quote, and only the safety orders
 * — which rest and sell later — are funded, upfront, with real base. `auto`
 * counts the free base toward them; `botOnly` never touches it.
 */
export function planShortSpotDealFunding(
  input: ShortSpotFundingInput,
): ShortSpotFundingDecision {
  if (
    input.mode !== BaseFundingEnum.auto &&
    input.mode !== BaseFundingEnum.botOnly
  ) {
    return { kind: 'held' }
  }
  const price = finiteOrZero(input.price)
  if (!price) {
    return { kind: 'held' }
  }
  const baseOrderQty = finiteOrZero(input.baseOrderQty)
  const safetyQty = finiteOrZero(input.safetyQty)
  const freeBase = finiteOrZero(input.freeBase)
  const availableQuote = Math.max(
    0,
    finiteOrZero(input.freeQuote) - finiteOrZero(input.reservedQuote),
  )
  if (
    input.mode === BaseFundingEnum.auto &&
    freeBase >= baseOrderQty + safetyQty
  ) {
    return { kind: 'held' }
  }
  const heldUsed =
    input.mode === BaseFundingEnum.auto ? Math.min(freeBase, safetyQty) : 0
  const plan = planFunding({
    needAsset: 'base',
    required: safetyQty,
    held: heldUsed,
    price,
    feeRate: input.feeRate,
    minNotional: input.minNotional,
    minBase: input.minBase,
    basePrecision: input.basePrecision,
    spendable: availableQuote,
  })
  const trade = plan.diff
  const quoteReserved = baseOrderQty * price
  const quoteNeeded = quoteReserved + (trade?.quoteValue ?? 0)
  if (quoteNeeded > availableQuote) {
    return { kind: 'refuse', required: quoteNeeded, available: availableQuote }
  }
  return {
    kind: 'fund',
    virtualEntryQty: baseOrderQty,
    quoteReserved,
    trade,
    heldUsed,
    quoteNeeded,
    sourcedByBot: heldUsed === 0,
  }
}
