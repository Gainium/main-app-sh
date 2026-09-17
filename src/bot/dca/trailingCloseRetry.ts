/**
 * The decisions behind retrying a refused trailing TAKE PROFIT close.
 * Spec `050.a-rejected-trailing-take-profit-is-never-retried`.
 *
 * When `trailingMode: 'ttp'` fires, the engine is closing a deal that is in
 * profit, and that profit exists only while the position is still open at that
 * price. A refusal the venue owns — a lockout, a rate-limit ban, a 5xx — is
 * very likely to succeed a few seconds later, so the engine has to ask again;
 * a refusal the ORDER or the ACCOUNT owns cannot be changed by asking again.
 * Telling those two apart, budgeting the retries, and deciding when a trail
 * that gave up may arm again are the four decisions in this file.
 *
 * All pure, and deliberately so:
 *
 *  - the classification IS the behaviour. This repo has twice shipped a venue
 *    wording list that was silently missing the venue it mattered for (see the
 *    Kraken / Hyperliquid note on `notEnoughErrors` in `bot/main.ts`), and the
 *    only defence is a test that can enumerate the cases.
 *  - the re-arm rule is a crossing, not a comparison, and the difference is
 *    invisible at a glance — exactly the kind of thing that gets "simplified"
 *    back into being wrong.
 *
 * It owns its own wording lists rather than importing `notEnoughErrors`,
 * `notionalReasons` or `authGuard`'s signatures. Two of those live in
 * `bot/main.ts` and `bot/dcaHelper.ts`, which sit downstream of this module, so
 * the import would be circular; `authGuard` has no cycle but does pull the
 * Redis client in, and this module is meant to stay loadable with nothing
 * behind it. `trailingCloseRetry.spec.ts` pins the cross-list invariant
 * instead — a test can import every side at once, and does: it asserts that
 * every `notEnoughErrors` entry and every `AUTH_FAILURE_SIGNATURES` entry
 * classifies non-retryable, and that every `VENUE_LOCKOUT_SIGNATURES` entry
 * classifies retryable.
 */
import type { TrailingCloseRetry } from '../../../types'

/**
 * The wait before each retry, in order. Progressive from 30s to 1m for the
 * reason `RetryBackoff` documents: the first re-probe should be quick, because
 * most of these clear in seconds, while a condition still there after four
 * attempts should not be asked at the same rate — a Kraken lockout in
 * particular is EXTENDED by every attempt made during it.
 *
 * Five entries, so a trailing close gets one initial attempt plus five
 * retries: ~3.9 minutes of total exposure. Past that the price the close was
 * decided on is gone, and the honest answer is to stop and tell the user
 * rather than keep an unbounded loop attached to a stale decision.
 */
export const TRAILING_TP_RETRY_DELAYS_MS = [
  30_000, 37_500, 45_000, 52_500, 60_000,
]

export const TRAILING_TP_MAX_RETRIES = TRAILING_TP_RETRY_DELAYS_MS.length

/**
 * How long past its deadline a `retrying` record still counts as pending.
 *
 * The record suppresses the live close paths (nothing else may close a deal
 * mid-retry), so it must be SELF-RELEASING — the defect spec 049 §6.1 named in
 * the in-memory `closeBySl` was exactly a close-in-flight flag that was never
 * released. A worker that dies between persisting the record and making the
 * attempt, or a re-entered close that returns down a path which never reaches
 * the refusal site, would otherwise leave the deal unmanaged for good.
 *
 * Generous on purpose: it only has to outlast one close attempt, and releasing
 * early would let a live tick close a deal that is mid-attempt.
 */
export const TRAILING_RETRY_STALE_MS = 5 * 60 * 1000

const lower = (s: string) => s.toLowerCase()

/**
 * Refusals caused by the ORDER: its size, its price, its precision. Asking
 * again with the same order cannot change the answer.
 */
const ORDER_SCOPED_REJECTIONS = [
  // Notional / minimum size. `closeDealById`'s own slippage ladder owns these
  // and terminates them by booking the deal closed; listed so the two can
  // never disagree.
  'the order funds should be more than',
  'notional',
  'must have minimum value of',
  'amount is lower than min allowed',
  'order quantity exceeded',
  // Price, precision, lot size, filters.
  'too many decimals',
  'lot_size',
  'price_filter',
  'filter failure',
  'out of permissible range',
  'not within the price limit',
  'price limit',
  'order price cannot be',
  'invalid quantity',
  'invalid price',
  'invalid amount',
  'egeneral:invalid arguments',
  'eorder:invalid price',
  'eorder:invalid volume',
]

