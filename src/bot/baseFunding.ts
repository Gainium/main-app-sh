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
  /**
   * Fraction a funding BUY is grossed up by: venues that size a market buy
   * in quote fill it short by the spread (fix round 3). 0 elsewhere.
   */
  buyHeadroom?: number
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
  if (side === OrderSideEnum.buy) {
    baseQty *= 1 + Math.min(Math.max(finiteOrZero(input.buyHeadroom), 0), 0.05)
  }
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
  /** Quote other funded deals of this account hold (phase 3). */
  reservedQuote?: number
  /** Base other funded deals of this account hold (phase 3). */
  reservedBase?: number
  feeRate?: number
  minNotional?: number
  minBase?: number
  basePrecision: number
}

/** max(0, free − reserved): what a plan may count as the account's own. */
const unreserved = (free: number | undefined, reserved: number | undefined) =>
  Math.max(0, finiteOrZero(free) - finiteOrZero(reserved))

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
    held: input.isLong
      ? unreserved(input.freeQuote, input.reservedQuote)
      : unreserved(input.freeBase, input.reservedBase),
    price: input.price,
    feeRate: input.feeRate,
    minNotional: input.minNotional,
    minBase: input.minBase,
    basePrecision: input.basePrecision,
    spendable: input.isLong
      ? unreserved(input.freeBase, input.reservedBase)
      : unreserved(input.freeQuote, input.reservedQuote),
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
  /**
   * Base other open deals of this account hold (a long hedge leg's virtual
   * entry, phase 3) — not the account's to sell.
   */
  reservedBase?: number
  feeRate?: number
  buyHeadroom?: number
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
  const freeBase = unreserved(input.freeBase, input.reservedBase)
  const availableQuote = unreserved(input.freeQuote, input.reservedQuote)
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
    buyHeadroom: input.buyHeadroom,
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

/** Phase 3: the hedge `*Diff` actions use held funds first, `*ForAll` never. */
export const hedgeActionFundingMode = (
  action: ActionsEnum,
): BaseFundingEnum | null =>
  action === ActionsEnum.buyDiff || action === ActionsEnum.sellDiff
    ? BaseFundingEnum.auto
    : action === ActionsEnum.buyForAll || action === ActionsEnum.sellForAll
      ? BaseFundingEnum.botOnly
      : null

export type HedgeLegDealFundingInput = {
  isLong: boolean
  action: ActionsEnum
  /**
   * The leg has DCA levels. A funding action without DCA sends a real base
   * order (phase 1 behaviour). Default true.
   */
  useDca?: boolean
  /** The leg's base order, in base — recorded filled with no trade. */
  baseOrderQty: number
  /**
   * Short leg: Σ base its safety orders sell — with combo's per-level padding
   * and anything else the deal sells upfront (a combo fee order).
   */
  safetyQty: number
  /** Long leg: Σ quote its safety orders (and a combo fee order) spend. */
  safetyQuote: number
  price: number
  freeBase: number
  freeQuote: number
  /** Quote other funded deals of this account hold. */
  reservedQuote?: number
  /** Base other funded deals of this account hold. */
  reservedBase?: number
  feeRate?: number
  /** See {@link FundingInput.buyHeadroom}. */
  buyHeadroom?: number
  minNotional?: number
  minBase?: number
  basePrecision: number
}

