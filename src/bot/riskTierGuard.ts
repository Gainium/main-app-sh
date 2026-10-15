import RetryBackoff from './retryBackoff'
import { riskTierLimit } from './utils'

/**
 * Risk-tier refusal cooldown for safety orders.
 *
 * Bybit (and other derivatives venues) refuse an order that would push the
 * account's position plus resting orders on a contract over its current risk
 * tier:
 *   `The combined value of positions and orders has reached the limit of the
 *   current risk tier. Only reduce-only or close-on-trigger orders are allowed.
 *   Please adjust your leverage to 4.7 or below to increase the limit.`
 * (classified as the `Risk tier limit` subType by the `current risk tier`
 * pattern.)
 *
 * The refusal is about SIZE, not the symbol: a combo deal's small minigrid
 * orders keep being accepted while its large safety order is refused. And it
 * does not change on its own in the next few seconds — only when the position
 * shrinks, the user lowers leverage or raises the tier. But nothing gated the
 * next attempt: the refused order's row is dropped, so every ladder rebuild (on
 * a combo, every minigrid fill) found the level missing and sent it again. A
 * volatile pair produced a refusal — and a bot error — every second or two.
 *
 * So the cooldown is keyed on the LEVEL, not the account or the symbol: bot,
 * deal, symbol, side, price and the bot's leverage. Other orders on the same
 * contract, including the minigrid, are never held back by it; a new deal or
 * a leverage change is a different key and goes straight to the venue.
 *
 * Exponential like its siblings: a tier that frees up as the position is
 * reduced is re-probed after `minMs`; one that never does settles at one
 * attempt per `maxMs`. Shorter than the compliance / balance windows because
 * the condition is routinely transient (a take-profit or a minigrid sell
 * shrinks the position) and a safety order placed late is a real cost.
 */

const backoff = new RetryBackoff({
  namespace: 'rt',
  minMs: 60 * 1000,
  maxMs: 15 * 60 * 1000,
})

export type RiskTierLevel = {
  botId: string
  dealId?: string
  symbol: string
  side: string
  price: string | number
  leverage?: number
}

export type RiskTierCheckResult = {
  restricted: boolean
  /** The exchange's own rejection text, replayed verbatim. */
  reason: string | null
  /** Cooldown expiry (ms epoch), or null when not restricted. */
  until: number | null
  attempt: number
}

/**
 * Does this refusal mean "the risk tier is full"? Subtype first (DB rules can
 * be retuned without a deploy), raw text as the fallback for installs whose
 * rules cache has not loaded or has no such rule.
 */
export const isRiskTierRefusal = (reason: string, subType?: string) =>
  subType === riskTierLimit ||
  `${reason ?? ''}`.toLowerCase().indexOf('current risk tier') !== -1

const keyOf = (level: RiskTierLevel) => [
  level.botId,
  `${level.dealId ?? ''}`,
  level.symbol,
  level.side,
  `${+level.price}`,
  `${level.leverage ?? ''}`,
]

export class RiskTierGuard {
  /**
   * Remember a fresh risk-tier refusal of this level. Call ONLY for refusals
   * that came back from the venue, so a suppressed attempt can never slide the
   * window forward.
   */
  static async record(level: RiskTierLevel, reason: string): Promise<number> {
    const state = await backoff.record(keyOf(level), reason)
    return state.until
  }

  /**
   * Is this level inside a risk-tier cooldown? Fail-open: on any Redis error the
   * order goes to the exchange.
   */
  static async check(level: RiskTierLevel): Promise<RiskTierCheckResult> {
    const res = await backoff.check(keyOf(level))
    return {
      restricted: res.suppressed,
      reason: res.reason,
      until: res.until,
      attempt: res.attempt,
    }
  }

  /** Drop a cooldown — the venue has accepted this level. */
  static async clear(level: RiskTierLevel): Promise<void> {
    return backoff.clear(keyOf(level))
  }
}

export default RiskTierGuard
