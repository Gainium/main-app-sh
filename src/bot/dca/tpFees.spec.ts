process.env.NODE_ENV = 'testing'

/**
 * Regression tests for TP/SL fee pricing.
 *
 * Two bugs were conflated here once and must not be conflated again:
 *
 *  1. **Spot quantity (86ex01wye).** A percentage stop-loss sized its sell with
 *     the taker fee on the assumption that taker >= maker. Promotional pricing
 *     inverted that on one pair, the bot tried to sell more base than it held,
 *     and the SL market order was rejected — the deal could not be closed.
 *     Fix: use the WORSE of the two sides, never a fixed side.
 *
 *  2. **Futures price (regression, v1.14.17 -> here).** The fix for (1) folded
 *     the price leg's separate fee lookup into the quantity leg's value. That
 *     value is deliberately zeroed on futures, so every futures TP and
 *     percentage SL was placed with NO fee compensation — silently, since the
 *     deal still closes cleanly and the reported P&L is accurate. It just
 *     under-delivers the configured percentage by a round trip.
 *
 * (2) has no symptom a user can report, so it is pinned here rather than left
 * to review.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        core/src/bot/dca/tpFees.spec.ts
 */
import { tpPriceDisplacement, worstFee } from './tpFees'

let failures = 0

function check(name: string, actual: number, expected: number) {
  const ok = Math.abs(actual - expected) < 1e-12
  if (!ok) {
    failures++
  }
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n      expected ${expected}, got ${actual}`),
  )
}

// Binance USD-M standard tier.
const futuresFee = { maker: 0.0002, taker: 0.0005 }
// The 86ex01wye shape: a promo makes taker CHEAPER than maker.
const promoFee = { maker: 0.001, taker: 0.0004 }
// The quantity leg's value on futures — what the price leg must NOT read.
const zeroedFee = { maker: 0, taker: 0 }

console.log('\n-- worstFee: neither side may be assumed cheaper --')
check('takes taker when taker is worse', worstFee(futuresFee), 0.0005)
check('takes maker under promo pricing', worstFee(promoFee), 0.001)
check('missing fee is zero, not NaN', worstFee(undefined), 0)
check(
  'partial fee object falls back per side',
  worstFee({ maker: 0.0003 }),
  0.0003,
)

console.log(
  '\n-- tpPriceDisplacement: a long is pushed away from entry, a short toward it --',
)
check(
  'long covers the round trip',
  tpPriceDisplacement(futuresFee, true),
  1 + 0.001,
)
check(
  'short covers the round trip',
  tpPriceDisplacement(futuresFee, false),
  1 - 0.001,
)
check(
  'zero-fee account needs no displacement',
  tpPriceDisplacement(zeroedFee, true),
  1,
)

console.log('\n-- the regression itself --')
// A futures TP fed the zeroed quantity fee lands exactly at the configured
// percentage, pocketing none of the round trip. This is the bug: it must not
// be what a real futures fee produces.
check(
  'zeroed fee collapses displacement (the bug shape)',
  tpPriceDisplacement(zeroedFee, true),
  1,
)
const real = tpPriceDisplacement(futuresFee, true)
console.log(
  `${real > 1 ? 'PASS' : 'FAIL'}  a real futures fee must NOT collapse to 1 (got ${real})`,
)
if (!(real > 1)) {
  failures++
}

// The user-visible consequence, at the TP size that makes it legible: a 0.12%
// TP on a 100.00 average entry. Compensated, the order rests 0.10% higher.
const avg = 100
const tpPerc = 0.0012
const compensated = avg * (1 + tpPerc) * tpPriceDisplacement(futuresFee, true)
const uncompensated = avg * (1 + tpPerc) * tpPriceDisplacement(zeroedFee, true)
check(
  '0.12% TP on futures rests above the uncompensated price',
  compensated,
  100.22012,
)
check('uncompensated price is the bare target', uncompensated, 100.12)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
