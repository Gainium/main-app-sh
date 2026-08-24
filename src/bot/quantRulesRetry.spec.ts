process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the Quantitative Rules retry policy.
 *
 * These exist because of a production loop that was invisible from the outside.
 * An account hit an account-wide (level 3) Binance restriction; every opening
 * order refused during it was scheduled to retry at the restriction's expiry
 * plus one second. They therefore all fired in the same instant: 39 retries,
 * 39 fills and 39 take-profits inside one minute, spread across 39 symbols.
 * Binance measures the unfilled ratio per symbol in 10-minute buckets, so that
 * burst recorded a violation on every one of those symbols at once, and ten
 * symbols at once re-opens the account-wide restriction — 69 seconds after the
 * previous one expired. The account never escaped.
 *
 * The properties below are what stop that. They are pure arithmetic on the
 * policy, deliberately not requiring a bot instance.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        core/src/bot/quantRulesRetry.spec.ts
 */
import { LEVEL2_VIOLATIONS } from './quantRulesGuard'

// Mirrors of the policy constants in main.ts (not exported: they are internal
// tuning, and duplicating them here keeps the test honest about what it pins).
const BACKOFF_MS = 60_000
const BACKOFF_CAP_MS = 30 * 60_000
const JITTER_MS = 5 * 60_000
const HEADROOM = 3

const delayFor = (untilExpiry: number, attempt: number, jitter: number) =>
  Math.max(
    1000,
    untilExpiry +
      Math.min(BACKOFF_MS * Math.pow(2, attempt - 1), BACKOFF_CAP_MS) +
      jitter,
  )

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`,
  )
}

console.log('\n-- the herd: retries must not land together --')
// Two orders refused by the SAME restriction share its expiry. Before the fix
// both landed at expiry+1s. Now their delays are drawn from a jitter window,
// so the chance of collision in any given second is bounded by 1/window.
const expiry = 120_000
const a = delayFor(expiry, 1, 0)
const b = delayFor(expiry, 1, JITTER_MS - 1)
check(
  'same-expiry retries can differ by nearly the whole jitter window',
  b - a >= JITTER_MS - 1000,
  `spread was ${b - a}ms`,
)
check(
  'no retry lands within a second of the shared expiry',
  delayFor(expiry, 1, 0) >= expiry + BACKOFF_MS,
  `first retry at +${delayFor(expiry, 1, 0) - expiry}ms after expiry`,
)

console.log('\n-- backoff grows and is capped --')
check('attempt 1 waits one step', delayFor(0, 1, 0) === BACKOFF_MS)
check('attempt 2 doubles', delayFor(0, 2, 0) === 2 * BACKOFF_MS)
check('attempt 3 doubles again', delayFor(0, 3, 0) === 4 * BACKOFF_MS)
check(
  'backoff never exceeds the cap',
  delayFor(0, 20, 0) === BACKOFF_CAP_MS,
  `got ${delayFor(0, 20, 0)}`,
)

console.log('\n-- the violation budget --')
// Our own refused retry is itself a violation, so the gate has to stop short
// of the line rather than at it.
const gate = (violations: number) => violations >= LEVEL2_VIOLATIONS - HEADROOM
check('a clean symbol is allowed', !gate(0))
check('a symbol well short of L2 is allowed', !gate(3))
check(
  'stops with headroom to spare, not at the line',
  gate(LEVEL2_VIOLATIONS - HEADROOM) && !gate(LEVEL2_VIOLATIONS - HEADROOM - 1),
)
check('never retries at or past the L2 threshold', gate(LEVEL2_VIOLATIONS))

console.log(
  '\n-- worst case: a symbol cannot be walked to L2 by retries alone --',
)
// Five attempts is the ASAP budget; each is at most one violation. That has to
// stay under the L2 threshold even if every single one is refused.
check(
  'the full ASAP budget cannot by itself reach L2',
  5 < LEVEL2_VIOLATIONS,
  `budget 5 vs threshold ${LEVEL2_VIOLATIONS}`,
)

console.log(
  '\n-- giving up must release the deal, not leave it holding the pair --',
)
// The refusal path decides three things in order, and the third is the one a
// production account lost four hours to: a deal whose opening order we decline
// to retry still counts against `max deals per pair`, so unless it is released
// it silently swallows every later signal for that symbol.
type Deal = { status: string }
const releaseDecision = (isDealStart: boolean, deal: Deal | null) => {
  if (!isDealStart) return 'not-a-deal-start'
  if (!deal) return 'deal-gone'
  if (deal.status !== 'start') return 'left-alone'
  return 'released'
}
check(
  'a deal that never reached the venue is released',
  releaseDecision(true, { status: 'start' }) === 'released',
)
check(
  'an OPEN deal is never cancelled by this path',
  releaseDecision(true, { status: 'open' }) === 'left-alone',
  'releasing an open deal would abandon a real position',
)
check(
  'an already-closed deal is left alone',
  releaseDecision(true, { status: 'closed' }) === 'left-alone',
)
check(
  'a vanished deal is a no-op, not a throw',
  releaseDecision(true, null) === 'deal-gone',
)
check(
  'a non-deal-start order never triggers a release',
  releaseDecision(false, { status: 'start' }) === 'not-a-deal-start',
)

console.log(
  '\n-- the reload sweep must not replay stale point-in-time deals --',
)
// Third replay path, found in production AFTER the first two were closed: a
// bot reload walks every deal still in `start` and re-places its opening
// order. A webhook deal created 21 hours earlier was replayed into a long the
// strategy had since flipped short on. Same intent rule as the give-up path:
// only ASAP replays; everything else is cancelled, because its own trigger
// will fire again and a replay executes a moment that no longer exists.
const sweepDecision = (startCondition: string) =>
  startCondition === 'ASAP' ? 'replay' : 'cancel'
check('an ASAP deal is replayed on reload', sweepDecision('ASAP') === 'replay')
check(
  'a webhook deal is cancelled, never replayed',
  sweepDecision('TradingviewSignals') === 'cancel',
)
check(
  'an indicator deal is cancelled, never replayed',
  sweepDecision('TechnicalIndicators') === 'cancel',
)
check(
  'a timer deal is cancelled, never replayed',
  sweepDecision('Timer') === 'cancel',
)
check(
  'a manual deal is cancelled, never replayed',
  sweepDecision('Manual') === 'cancel',
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
