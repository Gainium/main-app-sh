/**
 * `previewFunding` (main-app spec 044 §5) — what a short spot deal the bot
 * funds itself will do, for the dashboard's start / add-DCA dialogs.
 *
 * The dashboard already sizes the deal (it renders the ladder); it sends the
 * base order and safety-order quantities, and this answers with the same
 * planner the engine runs at execution time, against the account's stored
 * balances, the quote other bot-funded deals reserve, the user's fee and the
 * pair's limits. The engine re-plans from a live read when it acts, so this is
 * a preview, not a promise.
 */
import { feeDb, orderDb, pairDb } from '../../db/dbInit'
import {
  ActionsEnum,
  BaseFundingEnum,
  ExchangeEnum as ExchangeEnumValue,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'
import { MathHelper } from '../../utils/math'
import {
  comboFeeOrderQty,
  planFunding,
  planHedgeFundingJointly,
  planShortSpotDealFunding,
} from '../../bot/baseFunding'
import { FundingReservation } from '../../bot/fundingReservation'
import { FUNDING_QUOTE_SIZED_BUY_HEADROOM } from '../../bot/fundingLock'
import { getBalances } from './balance.handler'

import type { ClearUserSchema, ExchangeEnum } from '../../../types'

const math = new MathHelper()

/** Venues that size a MARKET buy in quote (`MainBot.sendOrderToExchange`). */
const QUOTE_SIZED_BUY_VENUES: string[] = [
  ExchangeEnumValue.bybit,
  ExchangeEnumValue.coinbase,
  ExchangeEnumValue.bitget,
]

export type PreviewFundingInput = {
  exchangeUUID: string
  exchange: ExchangeEnum
  pair: string
  mode: BaseFundingEnum
  /** The deal's base order, in base. 0 for an add-DCA preview. */
  baseOrderQty: number
  /**
   * Safety orders the deal commits to, in base. For an add-DCA preview: the
   * deal's unfilled levels after the edit.
   */
  safetyQty: number
  price: number
  /** Set for an add-DCA preview: the deal's resting sells count as covered. */
  dealId?: string
}

const fail = (reason: string) => ({
  status: StatusEnum.notok as const,
  reason,
  data: null,
})

/**
 * What every funding preview plans against: the pair, the account's stored
 * free balances of both assets, what other funded deals reserve, the user's
 * fee and the pair's limits.
 */
const loadFundingContext = async (
  user: ClearUserSchema,
  input: { exchangeUUID: string; exchange: ExchangeEnum; pair: string },
  paperContext?: boolean,
) => {
  const userId = user._id.toString()
  if (!user.exchanges.some((e) => e.uuid === input.exchangeUUID)) {
    return fail('Exchange not found')
  }
  const pair = await pairDb.readData(
    { pair: input.pair, exchange: input.exchange },
    undefined,
    {},
    false,
    false,
  )
  if (pair.status === StatusEnum.notok || !pair.data.result) {
    return fail(`Data about ${input.pair} not found`)
  }
  const { baseAsset, quoteAsset } = pair.data.result
  const balances = await getBalances(
    user,
    false,
    [baseAsset.name, quoteAsset.name],
    input.exchangeUUID,
    paperContext,
  )
  if (balances.status === StatusEnum.notok) {
    return fail(balances.reason ?? 'Cannot read balances')
  }
  const rows: { asset: string; free: string | number }[] = balances.data ?? []
  const freeOf = (asset: string) =>
    +(rows.find((r) => r.asset === asset)?.free ?? 0)
  const freeBase = freeOf(baseAsset.name)
  const freeQuote = freeOf(quoteAsset.name)
  const fee = await feeDb.readData(
    { userId, exchangeUUID: input.exchangeUUID, pair: input.pair },
    undefined,
    {},
    false,
    false,
  )
  const feeRate =
    fee.status === StatusEnum.ok ? (fee.data.result?.taker ?? 0) : 0
  const makerFee =
    fee.status === StatusEnum.ok ? (fee.data.result?.maker ?? 0) : 0
  const reservedQuote = await FundingReservation.getInstance().reservedQuote(
    input.exchangeUUID,
    quoteAsset.name,
  )
  const reservedBase = await FundingReservation.getInstance().reservedBase(
    input.exchangeUUID,
    baseAsset.name,
  )
  const basePrecision = math.getPricePrecision(`${baseAsset.step}`)
  return {
    status: StatusEnum.ok as const,
    userId,
    baseAsset: baseAsset.name,
    quoteAsset: quoteAsset.name,
    freeBase,
    freeQuote,
    reservedQuote,
    reservedBase,
    makerFee,
    baseStep: +(baseAsset.step ?? 0),
    limits: {
      feeRate,
      // Engine parity (fix round 3 c): funding buys on venues that size a
      // market buy in quote are grossed up by the spread headroom.
      buyHeadroom: QUOTE_SIZED_BUY_VENUES.includes(input.exchange)
        ? FUNDING_QUOTE_SIZED_BUY_HEADROOM
        : 0,
      minNotional: quoteAsset.minAmount,
      minBase: baseAsset.minAmount,
      basePrecision,
    },
  }
}

export const previewFunding = async (
  user: ClearUserSchema,
  input: PreviewFundingInput,
  paperContext?: boolean,
) => {
  if (!Object.values(BaseFundingEnum).includes(input.mode)) {
    return fail(`Unknown funding mode ${input.mode}`)
  }
  const ctx = await loadFundingContext(user, input, paperContext)
  if (ctx.status !== StatusEnum.ok) {
    return ctx
  }
  const { userId, freeBase, freeQuote, reservedQuote, reservedBase, limits } =
    ctx
  const common = {
    baseAsset: ctx.baseAsset,
    quoteAsset: ctx.quoteAsset,
    freeBase,
    freeQuote,
    reservedQuote,
  }
  if (input.dealId) {
    const resting = await orderDb.readData(
      {
        userId,
        dealId: input.dealId,
        typeOrder: TypeOrderEnum.dealRegular,
        side: OrderSideEnum.sell,
        status: { $in: ['NEW', 'PARTIALLY_FILLED'] },
      },
      { origQty: 1, executedQty: 1 },
      {},
      true,
    )
    const inOrders =
      resting.status === StatusEnum.ok
        ? resting.data.result.reduce(
            (acc, o) => acc + Math.max(0, +o.origQty - +(o.executedQty ?? 0)),
            0,
          )
        : 0
    const plan = planFunding({
      needAsset: 'base',
      required: input.safetyQty,
      held:
        input.mode === BaseFundingEnum.auto
          ? Math.max(0, freeBase - reservedBase)
          : 0,
      inOrders,
      price: input.price,
      ...limits,
      spendable: Math.max(0, freeQuote - reservedQuote),
    })
    const trade = plan.diff
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        ...common,
        kind: !trade ? 'held' : trade.affordable === false ? 'refuse' : 'fund',
        required: plan.required,
        inOrders,
        shortfall: plan.shortfall,
        buyQty: trade?.baseQty ?? 0,
        buyQuote: trade?.quoteValue ?? 0,
        raisedToMin: !!trade?.raisedToMin,
      },
    }
  }
  const decision = planShortSpotDealFunding({
    mode: input.mode,
    baseOrderQty: input.baseOrderQty,
    safetyQty: input.safetyQty,
    price: input.price,
    freeBase,
    freeQuote,
    reservedQuote,
    reservedBase,
    ...limits,
  })
  return {
    status: StatusEnum.ok,
    reason: null,
    data: {
      ...common,
      kind: decision.kind,
      required: decision.kind === 'refuse' ? decision.required : undefined,
      available: decision.kind === 'refuse' ? decision.available : undefined,
      virtualEntryQty:
        decision.kind === 'fund' ? decision.virtualEntryQty : undefined,
      quoteReserved:
        decision.kind === 'fund' ? decision.quoteReserved : undefined,
      heldUsed: decision.kind === 'fund' ? decision.heldUsed : undefined,
      quoteNeeded: decision.kind === 'fund' ? decision.quoteNeeded : undefined,
      buyQty: decision.kind === 'fund' ? (decision.trade?.baseQty ?? 0) : 0,
      buyQuote:
        decision.kind === 'fund' ? (decision.trade?.quoteValue ?? 0) : 0,
      raisedToMin: decision.kind === 'fund' && !!decision.trade?.raisedToMin,
      sourcedByBot:
        decision.kind === 'fund' ? decision.sourcedByBot : undefined,
    },
  }
}