/**
 * Refusals caused by the ACCOUNT: it cannot fund the order, it is not allowed
 * to trade, its credential is dead, or the order is a duplicate of one the
 * venue already has. Only the user (or a different order size) can resolve
 * these, so a retry is pure noise — and for a dead credential it is worse than
 * noise: sequential attempts are what Kraken answers with a lockout.
 */
const ACCOUNT_SCOPED_REJECTIONS = [
  // Funding. Kept in step with `notEnoughErrors` by the spec file's cross-list
  // assertion rather than by an import (see the module note above).
  'balance',
  'insufficient',
  'not enough',
  'margin is insufficient',
  'insufficientab',
  'the purchase amount of each order exceeds',
  'the sell quantity per order exceeds',
  // Permissions / jurisdiction.
  'restricted',
  'not allowed',
  'permission',
  'eaccount:invalid permissions',
  // Binance's Quantitative Rules (-4400). Not merely pointless to retry but
  // actively harmful: every order sent during a restriction feeds the
  // unfilled-ratio that caused it, which is why `QuantRulesGuard` DELAYS
  // orders rather than failing them.
  'quantitative rules',
  // Duplicates — the venue already holds this order; a retry cannot be sent.
  'duplicate order',
  'duplicate client order',
  'client order id already exists',
  'clientorderidalreadyexist',
  // Reduce-only / flat position. `closeDealById` returns on these before the
  // refusal site, but the classifier must not disagree with that.
  'reduceonly order is rejected',
  'reduce only order would increase position',
  'reduce-only order',
  'current position is zero',
  "you don't have any positions",
  'position does not exist',
  'no position to close',
  'wouldnotreduceposition',
  // Credentials. Every wording in `authGuard`'s AUTH_FAILURE_SIGNATURES
  // contains one of these five, and the spec file asserts that. Deliberately
  // NOT a bare 'api': Kraken's neighbouring `EAPI:Invalid nonce` and
  // `EAPI:Invalid signature` are genuinely transient and must stay retryable,
  // which is the same line `authGuard` itself draws — hence its dead-key
  // wording being listed here venue-prefixed and in full, as it is there.
  'api key',
  'api-key',
  'apikey',
  'api-passphrase',
  'eapi:invalid key',
]

/**
 * Refusals whose OUTCOME IS UNKNOWN: the request may have reached the matching
 * engine and been accepted, with the answer lost on the way back. A retry
 * there is a second market order onto a position that may already be flat, so
 * these keep today's behaviour (disarm, per spec 049) — spec §4.2, §7.1.
 *
 * Note this is why `isRetryableTrailingCloseRejection` cannot simply be "not
 * order-scoped and not account-scoped": the third class is neither, and it is
 * the only one where a wrong retry can move money.
 */
const AMBIGUOUS_OUTCOME_REJECTIONS = [
  'socket hang up',
  'econnreset',
  'etimedout',
  'esockettimedout',
  'timeout',
  'timed out',
  'status code 408',
  'fetch failed',
  'unexpected end of json input',
  'aborted',
]

/**
 * Whether a refused trailing take-profit close should be retried (spec §4.1).
 *
 * A DENYLIST, not an allowlist: anything not recognised as owned by the order,
 * the account, or an unknown outcome is retried. The asymmetry is deliberate —
 * a wrongly retried permanent refusal costs six bounded attempts over four
 * minutes and then reports to the user, while a wrongly un-retried transient
 * one costs the user a realised profit and, on a bot with no stop loss, leaves
 * the deal open indefinitely.
 *
 * An empty reason is not retried: there is no evidence of anything.
 */
export const isRetryableTrailingCloseRejection = (
  reason?: string | null,
): boolean => {
  if (!reason || !`${reason}`.trim()) {
    return false
  }
  const r = lower(`${reason}`)
  return ![
    ...ORDER_SCOPED_REJECTIONS,
    ...ACCOUNT_SCOPED_REJECTIONS,
    ...AMBIGUOUS_OUTCOME_REJECTIONS,
  ].some((s) => r.includes(lower(s)))
}

/**
 * The wait before the next retry, given how many attempts have already been
 * refused (the initial one counts as 1). `null` once the budget is spent.
 */
export const nextTrailingRetryDelay = (attempts: number): number | null =>
  TRAILING_TP_RETRY_DELAYS_MS[attempts - 1] ?? null

/**
 * The record a fresh refusal produces — `retrying` with a deadline while the
 * budget lasts, `paused` once it is spent.
 *
 * `since` is carried, not reset: it is the start of THIS run of refusals, and
 * the user-facing message counts from it.
 */
