process.env.NODE_ENV = 'testing'

/**
 * Checks for the observed-fee resolution that `deal.feePaid` and
 * `deal.commission` are now built from.
 *
 * This repo has no test runner, so run it directly:
 *
 *   npx ts-node --files --project tsconfig.json src/bot/orderFee.spec.ts
 *
 * Two properties matter more than the rest, and both are about NOT booking a
 * number we do not have:
 *
 *   1. An order the venue did not price, or priced in an asset that is neither
 *      side of the pair, resolves to `null` — "fall back to the estimate" —
 *      and never to `{base: 0, quote: 0}`. A zeroed split books a real cost as
 *      free, which is strictly worse than the estimate it replaced.
 *   2. The stream accrual is idempotent. It sums per-trade commissions, so a
 *      replayed report must not inflate the fee.
 */
import {
  accrueStreamFee,
  hasObservedFee,
  observedFeeOnSide,
  observedFeeSplit,
} from './orderFee'

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

const order = (over: Record<string, unknown>) =>
  ({ baseAsset: 'BTC', quoteAsset: 'USDT', ...over }) as any

// ── A venue that names a SIDE (Kraken, Coinbase, Bybit) ────────────────────
expect(
  'feeSide quote books against quote',
  observedFeeSplit(order({ feePaid: '0.6', feeSide: 'quote' })),
  { base: 0, quote: 0.6 },
)
expect(
  'feeSide base books against base',
  observedFeeSplit(order({ feePaid: '0.001', feeSide: 'base' })),
  { base: 0.001, quote: 0 },
)

// ── A venue that names a TICKER (OKX, KuCoin, Bitget, Binance) ─────────────
expect(
  'feeAsset matching quote books against quote',
  observedFeeSplit(order({ feePaid: '0.08', feeAsset: 'USDT' })),
  { base: 0, quote: 0.08 },
)
expect(
  'feeAsset matching base books against base',
  observedFeeSplit(order({ feePaid: '0.00002', feeAsset: 'BTC' })),
  { base: 0.00002, quote: 0 },
)
expect(
  'ticker comparison is case-insensitive',
  observedFeeSplit(order({ feePaid: '1', feeAsset: 'usdt' })),
  { base: 0, quote: 1 },
)
expect(
  'a side named by the venue wins over the ticker',
  observedFeeSplit(order({ feePaid: '2', feeSide: 'base', feeAsset: 'USDT' })),
  { base: 2, quote: 0 },
)

// ── A THIRD asset: real, unbookable here, must not become zero ─────────────
expect(
  'a BNB fee falls back rather than booking as free',
  observedFeeSplit(order({ feePaid: '0.0007', feeAsset: 'BNB' })),
  null,
)
expect(
  'a KCS fee falls back rather than booking as free',
  observedFeeSplit(order({ feePaid: '0.004', feeAsset: 'KCS' })),
  null,
)

// ── Nothing observed at all → fall back ────────────────────────────────────
for (const [label, over] of [
  ['no fee fields', {}],
  ['zero fee', { feePaid: '0', feeAsset: 'USDT' }],
  ['empty fee', { feePaid: '', feeAsset: 'USDT' }],
  ['fee with no currency', { feePaid: '1' }],
] as [string, any][]) {
  expect(`${label} falls back`, observedFeeSplit(order(over)), null)
}
expect('a null order falls back', observedFeeSplit(null as any), null)

// ── feeBreakdown: both legs on the pair is bookable; a third asset is not ──
expect(
  'a breakdown wholly on the pair is booked',
  observedFeeSplit(
    order({
      feeBreakdown: [
        { asset: 'USDT', amount: '0.05' },
        { asset: 'BTC', amount: '0.0001' },
      ],
    }),
  ),
  { base: 0.0001, quote: 0.05 },
)
expect(
  'a breakdown with one off-pair leg falls back whole',
  observedFeeSplit(
    order({
      feeBreakdown: [
        { asset: 'BNB', amount: '0.0003' },
        { asset: 'USDT', amount: '0.05' },
      ],
    }),
  ),
  null,
)

