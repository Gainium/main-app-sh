process.env.NODE_ENV = 'testing'

/**
 * Regression tests for take-profits the venue reports FILLED without filling.
 *
 * Replays the orders that produced the bug on a real account (Kraken linear
 * futures, three DCA bots, 2026-08-29). Every deal below closed on a TP that
 * the venue called FILLED after selling 1-42% of it; the remainder accumulated
 * into BTC/XRP positions no bot owned, which consumed 4,233 of the account's
 * 4,258 USD of margin. With ~24 USD free every subsequent base order was
 * rejected `Not enough balance`, so all three bots looped
 * create-deal → rejected → cancel for weeks. 41 users were affected in a
 * 30-day window.
 *
 * The two halves this pins:
 *   - the real underfilled rows MUST be detected, whatever the venue or order
 *     type — the previous guard was gated on bybit+LIMIT and matched none of
 *     them;
 *   - full fills and rounding dust MUST NOT be, or a deal can never close and
 *     the silent stranding is merely traded for a silently wedged deal.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        src/bot/dca/partialTp.spec.ts
 */
import { underfilledTpQty, PARTIAL_TP_TOLERANCE } from './partialTp'

let failures = 0

const tp = (origQty: string, executedQty: string, over: object = {}) => ({
  typeOrder: 'dealTP',
  status: 'FILLED',
  origQty,
  executedQty,
  ...over,
})

function expectStranding(name: string, order: object, shouldDetect: boolean) {
  const unsold = underfilledTpQty(order)
  const detected = unsold > 0
  const ok = detected === shouldDetect
  if (!ok) failures++
  console.log(
    `${ok ? ' PASS' : '*FAIL'}  ${name.padEnd(50)} unsold=${unsold} detected=${detected}`,
  )
}

console.log('-- real stranded TPs; each MUST be detected --')
// deal 6a140f941af32681aa9ee80d: bought 0.1065 BTC over six orders, TP sold 0.0023
expectStranding(
  'BTC 0.1065 -> 0.0023 (MARKET, krakenUsdm)',
  tp('0.1065', '0.0023'),
  true,
)
// its re-placed remainder, a D-SR order, underfilled again
expectStranding(
  'BTC 0.1042 -> 0.0011 (D-SR remainder)',
  tp('0.1042', '0.0011'),
  true,
)
expectStranding('BTC 0.0908 -> 0.0377', tp('0.0908', '0.0377'), true)
expectStranding('XAUT 0.09 -> 0.008', tp('0.09', '0.008'), true)
expectStranding('XRP 589 -> 4', tp('589', '4'), true)
expectStranding(
  'nothing sold at all: 1.0 -> "0.00000000"',
  tp('1.0', '0.00000000'),
  true,
)

console.log('-- clean closes; MUST NOT be detected --')
expectStranding(
  'exact full fill 0.0612 -> 0.0612',
  tp('0.0612', '0.0612'),
  false,
)
// a real row: the venue settled a hair OVER the requested size
expectStranding(
  'venue settled over 0.0604 -> 0.0605',
  tp('0.0604', '0.0605'),
  false,
)

console.log('-- wedge guards; MUST NOT be detected or deals never close --')
expectStranding('dust 1.0 -> 0.9995 (0.05% short)', tp('1.0', '0.9995'), false)
expectStranding('dust 1.0 -> 0.9992 (0.08% short)', tp('1.0', '0.9992'), false)
expectStranding('origQty zero', tp('0', '0'), false)
expectStranding('non-numeric quantities', tp('abc', 'xyz'), false)
expectStranding('negative executedQty', tp('1', '-1'), false)
expectStranding('not FILLED', tp('1', '0', { status: 'NEW' }), false)
expectStranding(
  'not a take-profit',
  tp('1', '0', { typeOrder: 'dealStart' }),
  false,
)

console.log('-- just past the tolerance; MUST be detected --')
expectStranding('1.0 -> 0.9989 (0.11% short)', tp('1.0', '0.9989'), true)

// The exact boundary is a float knife-edge (1.0 - 0.999 === 0.0010000000000000009)
// and is deliberately not asserted either way.
if (PARTIAL_TP_TOLERANCE !== 0.001) {
  console.log('*FAIL  PARTIAL_TP_TOLERANCE changed; revisit the cases above')
  failures++
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