export type PreviewHedgeFundingLegInput = {
  /** "LONG" | "SHORT" */
  side: string
  /** An `ActionsEnum` value. */
  action: string
  /** The leg's base order, in base. */
  baseOrderQty: number
  /** Σ base qty of the leg's safety orders, as rendered. */
  safetyQty: number
  /** Σ qty × price of the leg's safety orders. */
  safetyQuote: number
  useDca: boolean
  /**
   * Combo only (optional, additive to the phase-3 contract): the bot's
   * `gridLevel` and the leg's number of safety levels. A short combo leg's
   * levels each need `pair base step × gridLevel` more base than their qty —
   * the engine's padding (`comboHelper.fundedSafetyQty`).
   */
  comboGridLevel?: number
  safetyLevels?: number
  /** Combo only (optional): the bot places a fee order at deal open. */
  feeOrder?: boolean
}

export type PreviewHedgeFundingInput = {
  exchangeUUID: string
  exchange: ExchangeEnum
  pair: string
  price: number
  legs: PreviewHedgeFundingLegInput[]
}

/**
 * `previewHedgeFunding` (main-app spec 044 §8.5) — what the two legs of a
 * hedge DCA / hedge combo on spot will do at start with the per-leg actions
 * the dialog has selected. Conservative and order-independent: the engine
 * funds the legs in whichever order they take the account's funding lock, so
 * both orders are planned and each leg reports its worse outcome
 * (`planHedgeFundingJointly`). Rule: a leg this does not refuse opens in
 * either order, if balances do not change. Every leg consumes what its own
 * orders need, funding action or not. `kind: none` = no funding trade (runs
 * on held funds, or `noAction`); `required` / `held` / `needAsset` are still
 * set for a leg that runs on held funds.
 */
