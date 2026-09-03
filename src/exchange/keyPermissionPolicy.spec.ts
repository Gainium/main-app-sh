process.env.NODE_ENV = 'testing'

/**
 * Tests for the withdrawal-permission POLICY — the reject-vs-flag decision.
 *
 * This is the risky half of the feature. Everything else only reports; this
 * decides whether a user gets turned away. The inversion is unusual (we reject
 * a capability rather than require one), and getting it wrong in the
 * permissive direction lets a withdrawal-enabled key in, while getting it
 * wrong in the strict direction fails re-verification for users whose keys
 * work today and stops their live bots.
 *
 * The invariant these tests exist to protect: **existing connections are never
 * rejected**. `recordOnly` is the only entry point re-verification paths may
 * use, and it returns an observation, never a verdict.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  hasWithdrawalPermission,
  isRiskyConnection,
  recordOnly,
  shouldRejectNewConnection,
  withdrawalRejectionReason,
} from './keyPermissionPolicy'
import type { ExchangeKeyPermissions } from '../../types'

const perms = (p: Partial<ExchangeKeyPermissions>): ExchangeKeyPermissions => ({
  withdraw: 'unknown',
  transfer: 'unknown',
  ipRestricted: 'unknown',
  checkedAt: 1_700_000_000_000,
  ...p,
})

describe('keyPermissionPolicy', () => {
  describe('rejecting a NEW connection', () => {
    it('new connection with withdrawal is rejected', () => {
      expect(shouldRejectNewConnection(perms({ withdraw: 'yes' }))).to.equal(
        true,
      )
    })
    it('new connection without withdrawal is accepted', () => {
      expect(shouldRejectNewConnection(perms({ withdraw: 'no' }))).to.equal(
        false,
      )
    })
    // The whole point of the tri-state. We do not fail a user because a
    // permissions lookup timed out or because the exchange does not tell us.
    it('unknown is NOT a rejection', () => {
      expect(
        shouldRejectNewConnection(perms({ withdraw: 'unknown' })),
      ).to.equal(false)
    })
    it('absent permissions (exchange cannot answer) is NOT a rejection', () => {
      expect(shouldRejectNewConnection(undefined)).to.equal(false)
    })
    // The rule was deliberately widened from "can withdraw" to "can move funds
    // at all": Gainium calls no transfer endpoint on any exchange, so the
    // capability is pure downside. This is knowingly aggressive — nearly every
    // real Bybit key carries Wallet:[AccountTransfer], so ticking Assets at all
    // trips it. Existing connections are still only ever flagged, so no live bot
    // stops because of the widening.
    it('transfer permission alone IS grounds for rejecting a new connection', () => {
      expect(
        shouldRejectNewConnection(perms({ withdraw: 'no', transfer: 'yes' })),
      ).to.equal(true)
    })
    it('an unrestricted IP is a risk signal, not a rejection', () => {
      expect(
        shouldRejectNewConnection(perms({ withdraw: 'no', ipRestricted: 'no' })),
      ).to.equal(false)
    })
    it('hasWithdrawalPermission agrees', () => {
      expect([
        hasWithdrawalPermission(perms({ withdraw: 'yes' })),
        hasWithdrawalPermission(perms({ withdraw: 'no' })),
        hasWithdrawalPermission(perms({ withdraw: 'unknown' })),
        hasWithdrawalPermission(undefined),
      ]).to.deep.equal([true, false, false, false])
    })
  })

  describe('EXISTING connections: record, never reject', () => {
    // recordOnly returns an observation. There is deliberately no API here that
    // can turn an existing connection's withdrawal permission into a failure.
    const withdrawal = perms({
      withdraw: 'yes',
      detail: 'enableWithdrawals=true',
    })
    it('a withdrawal-enabled existing key is recorded, not rejected', () => {
      expect(recordOnly(withdrawal, undefined)).to.deep.equal(withdrawal)
    })
    it('a clean reading overwrites an older one', () => {
      expect(
        recordOnly(
          perms({ withdraw: 'no', checkedAt: 2 }),
          perms({ withdraw: 'yes' }),
        )?.withdraw,
      ).to.equal('no')
    })
    it('first-ever reading is stored even if wholly unknown', () => {
      expect(recordOnly(perms({}), undefined)?.withdraw).to.equal('unknown')
    })
    // The important failure mode: a transient outage must not erase a known-bad
    // reading. Otherwise a flaky exchange quietly launders a withdrawal-enabled
    // key back to "we have no concerns".
    it('an all-unknown reading does NOT overwrite a known withdrawal-enabled one', () => {
      expect(
        recordOnly(perms({}), perms({ withdraw: 'yes' })),
      ).to.equal(undefined)
    })
    it('an all-unknown reading does NOT overwrite a known-clean one either', () => {
      expect(recordOnly(perms({}), perms({ withdraw: 'no' }))).to.equal(
        undefined,
      )
    })
    it('a partially-known reading DOES overwrite', () => {
      expect(
        recordOnly(perms({ ipRestricted: 'no' }), perms({ withdraw: 'yes' }))
          ?.ipRestricted,
      ).to.equal('no')
    })
    it('no reading at all writes nothing', () => {
      expect(recordOnly(undefined, perms({ withdraw: 'yes' }))).to.equal(
        undefined,
      )
    })
  })

  describe('admin reporting', () => {
    it('risky = withdrawal enabled OR no IP allowlist', () => {
      expect([
        isRiskyConnection(perms({ withdraw: 'yes' })),
        isRiskyConnection(perms({ withdraw: 'no', ipRestricted: 'no' })),
        isRiskyConnection(perms({ withdraw: 'no', ipRestricted: 'yes' })),
        isRiskyConnection(perms({})),
        isRiskyConnection(undefined),
      ]).to.deep.equal([true, true, false, false, false])
    })
  })

  describe('the message', () => {
    // The message must name the capability actually found. It is only reached
    // when shouldRejectNewConnection() was true, so `permissions` is always
    // available — and must always be passed.
    it('withdrawal rejection names withdrawal, the exchange and the fix', () => {
      const wd = withdrawalRejectionReason('kraken', perms({ withdraw: 'yes' }))
      expect([
        wd.includes('withdrawal permission'),
        wd.includes('kraken'),
        wd.includes('read and trade'),
        // The Bybit hint is about a Bybit control; it must not appear here.
        wd.includes('Assets → Wallet'),
      ]).to.deep.equal([true, true, true, false])
    })
    it('transfer rejection names transfer and offers the Bybit control', () => {
      const tf = withdrawalRejectionReason(
        'bybit',
        perms({ withdraw: 'no', transfer: 'yes' }),
      )
      expect([
        tf.includes('transfer funds between accounts'),
        tf.includes('Assets → Wallet'),
      ]).to.deep.equal([true, true])
    })
    it('the Bybit-specific hint is not offered on other exchanges', () => {
      expect(
        withdrawalRejectionReason(
          'binance',
          perms({ withdraw: 'no', transfer: 'yes' }),
        ).includes('Assets → Wallet'),
      ).to.equal(false)
    })
    // REGRESSION: a caller that omits `permissions` used to get the transfer
    // wording plus the Bybit hint regardless of what was actually found.
    it('without permissions the message claims neither capability', () => {
      const bare = withdrawalRejectionReason('kraken')
      expect([
        bare.includes('withdrawal permission'),
        bare.includes('transfer funds between accounts'),
        bare.includes('Assets → Wallet'),
        bare.includes('move your funds'),
      ]).to.deep.equal([false, false, false, true])
    })
    it('message works without an exchange name', () => {
      expect(withdrawalRejectionReason().includes('undefined')).to.equal(
        false,
      )
    })
  })
})
