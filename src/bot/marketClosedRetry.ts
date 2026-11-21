/**
 * Orders refused because the venue's market for the pair is closed.
 *
 * Some venues only trade a pair during set hours: Bitget's stock tokens close
 * outside their sessions, at weekends and on US holidays, and refuse every
 * order meanwhile. Such a refusal is not about the order, so writing it off
 * leaves the deal without it until someone restarts the bot, and a restart
 * during the closed spell meets the same refusal. The engine instead keeps the
 * order by level and places it again later, backing off while the market
 * stays closed, and tells the user once per pair per closed spell.
 */

/** First retry after a closed-market refusal. */
export const MARKET_CLOSED_RETRY_MIN_MS = 5 * 60_000

/** Longest wait between retries while the market stays closed. */
export const MARKET_CLOSED_RETRY_MAX_MS = 60 * 60_000

/**
 * A refusal this long after the previous one starts a new closed spell: the
 * retry delay starts over and the user is told again.
 */
export const MARKET_CLOSED_SPELL_GAP_MS = 3 * MARKET_CLOSED_RETRY_MAX_MS

/** Delay before retry number `attempt` (0 = the first refusal). */
export const marketClosedRetryDelay = (attempt: number): number =>
  Math.min(
    MARKET_CLOSED_RETRY_MAX_MS,
    MARKET_CLOSED_RETRY_MIN_MS * 2 ** Math.max(0, Math.floor(attempt)),
  )

type LevelOrder = {
  dealId?: string | null
  typeOrder?: string
  side?: string
  origPrice?: string | number
  price?: string | number
  dcaLevel?: number | null
}

/**
 * The level an order stands for. Each attempt carries a fresh client order id,
 * so retries are tracked by level, not by id.
 */
export const marketClosedLevelKey = (order: LevelOrder): string =>
  [
    order.dealId ?? '',
    order.typeOrder ?? '',
    order.side ?? '',
    Number(order.origPrice) || Number(order.price) || 0,
    order.dcaLevel ?? '',
  ].join('|')

/** What the user is told, once per pair per closed spell. */
export const marketClosedNotice = (symbol: string): string =>
  `The exchange's market for ${symbol} is closed right now, so the bot's orders for it could not be placed. The bot will place them automatically when trading reopens; there is nothing you need to do.`
