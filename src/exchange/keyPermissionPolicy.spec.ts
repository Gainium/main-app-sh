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
 * Run: npx ts-node --files --project tsconfig.json \
 *        core/src/exchange/keyPermissionPolicy.spec.ts
 */
import {
  hasWithdrawalPermission,
  isRiskyConnection,
  recordOnly,
  shouldRejectNewConnection,
  withdrawalRejectionReason,
} from './keyPermissionPolicy'
import type { ExchangeKeyPermissions } from '../../types'

let failures = 0
function expect(label: string, actual: unknown, want: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
  )
}

const perms = (p: Partial<ExchangeKeyPermissions>): ExchangeKeyPermissions => ({
  withdraw: 'unknown',
  transfer: 'unknown',
  ipRestricted: 'unknown',
  checkedAt: 1_700_000_000_000,
  ...p,
})

function main() {
  // ── Rejecting a NEW connection ────────────────────────────────────────────
  expect(
    'new connection with withdrawal is rejected',
    shouldRejectNewConnection(perms({ withdraw: 'yes' })),
    true,
  )
  expect(
    'new connection without withdrawal is accepted',
    shouldRejectNewConnection(perms({ withdraw: 'no' })),
    false,
  )
  // The whole point of the tri-state. We do not fail a user because a
  // permissions lookup timed out or because the exchange does not tell us.
  expect(
    'unknown is NOT a rejection',
    shouldRejectNewConnection(perms({ withdraw: 'unknown' })),
    false,
  )
  expect(
    'absent permissions (exchange cannot answer) is NOT a rejection',
    shouldRejectNewConnection(undefined),
    false,
  )
  // The rule was deliberately widened from "can withdraw" to "can move funds
  // at all": Gainium calls no transfer endpoint on any exchange, so the
  // capability is pure downside. This is knowingly aggressive — nearly every
  // real Bybit key carries Wallet:[AccountTransfer], so ticking Assets at all
  // trips it. Existing connections are still only ever flagged, so no live bot
  // stops because of the widening.
  expect(
    'transfer permission alone IS grounds for rejecting a new connection',
    shouldRejectNewConnection(perms({ withdraw: 'no', transfer: 'yes' })),
    true,
  )
  expect(
    'an unrestricted IP is a risk signal, not a rejection',
    shouldRejectNewConnection(perms({ withdraw: 'no', ipRestricted: 'no' })),
    false,
  )
  expect(
    'hasWithdrawalPermission agrees',
    [
      hasWithdrawalPermission(perms({ withdraw: 'yes' })),
      hasWithdrawalPermission(perms({ withdraw: 'no' })),
      hasWithdrawalPermission(perms({ withdraw: 'unknown' })),
      hasWithdrawalPermission(undefined),
    ],
    [true, false, false, false],
  )

  // ── EXISTING connections: record, never reject ────────────────────────────
  // recordOnly returns an observation. There is deliberately no API here that
  // can turn an existing connection's withdrawal permission into a failure.
  const withdrawal = perms({
    withdraw: 'yes',
    detail: 'enableWithdrawals=true',
  })
  expect(
    'a withdrawal-enabled existing key is recorded, not rejected',
    recordOnly(withdrawal, undefined),
    withdrawal,
  )
  expect(
    'a clean reading overwrites an older one',
    recordOnly(
      perms({ withdraw: 'no', checkedAt: 2 }),
      perms({ withdraw: 'yes' }),
    )?.withdraw,
    'no',
  )
  expect(
    'first-ever reading is stored even if wholly unknown',
    recordOnly(perms({}), undefined)?.withdraw,
    'unknown',
  )
  // The important failure mode: a transient outage must not erase a known-bad
  // reading. Otherwise a flaky exchange quietly launders a withdrawal-enabled
  // key back to "we have no concerns".
  expect(
    'an all-unknown reading does NOT overwrite a known withdrawal-enabled one',
    recordOnly(perms({}), perms({ withdraw: 'yes' })),
    undefined,
  )
  expect(
    'an all-unknown reading does NOT overwrite a known-clean one either',
    recordOnly(perms({}), perms({ withdraw: 'no' })),
    undefined,
  )
  expect(
    'a partially-known reading DOES overwrite',
    recordOnly(perms({ ipRestricted: 'no' }), perms({ withdraw: 'yes' }))
      ?.ipRestricted,
    'no',
  )
  expect(
    'no reading at all writes nothing',
    recordOnly(undefined, perms({ withdraw: 'yes' })),
    undefined,
  )

  // ── Admin reporting ───────────────────────────────────────────────────────
  expect(
    'risky = withdrawal enabled OR no IP allowlist',
    [
      isRiskyConnection(perms({ withdraw: 'yes' })),
      isRiskyConnection(perms({ withdraw: 'no', ipRestricted: 'no' })),
      isRiskyConnection(perms({ withdraw: 'no', ipRestricted: 'yes' })),
      isRiskyConnection(perms({})),
      isRiskyConnection(undefined),
    ],
    [true, true, false, false, false],
  )

  // ── The message ───────────────────────────────────────────────────────────
  // The message must name the capability actually found. It is only reached
  // when shouldRejectNewConnection() was true, so `permissions` is always
  // available — and must always be passed.
  const wd = withdrawalRejectionReason('kraken', perms({ withdraw: 'yes' }))
  expect(
    'withdrawal rejection names withdrawal, the exchange and the fix',
    [
      wd.includes('withdrawal permission'),
      wd.includes('kraken'),
      wd.includes('read and trade'),
      // The Bybit hint is about a Bybit control; it must not appear here.
      wd.includes('Assets → Wallet'),
    ],
    [true, true, true, false],
  )
  const tf = withdrawalRejectionReason(
    'bybit',
    perms({ withdraw: 'no', transfer: 'yes' }),
  )
  expect(
    'transfer rejection names transfer and offers the Bybit control',
    [
      tf.includes('transfer funds between accounts'),
      tf.includes('Assets → Wallet'),
    ],
    [true, true],
  )
  expect(
    'the Bybit-specific hint is not offered on other exchanges',
    withdrawalRejectionReason(
      'binance',
      perms({ withdraw: 'no', transfer: 'yes' }),
    ).includes('Assets → Wallet'),
    false,
  )
  // REGRESSION: a caller that omits `permissions` used to get the transfer
  // wording plus the Bybit hint regardless of what was actually found.
  const bare = withdrawalRejectionReason('kraken')
  expect(
    'without permissions the message claims neither capability',
    [
      bare.includes('withdrawal permission'),
      bare.includes('transfer funds between accounts'),
      bare.includes('Assets → Wallet'),
      bare.includes('move your funds'),
    ],
    [false, false, false, true],
  )
  expect(
    'message works without an exchange name',
    withdrawalRejectionReason().includes('undefined'),
    false,
  )

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}

main()
