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

/**
 * A safety order the venue refused for insufficient balance is kept by level
 * and placed again on the same back-off as a closed market, as a limit at the
 * level's own price. After this long without the venue accepting it the bot
 * stops trying and records the level as skipped. Spec 271.
 */
export const BALANCE_REFUSAL_GIVE_UP_MS = 24 * 60 * 60_000

/**
 * Has a level refused for balance since `firstAt` run out of retries at `now`?
 * Spec 271.
 */
export const balanceRefusalExpired = (firstAt: number, now: number): boolean =>
  now - firstAt >= BALANCE_REFUSAL_GIVE_UP_MS

/** What the user is told, once per pair per refusal spell. Spec 271. */
export const balanceRefusalNotice = (symbol: string): string =>
  `The exchange refused a DCA order on ${symbol} for insufficient balance. The bot will place it again at its level's price, retrying for up to 24 hours. Free up or add funds to let it through.`

/**
 * What the user is told when the bot stops retrying a level refused for
 * balance. `recorded`: the level is now on the deal's skipped DCA levels and
 * can be executed from the deal. Spec 271.
 */
export const balanceRefusalGaveUpNotice = (input: {
  symbol: string
  price: string | number
  level?: number | null
  recorded: boolean
}): string =>
  `DCA ${input.level ? `level ${input.level}` : 'order'} at ${input.price} on ${input.symbol} was refused by the exchange for insufficient balance for 24 hours, so the bot stopped retrying it. ${
    input.recorded
      ? 'It is listed under the deal\'s skipped DCA levels; you can execute it from the deal.'
      : 'It will be placed again the next time the deal\'s orders are rebuilt.'
  }`

/** What the user is told, once per pair per closed spell. */
export const marketClosedNotice = (symbol: string): string =>
  `The exchange's market for ${symbol} is closed right now, so the bot's orders for it could not be placed. The bot will place them automatically when trading reopens; there is nothing you need to do.`
