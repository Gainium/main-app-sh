/**
 * Who holds the opposing position, and is waiting for it worth anything?
 *
 * On a one-way futures account the venue keeps ONE net position per symbol, so
 * a bot whose direction fights that position cannot start (`MainBot.loadData`,
 * "check positions"). The refusal names the direction and nothing else, which
 * sends the user to the venue to look at a position whose owner is the bot
 * pair they just flipped — or, worse, a leftover no bot is managing at all.
 *
 * The same lookup answers the other half of the question: WAITING for the
 * position to clear only helps when something is actually clearing it
 * (`settleWindowFor`). A running bot with an open deal on that side is not
 * clearing anything — it is holding the position on purpose, and a start that
 * waits a minute before refusing is a minute of silence for the same answer.
 */

/**
 * The base window is spec 041's and stays there — one definition, so the two
 * cannot drift. Re-exported for callers that want both windows from one
 * import.
 */
export { OPPOSING_POSITION_SETTLE } from './opposingPositionSettle'
import { OPPOSING_POSITION_SETTLE } from './opposingPositionSettle'

/**
 * Extension used only when the position can plausibly go flat on its own: a
 * close in flight, or a stopped bot still unwinding. ~51 s on top of the 10 s
 * above, at a slower interval — this is a wait, not a poll loop, and every
 * attempt is a venue call.
 */
export const OPPOSING_POSITION_PARK = { attempts: 17, intervalMs: 3_000 }

export type OpposingDeal = {
  /** Deal id, for the log line only. */
  dealId: string
  botId: string
  botName?: string
  /**
   * The holding bot is not running: either stopped with the position left
   * open, or stopping right now with its close in flight.
   */
  botStopped: boolean
}

export type OpposingHolder = OpposingDeal | null

/**
 * How long to wait for `symbol` to go flat before refusing.
 *
 * A running bot holding an open deal gets the base window only. It is not
 * unwinding, and the 10 s still covers the case where its close filled a
 * moment ago and the deal row has not caught up.
 */
export const settleWindowFor = (
  holder: OpposingHolder,
): { attempts: number; intervalMs: number } =>
  holder && !holder.botStopped
    ? OPPOSING_POSITION_SETTLE
    : {
        attempts:
          OPPOSING_POSITION_SETTLE.attempts + OPPOSING_POSITION_PARK.attempts,
        intervalMs: OPPOSING_POSITION_PARK.intervalMs,
      }

/**
 * The refusal text. The FIRST SENTENCE is unchanged and must stay that way:
 * `findConflictingFuturesPosition` (`server/v2/helpers.ts`) answers the
 * terminal-deal API with the same sentence, users search for it, and the
 * bot-error rules classify on it. Everything added here follows it.
 */
export function opposingPositionRefusal(params: {
  side: string
  requiredSide: string
  symbol: string
  holder: OpposingHolder
}): string {
  const { side, requiredSide, symbol, holder } = params
  const base = `Cannot start when existing position not met bot settings. Side in active position is ${side}, but bot will open ${requiredSide}. Symbol: ${symbol}`
  const named = holder?.botName ? ` "${holder.botName}"` : ''
  if (!holder) {
    return `${base}. No open deal on this account holds that ${side} position, so nothing here is going to close it — flatten it on the exchange, then start this bot.`
  }
  if (holder.botStopped) {
    return `${base}. That ${side} position belongs to an open deal on bot${named}, which is stopped — stopping a bot with "leave position open" does not close its position. Close that deal (or stop the bot with close-by-market), then start this one.`
  }
  return `${base}. That ${side} position belongs to an open deal on bot${named}, which is still running. Both bots share one net position on a one-way account, so close that deal first — this bot cannot manage a position held against its own direction.`
}