// ── hasObservedFee ─────────────────────────────────────────────────────────
expect(
  'hasObservedFee on a priced order',
  hasObservedFee(order({ feePaid: '1' })),
  true,
)
expect(
  'hasObservedFee on a zero fee',
  hasObservedFee(order({ feePaid: '0' })),
  false,
)
expect('hasObservedFee on nothing', hasObservedFee(order({})), false)
expect(
  'hasObservedFee on a breakdown',
  hasObservedFee(order({ feeBreakdown: [{ asset: 'BNB', amount: '1' }] })),
  true,
)

// ── observedFeeOnSide: the grid/combo one-side shape ──────────────────────
// The combo transaction path assumes exactly one of comBase/comQuote is
// populated, keyed to the TRADE side, and converts between them afterwards.
// A venue that charges on the other side (Kraken bills base on a sell) must
// therefore be converted here, or the next conversion overwrites the real fee
// with zero.
expect(
  'a quote fee on a buy is converted into base',
  observedFeeOnSide({ base: 0, quote: 50 }, 'base', 100),
  0.5,
)
expect(
  'a base fee on a sell is converted into quote',
  observedFeeOnSide({ base: 0.5, quote: 0 }, 'quote', 100),
  50,
)
expect(
  'a fee already on the requested side passes through',
  observedFeeOnSide({ base: 0, quote: 50 }, 'quote', 100),
  50,
)
expect(
  'a split fee is combined onto one side',
  observedFeeOnSide({ base: 0.1, quote: 5 }, 'quote', 100),
  15,
)
for (const [label, split, price] of [
  ['nothing observed', null, 100],
  ['a zero price', { base: 1, quote: 0 }, 0],
  ['an empty split', { base: 0, quote: 0 }, 100],
] as [string, any, number][]) {
  expect(
    `observedFeeOnSide falls back on ${label}`,
    observedFeeOnSide(split, 'quote', price),
    null,
  )
}

// ── Stream accrual: per-trade slices, summed, idempotently ────────────────
const t1 = accrueStreamFee(
  {},
  {
    commission: '0.05',
    commissionAsset: 'USDT',
    tradeId: 100,
  },
)
expect('first trade starts the total', t1, {
  feePaid: '0.05',
  feeAsset: 'USDT',
  feeTradeId: 100,
})
const t2 = accrueStreamFee(t1 as any, {
  commission: '0.03',
  commissionAsset: 'USDT',
  tradeId: 101,
})
expect('a later trade adds to it', t2, {
  feePaid: '0.08',
  feeAsset: 'USDT',
  feeTradeId: 101,
})
expect(
  'a REPLAYED report adds nothing',
  accrueStreamFee(t2 as any, {
    commission: '0.03',
    commissionAsset: 'USDT',
    tradeId: 101,
  }),
  {},
)
expect(
  'an OLDER report adds nothing',
  accrueStreamFee(t2 as any, {
    commission: '0.05',
    commissionAsset: 'USDT',
    tradeId: 100,
  }),
  {},
)
expect(
  'a report with no trade id is ignored — a repeat is indistinguishable',
  accrueStreamFee(t2 as any, { commission: '0.03', commissionAsset: 'USDT' }),
  {},
)
expect(
  'a second fee CURRENCY is not summed into the first',
  accrueStreamFee(t2 as any, {
    commission: '0.0002',
    commissionAsset: 'BNB',
    tradeId: 102,
  }),
  {},
)
for (const [label, msg] of [
  ['zero commission', { commission: '0', commissionAsset: 'USDT', tradeId: 1 }],
  ['no commission', { commissionAsset: 'USDT', tradeId: 1 }],
  ['null asset', { commission: '1', commissionAsset: null, tradeId: 1 }],
] as [string, any][]) {
  expect(`stream accrual ignores ${label}`, accrueStreamFee({}, msg), {})
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
