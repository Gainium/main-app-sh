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
  BaseFundingEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'
import { MathHelper } from '../../utils/math'
import { planFunding, planShortSpotDealFunding } from '../../bot/baseFunding'
import { FundingReservation } from '../../bot/fundingReservation'
import { getBalances } from './balance.handler'

import type { ClearUserSchema, ExchangeEnum } from '../../../types'

const math = new MathHelper()

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
  status: StatusEnum.notok,
  reason,
  data: null,
})

export const previewFunding = async (
  user: ClearUserSchema,
  input: PreviewFundingInput,
  paperContext?: boolean,
) => {
  const userId = user._id.toString()
  if (!user.exchanges.some((e) => e.uuid === input.exchangeUUID)) {
    return fail('Exchange not found')
  }
  if (!Object.values(BaseFundingEnum).includes(input.mode)) {
    return fail(`Unknown funding mode ${input.mode}`)
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
  const reservedQuote = await FundingReservation.getInstance().reservedQuote(
    input.exchangeUUID,
    quoteAsset.name,
  )
  const basePrecision = math.getPricePrecision(`${baseAsset.step}`)
  const limits = {
    feeRate,
    minNotional: quoteAsset.minAmount,
    minBase: baseAsset.minAmount,
    basePrecision,
  }
  const common = {
    baseAsset: baseAsset.name,
    quoteAsset: quoteAsset.name,
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
      held: input.mode === BaseFundingEnum.auto ? freeBase : 0,
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