export type HedgeLegFundingDecision =
  /**
   * Nothing of the account's is planned: `noAction` (no deal) or
   * `useOppositeBalance` (virtual base order and virtual levels).
   */
  | { kind: 'none' }
  /**
   * Runs on the account's own funds with a REAL base order: `useBalance`, a
   * funding action without DCA, or a `*Diff` action whose held funds cover
   * the whole deal (§8, decision 5). Nothing is traded; `required` of
   * `needAsset` is held for the deal until its orders are on the book.
   */
  | {
      kind: 'held'
      needAsset: 'base' | 'quote'
      /** What the leg's own orders consume, in `needAsset`. */
      required: number
      /** Free `needAsset` after reservations. */
      held: number
    }
  | {
      kind: 'fund'
      mode: BaseFundingEnum
      /** `base` for a short leg, `quote` for a long one. */
      needAsset: 'base' | 'quote'
      /** What the safety orders consume, in `needAsset`. */
      required: number
      /** Free `needAsset` after other deals' reservations. */
      held: number
      /** Of `held`, what this leg counts toward its safety orders. */
      heldUsed: number
      /** The base order, recorded filled at `price` with no trade. */
      virtualEntryQty: number
      /** Short: quote the virtual entry holds until the deal closes. */
      quoteReserved: number
      /** Long: held base the virtual entry holds until the deal closes. */
      baseReserved: number
      /** The upfront trade for the safety orders; null when held covers them. */
      trade: FundingTrade | null
      /** What the leg takes from the account: quote (short) or base (long). */
      spendNeeded: number
      /** No funds of the account's own are sold or used by this leg. */
      sourcedByBot: boolean
    }
  | {
      kind: 'refuse'
      /** The asset that is short. */
      asset: 'base' | 'quote'
      /** In `asset`: what the leg needs from it, and what is free for it. */
      required: number
      available: number
      /** What the leg's orders consume and what was held, as in `fund`. */
      need: { asset: 'base' | 'quote'; required: number; held: number }
    }

/**
 * Main-app spec 044 §8 (phase 3) — how one hedge leg on spot opens, for every
 * start action.
 *
 * Funding actions with DCA (`buyDiff` / `buyForAll` short, `sellDiff` /
 * `sellForAll` long): the base order is a virtual entry. Short: the quote it
 * "produced" is reserved for the take profit, and the safety orders' base is
 * bought upfront (`*Diff` counts the free base first, `*ForAll` buys it all).
 * Long, the mirror: the entry is backed by base the account holds, reserved
 * for the take profit, and the safety orders' quote is raised by selling base
 * upfront. A `*Diff` leg whose own free funds already cover the base order
 * plus the safety orders trades nothing and runs on them with a real base
 * order (`held`), as phase 2 `auto` does; `*ForAll` always funds.
 *
 * `useBalance` and a funding action without DCA run on the account's own
 * funds (`held`, or `refuse` when they do not cover it); `useOppositeBalance`
 * spends nothing (`none`).
 * Every held amount is net of what other funded deals reserve.
 */
