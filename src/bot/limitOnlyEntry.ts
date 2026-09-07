import { OrderTypeEnum } from '../../types'

/**
 * Venues word the same condition as prose or as a camelCase/hyphenated code
 * ("no position to close" vs "wouldNotReducePosition", "limit only mode" vs
 * "limit-only"), so compare on letters and digits only — one list entry then
 * covers every spelling.
 */
export const normalizeReason = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Exchange rejections that mean "this book is only accepting LIMIT orders right
 * now". Coinbase puts a product into limit-only mode during a volatility
 * auction; a MARKET order can never be accepted while that holds, but a LIMIT
 * one still can. So this is not a fatal entry error — the base order must fall
 * BACK to limit rather than be abandoned.
 *
 * Kept deliberately narrow: post-only rejections ("order would immediately
 * match and take") are a *limit* order being refused and must NOT match here,
 * or the limit fallback would loop.
 */
export const limitOnlyReasons = [
  // Coinbase Advanced Trade — observed verbatim as
  // "Orderbook is in limit only mode - please use limit order type".
  // Matched via normalizeReason, so "limit-only" spells the same.
  'limit only',
]

export function isLimitOnlyReason(text: string): boolean {
  const haystack = normalizeReason(text)
  return limitOnlyReasons.some(
    (r) => haystack.indexOf(normalizeReason(r)) !== -1,
  )
}

/**
 * Whether a refused base order should be re-sent as a LIMIT instead of being
 * abandoned.
 *
 * The refusal means the venue is in limit-only mode, so no number of retries
 * of the same MARKET order can ever be accepted — and by the time we get here
 * the deal may have had its resting limit base order cancelled to make room for
 * that market entry, which leaves it in `start` with nothing on the book at
 * all. That is Claus #505.
 *
 * Two things decide it, and neither is the bot's configured entry type:
 *
 * - `sentType` — what we actually put on the wire. Only a MARKET send can be
 *   refused for being a market order; a LIMIT send that came back refused was
 *   refused for some other reason and must fall through to the generic handler.
 * - `forceLimit` — set on the one re-send this predicate authorises. It is the
 *   termination guard: the re-send is a LIMIT, so `sentType` alone would
 *   already stop a second round, and this makes that explicit rather than
 *   implied.
 *
 * Note what is deliberately NOT consulted: the bot's `startOrderType`. An
 * earlier version of this required a LIMIT-entry bot, on the reasoning that
 * re-placing without `forceMarket` only actually produces a LIMIT when the bot
 * is configured for limit entry — true, but it left a MARKET-entry bot (whose
 * very first base order is a market order) with no order on the book at all,
 * which is the exact symptom #505 is about. Re-placing with an explicit
 * `forceLimit` covers both and still terminates.
 */
export function shouldFallBackToLimitEntry(args: {
  sentType: OrderTypeEnum | string | undefined
  forceLimit: boolean
  reason: string
}): boolean {
  const { sentType, forceLimit, reason } = args
  if (forceLimit) {
    return false
  }
  if (sentType !== OrderTypeEnum.market) {
    return false
  }
  return isLimitOnlyReason(reason)
}