export const trailingRetryStateAfterRefusal = (
  prev: TrailingCloseRetry | undefined,
  reason: string,
  now: number,
): TrailingCloseRetry => {
  const attempts = (prev?.attempts ?? 0) + 1
  const delay = nextTrailingRetryDelay(attempts)
  const base = {
    attempts,
    since: prev?.since ?? now,
    lastAttempt: now,
    reason,
  }
  return delay === null
    ? { ...base, status: 'paused', rearmReady: false }
    : { ...base, status: 'retrying', nextAttempt: now + delay }
}

/**
 * Is a retry genuinely outstanding for this deal (spec §6.11)?
 *
 * The only thing that may suppress the live close paths. A `paused` record
 * must NOT: a paused trail is disarmed, and the deal goes back to being
 * managed by everything else (stop loss, manual close, its resting take
 * profit). Nor may a record whose deadline is long past with nothing having
 * happened — see {@link TRAILING_RETRY_STALE_MS}.
 */
export const isTrailingRetryPending = (
  state: TrailingCloseRetry | undefined | null,
  now: number,
): boolean => {
  if (!state || state.status !== 'retrying') {
    return false
  }
  const due = Number(state.nextAttempt)
  if (!Number.isFinite(due)) {
    return false
  }
  return now <= due + TRAILING_RETRY_STALE_MS
}

/**
 * May `checkTrailing` arm a trailing take profit right now, and has the
 * re-arming crossing been earned (spec §5.2, §6.8)?
 *
 * While the trail is paused, "price is above the arming line" is the wrong
 * test: it is a STATE, and it is true on the very first tick after a refusal —
 * so arming on it would spend another five retries every four minutes for as
 * long as the venue condition lasts, which for a Kraken lockout also sustains
 * its own cause (every attempt restarts the window). What is needed is an
 * EVENT: a tick observed on the far side of the line, and then the tick that
 * crosses back.
 *
 * This is the `moveSlArmed` idiom already in the engine, for the same reason.
 *
 * An unknown line (`getTrailingSettings` answers 0 when it did not compute
 * one) permits nothing and earns nothing: a missing reference is not evidence
 * of a crossing in either direction. An already-earned crossing survives it.
 */
export const trailingTpArmingPermitted = (
  state: TrailingCloseRetry | undefined | null,
  last: number,
  armingLine: number,
  isLong: boolean,
): { permitted: boolean; rearmReady: boolean } => {
  if (!state || state.status !== 'paused') {
    return { permitted: true, rearmReady: false }
  }
  const earned = !!state.rearmReady
  if (!Number.isFinite(armingLine) || armingLine <= 0) {
    return { permitted: false, rearmReady: earned }
  }
  const onArmingSide = isLong ? last >= armingLine : last <= armingLine
  if (!earned) {
    return { permitted: false, rearmReady: !onArmingSide }
  }
  return { permitted: onArmingSide, rearmReady: true }
}

/**
 * Spec 049's floor: is a close at `last` still a profit after the round-trip
 * taker fee?
 *
 * Extracted from `checkDealsStopLoss`, where it was inline, because the retry
 * path (spec §4.4) is now a second caller — a retry four minutes later must
 * not smuggle past the floor the close it is retrying was allowed by. The two
 * callers must not be able to disagree about what "profitable" means.
 *
 * Same net-return shape as `checkMinTp`, which cannot cover this: that one is
 * gated on `useMinTP` and a techInd/webhook close condition.
 */
export const closeIsAboveBreakEven = (input: {
  last: number
  avg: number
  taker: number
  isLong: boolean
}): boolean => {
  const { last, avg, taker, isLong } = input
  if (!Number.isFinite(last) || !Number.isFinite(avg) || avg <= 0) {
    return false
  }
  const diff = isLong ? last - avg : avg - last
  return diff / avg - (Number.isFinite(taker) ? taker : 0.001) * 2 > 0
}

/**
 * Bot-message text for a trailing take profit that could not be executed.
 *
 * Says three things the user needs and cannot get anywhere else: the exit was
 * attempted and failed, the deal is STILL OPEN, and the trail will not try
 * again until price returns to the take-profit level — so this deal is theirs
 * to manage now.
 *
 * Avoids the phrase "was left open on the exchange": `errorDict` maps that to
 * the `Position left open` subType, which is a different condition.
 */
export const trailingCloseFailedMessage = (
  dealId: string,
  symbol: string,
  reason: string,
  attempts: number,
): string =>
  `Trailing take profit for deal ${dealId} on ${symbol} could not be executed - the exchange refused the closing order ${attempts} time(s) (last reason: ${reason}). The deal is still open and its trailing take profit is paused until the price returns to the take profit level, so please manage this deal yourself and check the position on the exchange.`
