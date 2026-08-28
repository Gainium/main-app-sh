process.env.NODE_ENV = 'testing'

/**
 * Checks for the deal reference price — the number every percentage exit on a
 * DCA/combo deal is measured from.
 *
 * This repo has no test runner, so run it directly:
 *
 *   npx ts-node --files --project tsconfig.json src/bot/dealRefPrice.spec.ts
 *
 * The property under test is narrow and load-bearing: a `settings.avgPrice` of
 * `0` must never reach a price calculation. It is not a smaller reference, it
 * is a missing one — `getTrailingSettings` turns it into `trailingTpPrice: 0`,
 * which `checkTrailing` reads as falsy, so trailing TP never arms and (because
 * `trailingTp` also suppresses the resting TP order) the deal is left with no
 * take profit at all. The same zero makes move SL's trigger `0`, which
 * `last >= required` satisfies on the first tick of a long deal.
 *
 * The second property is that the zero is never *persisted*: three deals on
 * prod reached exactly this state through the dashboard's mass deal-edit,
 * which seeds its form from the bot-form defaults (`avgPrice: 0`) and diffs
 * that against each selected deal's real average.
 */
import {
  dealRefPrice,
  isUsableRefPrice,
  withoutUnusableAvgPrice,
} from './dealRefPrice'

let failures = 0
function expect(label: string, actual: unknown, want: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(
      actual,
    )} want ${JSON.stringify(want)}`,
  )
}

// ── isUsableRefPrice ───────────────────────────────────────────────────────
expect('a real price is usable', isUsableRefPrice(68170.27), true)
expect('zero is not usable', isUsableRefPrice(0), false)
expect('undefined is not usable', isUsableRefPrice(undefined), false)
expect('null is not usable', isUsableRefPrice(null), false)
expect('a negative price is not usable', isUsableRefPrice(-1), false)
expect('NaN is not usable', isUsableRefPrice(NaN), false)
expect('Infinity is not usable', isUsableRefPrice(Infinity), false)

// ── dealRefPrice ───────────────────────────────────────────────────────────
// The regression: `settings.avgPrice ?? deal.avgPrice` returned 0 here.
expect(
  'a zeroed override falls back to the computed average',
  dealRefPrice(0, 68170.27307581436),
  68170.27307581436,
)
expect(
  'an absent override falls back to the computed average',
  dealRefPrice(undefined, 2069.9362322890206),
  2069.9362322890206,
)
expect(
  'a real override still wins over the computed average',
  dealRefPrice(70000, 68170.27307581436),
  70000,
)
// A deal that has genuinely not filled yet has nothing to fall back to; the
// caller's own guards (`skipTp`, `isDealForMoveSl`) keep it out of the price
// checks, so returning 0 here is the honest answer, not a hazard.
expect('nothing usable on either side stays 0', dealRefPrice(0, 0), 0)

// ── withoutUnusableAvgPrice ────────────────────────────────────────────────
// A stand-in for `Partial<Deal['settings']>`; the helper is generic over the
// patch shape, so it needs a named type rather than a bare object literal.
type Patch = { avgPrice?: number; tpPerc?: string }

// The mass deal-edit payload: bot-form defaults diffed against a real deal.
expect(
  'a zero avgPrice is dropped from the patch',
  withoutUnusableAvgPrice<Patch>({ avgPrice: 0, tpPerc: '20' }),
  { tpPerc: '20' },
)
expect(
  'a real avgPrice override is preserved',
  withoutUnusableAvgPrice<Patch>({ avgPrice: 70000, tpPerc: '20' }),
  { avgPrice: 70000, tpPerc: '20' },
)
expect(
  'a patch that never mentions avgPrice is untouched',
  withoutUnusableAvgPrice<Patch>({ tpPerc: '20' }),
  { tpPerc: '20' },
)
expect(
  'an avgPrice-only patch of 0 becomes an empty patch',
  withoutUnusableAvgPrice<Patch>({ avgPrice: 0 }),
  {},
)
// `updateDealSettings` returns early on an empty patch, so a mass edit that
// changed nothing else cannot fall through into cancel-and-recreate.
expect(
  'the emptied patch has no keys left for updateDealSettings to act on',
  Object.keys(withoutUnusableAvgPrice<Patch>({ avgPrice: 0 })).length,
  0,
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