export function planHedgeLegDealFunding(
  input: HedgeLegDealFundingInput,
): HedgeLegFundingDecision {
  const price = finiteOrZero(input.price)
  const useDca = input.useDca ?? true
  if (
    !price ||
    input.action === ActionsEnum.noAction ||
    // Virtual base order AND virtual safety levels (the engine suppresses
    // its `dealRegular` orders and fills levels by price): it spends nothing
    // of the account's at start.
    input.action === ActionsEnum.useOppositeBalance
  ) {
    return { kind: 'none' }
  }
  const baseOrderQty = finiteOrZero(input.baseOrderQty)
  const safetyQty = useDca ? finiteOrZero(input.safetyQty) : 0
  const safetyQuote = useDca ? finiteOrZero(input.safetyQuote) : 0
  const availableBase = unreserved(input.freeBase, input.reservedBase)
  const availableQuote = unreserved(input.freeQuote, input.reservedQuote)
  const needAsset: 'base' | 'quote' = input.isLong ? 'quote' : 'base'
  const available = input.isLong ? availableQuote : availableBase
  /** The leg's own orders on its own funds, real base order included. */
  const ownNeed = input.isLong
    ? baseOrderQty * price + safetyQuote
    : baseOrderQty + safetyQty
  const held = (required: number): HedgeLegFundingDecision =>
    required > available
      ? {
          kind: 'refuse',
          asset: needAsset,
          required,
          available,
          need: { asset: needAsset, required, held: available },
        }
      : { kind: 'held', needAsset, required, held: available }
  const mode = hedgeActionFundingMode(input.action)
  if (!mode || !useDca) {
    // `useBalance`, or a funding action without DCA: a real base order.
    return held(ownNeed)
  }
  if (mode === BaseFundingEnum.auto && available >= ownNeed) {
    return { kind: 'held', needAsset, required: ownNeed, held: available }
  }
  const limits = {
    price,
    feeRate: input.feeRate,
    buyHeadroom: input.buyHeadroom,
    minNotional: input.minNotional,
    minBase: input.minBase,
    basePrecision: input.basePrecision,
  }
  if (!input.isLong) {
    const required = safetyQty
    const heldUsed =
      mode === BaseFundingEnum.auto ? Math.min(availableBase, required) : 0
    const trade = planFunding({
      needAsset: 'base',
      required,
      held: heldUsed,
      spendable: availableQuote,
      ...limits,
    }).diff
    const quoteReserved = baseOrderQty * price
    const spendNeeded = quoteReserved + (trade?.quoteValue ?? 0)
    if (spendNeeded > availableQuote) {
      return {
        kind: 'refuse',
        asset: 'quote',
        required: spendNeeded,
        available: availableQuote,
        need: { asset: 'base', required, held: availableBase },
      }
    }
    return {
      kind: 'fund',
      mode,
      needAsset: 'base',
      required,
      held: availableBase,
      heldUsed,
      virtualEntryQty: baseOrderQty,
      quoteReserved,
      baseReserved: 0,
      trade,
      spendNeeded,
      sourcedByBot: heldUsed === 0,
    }
  }
  const required = safetyQuote
  const heldUsed =
    mode === BaseFundingEnum.auto ? Math.min(availableQuote, required) : 0
  const baseReserved = baseOrderQty
  const trade = planFunding({
    needAsset: 'quote',
    required,
    held: heldUsed,
    spendable: Math.max(0, availableBase - baseReserved),
    ...limits,
  }).diff
  const spendNeeded = baseReserved + (trade?.baseQty ?? 0)
  if (spendNeeded > availableBase) {
    return {
      kind: 'refuse',
      asset: 'base',
      required: spendNeeded,
      available: availableBase,
      need: { asset: 'quote', required, held: availableQuote },
    }
  }
  return {
    kind: 'fund',
    mode,
    needAsset: 'quote',
    required,
    held: availableQuote,
    heldUsed,
    virtualEntryQty: baseOrderQty,
    quoteReserved: 0,
    baseReserved,
    trade,
    spendNeeded,
    // The entry is the account's own base, whose cost the bot never knew.
    sourcedByBot: false,
  }
}

/**
 * The quantity a combo fee order (`settings.feeOrder`) trades at deal open —
 * an upper bound of `MainBot._placeFeeOrder`'s size, which is
 * `max(minBase, minNotional / price × 1.05, ref × maker × 10)` with `ref` the
 * largest minigrid order of the deal's side. A minigrid order is a share of
 * its level, so the largest level (or the base order) bounds `ref`.
 * `levelsMultiplier` covers the KuCoin variant, which multiplies by the
 * minigrid levels. 0 when no fee order is placed.
 */
export function comboFeeOrderQty(input: {
  feeOrder: boolean
  makerFee: number
  maxLevelQty: number
  price: number
  minNotional?: number
  minBase?: number
  basePrecision: number
  levelsMultiplier?: number
}): number {
  const price = finiteOrZero(input.price)
  if (!input.feeOrder || !(input.makerFee > 0) || !price) {
    return 0
  }
  const size = Math.max(
    finiteOrZero(input.minBase),
    (finiteOrZero(input.minNotional) / price) * 1.05,
    finiteOrZero(input.maxLevelQty) * input.makerFee * 10,
  )
  return math.round(
    size * Math.max(1, finiteOrZero(input.levelsMultiplier)),
    input.basePrecision,
    false,
    true,
  )
}

export type HedgeLegPlanInput = Omit<
  HedgeLegDealFundingInput,
  | 'price'
  | 'freeBase'
  | 'freeQuote'
  | 'reservedQuote'
  | 'reservedBase'
  | 'feeRate'
  | 'buyHeadroom'
  | 'minNotional'
  | 'minBase'
  | 'basePrecision'
