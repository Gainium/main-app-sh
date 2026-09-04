/**
 * What a market take-profit close attempt actually did, and whether trying
 * again can change it. Spec `specs/004.tp-level-close-terminal-rejection.md`.
 *
 * `checkTPLevel` fires on every price tick that has reached a take-profit
 * level. When the close comes back without leaving anything in flight it
 * releases `closeByTp` and re-arms, so the *next* tick tries again — the #617
 * fix, and correct for a transient miss.
 *
 * It is not correct for a refusal that states the position is not there
 * (`Reduce order is rejected`, `ReduceOnly Order`, `current position is zero…`
 * — the `Futures position` subType). Re-sending the identical order cannot
 * change that answer, and the price tick is throttled only to 2/s per symbol:
 * production ran one order id 1031 times in ~2 h against one deal that had
 * been open since April, and told the user nothing, because `Futures position`
 * is configured `showUser: false`.
 *
 * Pure on purpose. The decision is three lines of judgement buried in ~60
 * lines of I/O, and it is the judgement that was wrong.
 */
import { futuresPosition } from '../utils'

/** The three shapes `sendGridToExchange(…, returnError)` can come back as. */
export type TpCloseAttempt =
  /** The venue took the order (or echoed one it already had). */
  | {
      kind: 'order'
      status: string
      /**
       * The venue echoed a FILLED target this deal has already booked.
       * `processFilledOrder` short-circuits it, so nothing is in flight.
       */
      alreadyProcessed: boolean
    }
  /** The venue refused, in its own words. */
  | { kind: 'refused'; reason: string }
  /** Nothing was sent — no exchange info, or the order could not be prepared. */
  | { kind: 'nothing' }

export type TpCloseDecision = {
  /** A close is in flight; `closeByTp` stays set and the fill paths clear it. */
  inFlight: boolean
  /** Caller must book this fill (`processFilledOrder`). */
  bookFill: boolean
  /** Short text for the log line — the venue's own words when it refused. */
  outcome: string
  /** Trying again cannot change this answer; back off instead of re-arming. */
  terminal: boolean
}

/**
 * @param subTypeOf the engine's error classifier (`getErrorSubType`), injected
 *   so this module stays free of the DB-backed rules cache behind it.
 */
export const classifyTpCloseAttempt = (
  attempt: TpCloseAttempt,
  subTypeOf: (reason: string) => string,
): TpCloseDecision => {
  if (attempt.kind === 'nothing') {
    // No venue answer at all — no exchange info, or the order could not be
    // prepared. Both are local and may well be gone on the next tick, so this
    // keeps the #617 immediate re-arm.
    return {
      inFlight: false,
      bookFill: false,
      outcome: 'not placed',
      terminal: false,
    }
  }
  if (attempt.kind === 'refused') {
    return {
      inFlight: false,
      bookFill: false,
      outcome: `refused by the exchange: ${attempt.reason}`,
      // The venue is not describing a moment, it is describing the position:
      // there is nothing to reduce. Re-sending the identical reduce-only order
      // returns the identical answer, for as long as the divergence lasts.
      terminal: subTypeOf(attempt.reason) === futuresPosition,
    }
  }
  if (attempt.status === 'FILLED') {
    return attempt.alreadyProcessed
      ? {
          inFlight: false,
          bookFill: false,
          outcome: 'already processed',
          terminal: false,
        }
      : { inFlight: true, bookFill: true, outcome: 'FILLED', terminal: false }
  }
  const open =
    attempt.status === 'NEW' || attempt.status === 'PARTIALLY_FILLED'
  return {
    inFlight: open,
    bookFill: false,
    outcome: attempt.status,
    terminal: false,
  }
}

/**
 * The deal-scoped message for a take-profit the venue will not accept.
 *
 * This is the only thing the user ever gets: `Futures position` is configured
 * `showUser: false, errorsBot: false` in `boterrorsubtypes`, deliberately —
 * as a bot-level condition it IS benign. On a deal whose take-profit has just
 * failed to execute it is not, and the bell names neither deal nor symbol.
 */
export const tpCloseBlockedMessage = ({
  dealId,
  symbol,
  reason,
  retryAfter,
}: {
  dealId: string
  symbol: string
  reason: string
  retryAfter: number
}): string =>
  `Take profit for deal ${dealId} (${symbol}) was reached, but the exchange refused the closing order: "${reason}". ` +
  `This usually means the exchange no longer holds the position this deal is tracking. ` +
  `The bot will try again after ${new Date(retryAfter).toISOString()} instead of retrying on every price update. ` +
  `Check the position on the exchange - if it is gone, close this deal manually.`