export const previewHedgeFunding = async (
  user: ClearUserSchema,
  input: PreviewHedgeFundingInput,
  paperContext?: boolean,
) => {
  const legs = input.legs ?? []
  for (const leg of legs) {
    if (leg.side !== 'LONG' && leg.side !== 'SHORT') {
      return fail(`Unknown leg side ${leg.side}`)
    }
    if (!Object.values(ActionsEnum).includes(leg.action as ActionsEnum)) {
      return fail(`Unknown action ${leg.action}`)
    }
  }
  if (!(input.price > 0)) {
    return fail('Price is required')
  }
  const ctx = await loadFundingContext(user, input, paperContext)
  if (ctx.status !== StatusEnum.ok) {
    return ctx
  }
  const planned = planHedgeFundingJointly({
    legs: legs.map((leg) => {
      const isLong = leg.side === 'LONG'
      const action = leg.action as ActionsEnum
      // Engine parity (§8, item 10 / D8): combo padding on a short leg's
      // levels, and the fee order the deal places at open (sized at its
      // upper bound: the largest level is at most the sum).
      const pad =
        !isLong && leg.useDca
          ? ctx.baseStep *
            Math.max(0, +(leg.comboGridLevel ?? 0)) *
            Math.max(0, Math.floor(+(leg.safetyLevels ?? 0)))
          : 0
      const feeQty =
        leg.feeOrder && leg.useDca && action !== ActionsEnum.useOppositeBalance
          ? comboFeeOrderQty({
              feeOrder: true,
              makerFee: ctx.makerFee,
              maxLevelQty: Math.max(leg.baseOrderQty, leg.safetyQty),
              price: input.price,
              minNotional: ctx.limits.minNotional,
              minBase: ctx.limits.minBase,
              basePrecision: ctx.limits.basePrecision,
            })
          : 0
      return {
        isLong,
        action,
        baseOrderQty: leg.baseOrderQty,
        safetyQty: leg.safetyQty + pad + (isLong ? 0 : feeQty),
        safetyQuote: leg.safetyQuote + (isLong ? feeQty * input.price : 0),
        useDca: leg.useDca,
      }
    }),
    price: input.price,
    freeBase: ctx.freeBase,
    freeQuote: ctx.freeQuote,
    reservedQuote: ctx.reservedQuote,
    reservedBase: ctx.reservedBase,
    ...ctx.limits,
  })
  const assetName = (a: 'base' | 'quote') =>
    a === 'base' ? ctx.baseAsset : ctx.quoteAsset
  return {
    status: StatusEnum.ok,
    reason: null,
    data: {
      baseAsset: ctx.baseAsset,
      quoteAsset: ctx.quoteAsset,
      freeBase: ctx.freeBase,
      freeQuote: ctx.freeQuote,
      reservedQuote: ctx.reservedQuote,
      reservedBase: ctx.reservedBase,
      legs: planned.map(({ input: leg, decision }) => {
        const head = {
          side: leg.isLong ? 'LONG' : 'SHORT',
          action: leg.action,
        }
        if (decision.kind === 'none') {
          return { ...head, kind: 'none' }
        }
        if (decision.kind === 'held') {
          // No funding trade: the leg runs on held funds (or its actions
          // place none) — what its orders need is shown for the dialog.
          return {
            ...head,
            kind: 'none',
            required: decision.required,
            held: decision.held,
            needAsset: assetName(decision.needAsset),
            reservedForEntry: 0,
            message: null,
          }
        }
        if (decision.kind === 'refuse') {
          const asset = assetName(decision.asset)
          return {
            ...head,
            kind: 'refuse',
            required: decision.need.required,
            held: decision.need.held,
            needAsset: assetName(decision.need.asset),
            message: `Not enough ${asset} for this leg: required ${math.round(decision.required, 8)} ${asset}, available ${math.round(decision.available, 8)} ${asset} after what other bot-funded deals and the other leg hold (planned in either start order)`,
          }
        }
        return {
          ...head,
          kind: 'fund',
          tradeSide: decision.trade?.side ?? null,
          tradeBaseQty: decision.trade?.baseQty ?? 0,
          tradeQuote: decision.trade?.quoteValue ?? 0,
          raisedToMin: !!decision.trade?.raisedToMin,
          required: decision.required,
          held: decision.held,
          needAsset: assetName(decision.needAsset),
          reservedForEntry: leg.isLong
            ? decision.baseReserved
            : decision.quoteReserved,
          message: null,
        }
      }),
    },
  }
}