> & { useDca: boolean }

export type HedgeJointFundingInput = {
  legs: HedgeLegPlanInput[]
  price: number
  freeBase: number
  freeQuote: number
  reservedQuote?: number
  reservedBase?: number
  feeRate?: number
  buyHeadroom?: number
  minNotional?: number
  minBase?: number
  basePrecision: number
}

export type HedgeLegPlan = {
  input: HedgeLegPlanInput
  decision: HedgeLegFundingDecision
}

/**
 * The legs of one hedge on one account, planned IN THE GIVEN ORDER, each
 * seeing what the ones before it took — what the engine does when the legs
 * take the account's funding lock in that order. A funded leg spends its
 * trade's input asset, receives the trade's output (net of the fee), commits
 * the held and bought funds to its safety orders, and reserves its entry; a
 * `held` leg commits what its own orders consume.
 */
export function planHedgeFundingInOrder(
  input: HedgeJointFundingInput,
): HedgeLegPlan[] {
  const feeNet = 1 - Math.min(Math.max(finiteOrZero(input.feeRate), 0), 0.5)
  let freeBase = finiteOrZero(input.freeBase)
  let freeQuote = finiteOrZero(input.freeQuote)
  let reservedBase = finiteOrZero(input.reservedBase)
  let reservedQuote = finiteOrZero(input.reservedQuote)
  return input.legs.map((leg) => {
    const decision = planHedgeLegDealFunding({
      ...leg,
      price: input.price,
      freeBase,
      freeQuote,
      reservedBase,
      reservedQuote,
      feeRate: input.feeRate,
      buyHeadroom: input.buyHeadroom,
      minNotional: input.minNotional,
      minBase: input.minBase,
      basePrecision: input.basePrecision,
    })
    if (decision.kind === 'fund') {
      const t = decision.trade
      if (t?.side === OrderSideEnum.buy) {
        freeQuote -= t.quoteValue
        freeBase += t.baseQty * feeNet
      } else if (t) {
        freeBase -= t.baseQty
        freeQuote += t.quoteValue * feeNet
      }
      reservedQuote += decision.quoteReserved
      reservedBase += decision.baseReserved
    }
    if (decision.kind === 'fund' || decision.kind === 'held') {
      // What the leg's orders will hold.
      if (decision.needAsset === 'base') {
        freeBase = Math.max(0, freeBase - decision.required)
      } else {
        freeQuote = Math.max(0, freeQuote - decision.required)
      }
    }
    return { input: leg, decision }
  })
}

const severity = (d: HedgeLegFundingDecision) =>
  d.kind === 'refuse' ? 3 : d.kind === 'fund' ? 2 : d.kind === 'held' ? 1 : 0

/**
 * The legs of one hedge planned the way the dashboard must show them (spec
 * 044 §8.5): the engine has no order — whichever leg takes the account's
 * funding lock first goes first — so both orders are planned and each leg
 * gets its WORSE outcome (refuse over fund over held; for the same kind, the
 * plan where it went second, which saw the other leg's take). Rule: when this
 * says a leg opens, it opens in either order, if balances do not change.
 * Legs come back SHORT first, then LONG.
 */
export function planHedgeFundingJointly(
  input: HedgeJointFundingInput,
): HedgeLegPlan[] {
  const shorts = input.legs.filter((l) => !l.isLong)
  const longs = input.legs.filter((l) => l.isLong)
  const a = planHedgeFundingInOrder({ ...input, legs: [...shorts, ...longs] })
  const b = planHedgeFundingInOrder({ ...input, legs: [...longs, ...shorts] })
  const bFor = new Map(b.map((p) => [p.input, p]))
  return a.map((pa) => {
    const pb = bFor.get(pa.input) ?? pa
    const sa = severity(pa.decision)
    const sb = severity(pb.decision)
    if (sa !== sb) {
      return sa > sb ? pa : pb
    }
    // Same kind: the plan in which this leg went second (longs in `a`,
    // shorts in `b`).
    return pa.input.isLong ? pa : pb
  })
}
