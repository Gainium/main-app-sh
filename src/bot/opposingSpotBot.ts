/**
 * Spec 305. Two spot DCA/combo bots of one user that trade OPPOSITE directions
 * on the same pair of the same exchange account share one wallet balance of the
 * base coin with no reservation: the SHORT's sells spend or lock coins the
 * LONG's deal still counts as its own (and the LONG's buys refill what the
 * SHORT owes), so either bot may be unable to close its deal in full.
 *
 * Nothing here blocks, refuses or resizes anything. It only decides which
 * pairs to WARN about when a bot starts or is saved, and what to say. Pure, so
 * the decision is testable without a database; the reads live in
 * `dcaHelper.warnOpposingSpotBots`.
 */
import { StrategyEnum } from '../../types'

/**
 * Per-pair bot-message subType (registered in `DEFAULT_PER_SYMBOL_SUBTYPES`,
 * where it is spelled rather than imported) so a multi-pair bot owns one row
 * per affected pair, not one row naming whichever pair was reported last.
 */
export const opposingSpotBotSubType = 'Opposite-direction bot on the same coins'

/** Another bot of the user, on this account, trading the opposite direction. */
export type OpposingSpotBot = {
  botId: string
  name?: string
  pairs: string[]
  /** Running (open/range/error/monitoring) at the time of the read. */
  running: boolean
}

/** An open deal of the opposite direction on another bot of this account. */
export type OpposingSpotDeal = {
  botId: string
  symbol: string
}

/**
 * The pairs of `pairs` that another bot (`bots`, already filtered to this
 * user, account, opposite direction, not deleted) either runs on or holds an
 * open opposite-direction deal on (`deals`), with the bots responsible. Order
 * follows `pairs`; each pair at most once.
 */
export function opposingSpotPairs(
  pairs: string[],
  bots: OpposingSpotBot[],
  deals: OpposingSpotDeal[],
): { symbol: string; bots: { name?: string; openDeal: boolean }[] }[] {
  const byId = new Map(bots.map((b) => [b.botId, b]))
  const out: { symbol: string; bots: { name?: string; openDeal: boolean }[] }[] =
    []
  for (const symbol of [...new Set(pairs)]) {
    const holders = new Map<string, { name?: string; openDeal: boolean }>()
    for (const d of deals) {
      if (d.symbol !== symbol || !byId.has(d.botId)) {
        continue
      }
      holders.set(d.botId, { name: byId.get(d.botId)?.name, openDeal: true })
    }
    for (const b of bots) {
      if (!b.running || holders.has(b.botId) || !b.pairs.includes(symbol)) {
        continue
      }
      holders.set(b.botId, { name: b.name, openDeal: false })
    }
    if (holders.size) {
      out.push({ symbol, bots: [...holders.values()] })
    }
  }
  return out
}

/** The user-facing warning for one pair. */
export function opposingSpotBotWarning(params: {
  symbol: string
  strategy: StrategyEnum
  bots: { name?: string; openDeal: boolean }[]
}): string {
  const { symbol, strategy, bots } = params
  const other = strategy === StrategyEnum.long ? 'SHORT' : 'LONG'
  const names = bots
    .map(
      (b) =>
        `${b.name ? `"${b.name}"` : 'another bot'}${
          b.openDeal ? ' (open deal)' : ''
        }`,
    )
    .join(', ')
  return `${symbol}: a ${other} spot bot on this exchange account trades the same pair: ${names}. Both bots buy and sell the same coins from one wallet balance, so either bot may be unable to close its deal in full. This bot keeps running; run opposite directions on separate accounts or sub-accounts to avoid it.`
}
