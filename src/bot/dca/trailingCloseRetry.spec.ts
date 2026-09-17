process.env.NODE_ENV = 'testing'

/**
 * Unit tests for the decisions behind the trailing-take-profit close retry.
 * Spec: `specs/050.a-rejected-trailing-take-profit-is-never-retried.md`.
 *
 * Three decisions live here, all pure, because all three are the kind of thing
 * that gets quietly "tidied" into being wrong:
 *
 *  - **which refusals are retried** (spec §4.1). The list IS the behaviour, and
 *    it is a DENYLIST: anything not recognised as caused by the order or the
 *    account is retried. A venue wording drifting into the denylist silently
 *    turns the retry off for that venue; a denylist entry going missing turns
 *    six pointless attempts on.
 *  - **the budget and the waits** (spec §4.3): one attempt plus five retries,
 *    30s → 1m.
 *  - **when a paused trail may re-arm** (spec §5.2): a real crossing of the
 *    arming line, never the price merely sitting on the profitable side of it.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  TRAILING_TP_RETRY_DELAYS_MS,
  TRAILING_TP_MAX_RETRIES,
  isRetryableTrailingCloseRejection,
  nextTrailingRetryDelay,
  trailingRetryStateAfterRefusal,
  trailingTpArmingPermitted,
  trailingCloseFailedMessage,
  isTrailingRetryPending,
  TRAILING_RETRY_STALE_MS,
} from './trailingCloseRetry'
import { notEnoughErrors } from '../main'
import { AUTH_FAILURE_SIGNATURES, VENUE_LOCKOUT_SIGNATURES } from '../authGuard'

describe('trailingCloseRetry — which refusals are retried (spec 050 §4.1)', () => {
  it('§4.1 retries a venue lockout — the reported production refusal', () => {
    // Spec §2.2: the Kraken answer that dropped two profitable trailing exits.
    expect(isRetryableTrailingCloseRejection('EGeneral:Temporary lockout')).to
      .be.true
  })

  it('§4.1 retries every wording the lockout guard knows', () => {
    // The two lists must not drift: a lockout is the canonical
    // order-independent refusal, and `authGuard` owns its wording.
    for (const s of VENUE_LOCKOUT_SIGNATURES) {
      expect(isRetryableTrailingCloseRejection(s), s).to.be.true
    }
  })

  it('§4.1 retries rate limits and bans', () => {
    const reasons = [
      'Too Many Requests | 429',
      'Way too much request weight used; IP banned until 1705737600000',
      'EAPI:Rate limit exceeded',
      'EGeneral:Too many requests',
      'Requests too frequent',
      '429 Too Many Requests',
    ]
    for (const r of reasons) {
      expect(isRetryableTrailingCloseRejection(r), r).to.be.true
    }
  })

  it('§4.1 retries a 5xx from the venue or from our own exchange service', () => {
    const reasons = [
      'Request failed with status code 500',
      'Request failed with status code 502',
      'Request failed with status code 503',
      'Request failed with status code 504',
      'Service Unavailable',
      'Internal Server Error',
      'Bad Gateway',
      'EService:Unavailable',
      'System is under maintenance',
    ]
    for (const r of reasons) {
      expect(isRetryableTrailingCloseRejection(r), r).to.be.true
    }
  })

  it('§4.1 retries an unrecognised refusal — the default is retry', () => {
    // Deliberate, and the asymmetry is argued in spec §4.1: an unlisted
    // transient wording costs the user a realised profit, while a wrongly
    // retried permanent one costs six bounded attempts and then reports.
    expect(isRetryableTrailingCloseRejection('EGeneral:Wat')).to.be.true
    expect(isRetryableTrailingCloseRejection('something new from a venue')).to
      .be.true
  })

  it('§4.1 does NOT retry any not-enough-balance wording the engine knows', () => {
    // Cross-list invariant against the engine's own list, so a venue added
    // there (Kraken and Hyperliquid were both added late) cannot start being
    // retried by this path. 'balance' is a substring entry; the concrete
    // wordings below are what venues actually send.
    for (const e of notEnoughErrors) {
      expect(isRetryableTrailingCloseRejection(`order rejected: ${e}`), e).to.be
        .false
    }
    const real = [
      'EOrder:Insufficient funds',
      'order 41: insufficient margin to place order. asset=41',
      'Margin is insufficient.',
      'Insufficient balance',
      'Order failed. Insufficient account balance',
      'insufficientAvailableFunds',
      'ab not enough for new order',
    ]
    for (const r of real) {
      expect(isRetryableTrailingCloseRejection(r), r).to.be.false
    }
  })

  it('§4.1 does NOT retry a notional / minimum-size refusal', () => {
    const reasons = [
      'The order funds should be more than 0.1',
      'Filter failure: NOTIONAL',
      'order must have minimum value of $10. asset=122',
      'Amount is lower than min allowed on exchange',
    ]
    for (const r of reasons) {
      expect(isRetryableTrailingCloseRejection(r), r).to.be.false
    }
  })

  it('§4.1 does NOT retry an order-parameter or price refusal', () => {
    const reasons = [
      'Order price has too many decimals.',
      'Filter failure: LOT_SIZE',
      'Order price is out of permissible range',
      'order price cannot be lower than the minimum',
      'Invalid quantity',
      'Order quantity exceeded upper limit',
    ]
    for (const r of reasons) {
      expect(isRetryableTrailingCloseRejection(r), r).to.be.false
    }
  })

  it('§4.1 does NOT retry a dead credential', () => {
    for (const s of AUTH_FAILURE_SIGNATURES) {
      expect(isRetryableTrailingCloseRejection(s), s).to.be.false
    }
  })

  it('§4.1 does NOT retry a compliance block or a duplicate order id', () => {
    const reasons = [
      'EAccount:Invalid permissions:USDT trading restricted for DE.',
      'Trading is restricted in your region',
      'Duplicate order sent',
      'Client order ID already exists',
      'clientOrderIdAlreadyExist',
    ]
    for (const r of reasons) {
      expect(isRetryableTrailingCloseRejection(r), r).to.be.false
    }
  })

  it('§4.1 does NOT retry a Binance Quantitative Rules restriction', () => {
    // Worse than pointless: every order sent during a restriction feeds the
    // unfilled-ratio that caused it.
    expect(
      isRetryableTrailingCloseRejection(
        'Futures Trading Quantitative Rules violated, only reduceOnly order is allowed, please try again later.',
      ),
    ).to.be.false
  })

  it('§4.1 still retries a nonce or signature blip', () => {
    // `authGuard` draws this line itself: these are transient and must not be
    // swept in with the dead-credential wordings next to them.
    expect(isRetryableTrailingCloseRejection('EAPI:Invalid nonce')).to.be.true
    expect(isRetryableTrailingCloseRejection('EAPI:Invalid signature')).to.be
      .true
  })

  it('§4.1 does NOT retry a reduce-only / position-flat refusal', () => {
    // `closeDealById` returns on these before the refusal site is reached, but
    // the classifier must not disagree with that if one ever arrives here.
    const reasons = [
      'ReduceOnly Order is rejected',
      'reduce only order would increase position',
      "You don't have any positions in this contract",
    ]
    for (const r of reasons) {
      expect(isRetryableTrailingCloseRejection(r), r).to.be.false
    }
  })

  it('§4.2 does NOT retry a refusal whose outcome is unknown', () => {
    // The close may have reached the matching engine; a retry would be a
    // second market order. Spec §4.2 / §7.1.
    const reasons = [
      'socket hang up',
      'read ECONNRESET',
      'connect ETIMEDOUT 1.2.3.4:443',
      'Request failed with status code 408',
      'fetch failed',
      'Unexpected end of JSON input',
      'timeout of 5000ms exceeded',
    ]
    for (const r of reasons) {
      expect(isRetryableTrailingCloseRejection(r), r).to.be.false
    }
  })

  it('an empty or missing reason is not retried', () => {
    expect(isRetryableTrailingCloseRejection('')).to.be.false
    expect(isRetryableTrailingCloseRejection(undefined)).to.be.false
  })

  it('classification ignores case', () => {
    expect(isRetryableTrailingCloseRejection('egeneral:TEMPORARY LOCKOUT')).to
      .be.true
    expect(isRetryableTrailingCloseRejection('MARGIN IS INSUFFICIENT.')).to.be
      .false
  })
})

describe('trailingCloseRetry — budget and backoff (spec 050 §4.3)', () => {
  it('§6.4 the five waits step from 30s to 1m', () => {
    expect(TRAILING_TP_RETRY_DELAYS_MS).to.deep.equal([
      30_000, 37_500, 45_000, 52_500, 60_000,
    ])
    expect(TRAILING_TP_MAX_RETRIES).to.equal(5)
  })

  it('§4.3 one initial attempt then five retries, then no more', () => {
    expect(nextTrailingRetryDelay(1)).to.equal(30_000)
    expect(nextTrailingRetryDelay(2)).to.equal(37_500)
    expect(nextTrailingRetryDelay(3)).to.equal(45_000)
    expect(nextTrailingRetryDelay(4)).to.equal(52_500)
    expect(nextTrailingRetryDelay(5)).to.equal(60_000)
    expect(nextTrailingRetryDelay(6), 'the fifth retry was the last').to.equal(
      null,
    )
    expect(nextTrailingRetryDelay(99)).to.equal(null)
  })

  it('§4.3 total exposure stays under four minutes', () => {
    const total = TRAILING_TP_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    expect(total).to.equal(225_000)
  })

  it('§6.1 the first refusal opens a retry due 30s later', () => {
    const now = 1_800_000_000_000
    const state = trailingRetryStateAfterRefusal(
      undefined,
      'EGeneral:Temporary lockout',
      now,
    )
    expect(state.status).to.equal('retrying')
    expect(state.attempts).to.equal(1)
    expect(state.since).to.equal(now)
    expect(state.lastAttempt).to.equal(now)
    expect(state.nextAttempt).to.equal(now + 30_000)
    expect(state.reason).to.equal('EGeneral:Temporary lockout')
  })

  it('§4.3 each further refusal widens the wait and keeps `since`', () => {
    const t0 = 1_800_000_000_000
    let state = trailingRetryStateAfterRefusal(undefined, 'a', t0)
    const waits: number[] = [state.nextAttempt! - t0]
    let t = t0
    for (let i = 1; i < 5; i++) {
      t = state.nextAttempt!
      state = trailingRetryStateAfterRefusal(state, 'a', t)
      expect(state.status, `retry ${i}`).to.equal('retrying')
      waits.push(state.nextAttempt! - t)
    }
    expect(waits).to.deep.equal(TRAILING_TP_RETRY_DELAYS_MS)
    expect(state.attempts).to.equal(5)
    expect(state.since, '`since` is the first refusal').to.equal(t0)
  })

  it('§6.6 the sixth refusal pauses instead of scheduling', () => {
    const t0 = 1_800_000_000_000
    let state = trailingRetryStateAfterRefusal(undefined, 'a', t0)
    for (let i = 0; i < 5; i++) {
      state = trailingRetryStateAfterRefusal(state, 'a', t0 + (i + 1) * 60_000)
    }
    expect(state.attempts, 'one initial attempt plus five retries').to.equal(6)
    expect(state.status).to.equal('paused')
    expect(state.nextAttempt, 'nothing is scheduled any more').to.equal(
      undefined,
    )
    // The crossing has not been earned yet — see §5.2.
    expect(state.rearmReady).to.equal(false)
  })
})

describe('trailingCloseRetry — a record only suppresses while pending (spec 050 §6.11)', () => {
  const now = 1_800_000_000_000
  const retrying = (nextAttempt: number) => ({
    status: 'retrying' as const,
    attempts: 2,
    since: now - 60_000,
    lastAttempt: now - 30_000,
    nextAttempt,
    reason: 'EGeneral:Temporary lockout',
  })

  it('§6.3 a retry still due suppresses', () => {
    expect(isTrailingRetryPending(retrying(now + 10_000), now)).to.be.true
  })

  it('§6.11 a deadline just passed still suppresses — the attempt is running', () => {
    expect(isTrailingRetryPending(retrying(now - 1_000), now)).to.be.true
  })

  it('§6.11 a stale retry record stops suppressing', () => {
    // The worker died between persisting the record and making the attempt, or
    // the re-entered close returned down a path that never reaches the refusal
    // site. Either way the deal must not stay unmanaged: this is the
    // self-releasing property `closeBySl` lacked (spec 049 §6.1).
    expect(
      isTrailingRetryPending(retrying(now - TRAILING_RETRY_STALE_MS - 1), now),
    ).to.be.false
    expect(isTrailingRetryPending(retrying(now - 3 * 24 * 60 * 60 * 1000), now))
      .to.be.false
  })

  it('§6.11 a record with no deadline, or a paused one, suppresses nothing', () => {
    expect(isTrailingRetryPending(undefined, now)).to.be.false
    expect(
      isTrailingRetryPending(
        {
          status: 'paused',
          attempts: 6,
          since: 1,
          lastAttempt: 2,
          reason: 'a',
          rearmReady: false,
        },
        now,
      ),
      'a paused trail is disarmed and managed normally',
    ).to.be.false
    expect(
      isTrailingRetryPending({ ...retrying(NaN), nextAttempt: undefined }, now),
    ).to.be.false
  })
})

describe('trailingCloseRetry — paused re-arming (spec 050 §5.2, §6.8)', () => {
  /** The fee-adjusted take-profit price `checkTrailing` arms `ttp` on. */
  const LINE = 100

  const paused = (rearmReady = false) => ({
    status: 'paused' as const,
    attempts: 6,
    since: 1,
    lastAttempt: 2,
    reason: 'EGeneral:Temporary lockout',
    rearmReady,
  })

  it('§6.8 no record means arming is permitted, unchanged', () => {
    expect(trailingTpArmingPermitted(undefined, 101, LINE, true)).to.deep.equal(
      { permitted: true, rearmReady: false },
    )
  })

  it('§6.8 a `retrying` record does not gate arming by the crossing rule', () => {
    // A retrying deal is skipped by `checkTrailing` outright (§6.3); this
    // predicate must not also claim it, or clearing the retry state would
    // depend on a crossing that never happened.
    const state = {
      status: 'retrying' as const,
      attempts: 2,
      since: 1,
      lastAttempt: 2,
      nextAttempt: 3,
      reason: 'a',
    }
    expect(trailingTpArmingPermitted(state, 101, LINE, true).permitted).to.be
      .true
  })

  it('§6.8 paused above the line refuses to arm — the price is a state, not an event', () => {
    // Straight after a refusal the price is usually still above the arming
    // line. Arming here is what would spend another five retries every four
    // minutes for as long as the venue condition lasts (spec §5.1).
    const r = trailingTpArmingPermitted(paused(), 101, LINE, true)
    expect(r.permitted).to.be.false
    expect(r.rearmReady, 'still above the line: nothing earned').to.be.false
  })

  it('§6.8 a tick below the line earns the re-arm', () => {
    const r = trailingTpArmingPermitted(paused(), 99, LINE, true)
    expect(r.permitted, 'the far side is not an arming price').to.be.false
    expect(r.rearmReady).to.be.true
  })

  it('§6.8 the tick that crosses back arms', () => {
    const r = trailingTpArmingPermitted(paused(true), 100, LINE, true)
    expect(r.permitted).to.be.true
    expect(r.rearmReady).to.be.true
  })

  it('§6.8 an earned re-arm is not lost while price stays below', () => {
    const r = trailingTpArmingPermitted(paused(true), 90, LINE, true)
    expect(r.permitted).to.be.false
    expect(r.rearmReady, 'the crossing stays earned').to.be.true
  })

  it('§6.8 the sides are mirrored on a short', () => {
    // Short: the arming side is BELOW the line.
    expect(trailingTpArmingPermitted(paused(), 99, LINE, false)).to.deep.equal({
      permitted: false,
      rearmReady: false,
    })
    expect(trailingTpArmingPermitted(paused(), 101, LINE, false)).to.deep.equal(
      { permitted: false, rearmReady: true },
    )
    expect(trailingTpArmingPermitted(paused(true), 100, LINE, false).permitted)
      .to.be.true
  })

  it('§6.8 an unknown arming line permits nothing and earns nothing', () => {
    // `getTrailingSettings` returns 0 when it did not compute a price. A
    // missing line is no evidence of a crossing in either direction.
    for (const line of [0, NaN, Infinity, -1]) {
      const r = trailingTpArmingPermitted(paused(), 101, line, true)
      expect(r.permitted, `${line}`).to.be.false
      expect(r.rearmReady, `${line}`).to.be.false
    }
    expect(
      trailingTpArmingPermitted(paused(true), 101, 0, true).rearmReady,
      'an earned crossing is not thrown away by a missing line',
    ).to.be.true
  })
})

describe('trailingCloseRetry — the message (spec 050 §6.6)', () => {
  const message = trailingCloseFailedMessage(
    '000000000000000000000d02',
    'SOL/EUR',
    'EGeneral:Temporary lockout',
    6,
  )

  it('§6.6 names the deal, the mechanism and the venue reason', () => {
    expect(message).to.contain('000000000000000000000d02')
    expect(message).to.contain('SOL/EUR')
    expect(message.toLowerCase()).to.contain('trailing take profit')
    expect(message).to.contain('EGeneral:Temporary lockout')
  })

  it('§6.6 tells the user the deal is theirs to manage now', () => {
    expect(message.toLowerCase()).to.contain('still open')
    expect(message.toLowerCase()).to.match(/manage|manually/)
  })

  it('§6.6 avoids the phrase `errorDict` claims for another condition', () => {
    // 'was left open on the exchange' is mapped to the `Position left open`
    // subType, which is a different thing — see `dealOutcome.ts`.
    expect(message).to.not.contain('was left open on the exchange')
  })
})
