/**
 * Buy & hold benchmark arithmetic, separated from the I/O that feeds it.
 *
 * The benchmark answers "what if I had just held the start asset instead of
 * trading?", against a reference pair that is pinned once when the bot's stats
 * are first seeded and never revisited. That pin outlives everything that can
 * take the pair away from the bot — a delisting prunes it out of
 * `settings.pair`, but the reference keeps pointing at it.
 *
 * `MainBot#getLatestPrice` is documented to return **0 when the exchange call
 * fails**. Both benchmark call sites used to feed that 0 straight into the
 * arithmetic, which is how bot 6926c265aeee0f2e5dac9aa4 came to report a Buy &
 * Hold of `-114330.7353` / `-100.05 %` — exactly `-startBalance.asset`, the
 * signature of a zero rate — with a chart benchmark line flat at zero, while
 * every stats tick asked Bybit for a price for the delisted `XIONUSDT` and
 * logged the rejection against the bot (spec 006, community #637).
 *
 * A failed lookup is not a price. These functions make that distinction the
 * caller's first decision instead of something the arithmetic silently absorbs.
 */

/**
 * Whether a price can serve as a benchmark rate.
 *
 * Positive, finite and real. `> 0` rather than `>= 0` on purpose: an asset that
 * genuinely collapsed still quotes a tiny positive price, and that reading is
 * true and belongs on the bot — only a *failed* lookup yields exactly 0.
 */
export function isBenchmarkRate(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
}

export type BuyAndHoldOutcome = {
  /** Value of the held reference asset now, in the bot's profit asset. */
  asset: number
  /** Benchmark P&L in USD. */
  result: number
  /** Benchmark P&L as a fraction of the USD start balance. */
  perc: number
}

/**
 * The benchmark, or `null` when it cannot be computed.
 *
 * `null` means "no answer" — the caller must keep whatever it already had.
 * Writing a value derived from a missing price is what produced the −100 %
 * readings this module exists to prevent.
 */
export function buyAndHoldOutcome(args: {
  startBalanceAsset: number
  startBalanceUsd: number
  startPrice: number
  rate: number
  usdRate: number
}): BuyAndHoldOutcome | null {
  const { startBalanceAsset, startBalanceUsd, startPrice, rate, usdRate } = args
  // `startPrice` goes through the same gate as `rate`: a reference pinned at 0
  // by an earlier priceless deal makes `startBalanceAsset / startPrice`
  // Infinity, and Infinity times a zero rate is the NaN that used to block
  // every later stats write.
  if (!isBenchmarkRate(rate) || !isBenchmarkRate(startPrice)) {
    return null
  }
  if (!Number.isFinite(startBalanceUsd) || startBalanceUsd === 0) {
    return null
  }
  if (!Number.isFinite(startBalanceAsset) || !Number.isFinite(usdRate)) {
    return null
  }
  const asset = (startBalanceAsset / startPrice) * rate
  const result = (asset - startBalanceAsset) * usdRate
  return { asset, result, perc: result / startBalanceUsd }
}

/**
 * The benchmark value to write on a chart point when there is no rate to
 * compute one from: today's point, else the previous one, else the start
 * balance. Same self-healing carry-forward the neighbouring `realizedProfit`
 * line applies, so a non-finite value already on the chart cannot propagate.
 */
export function carryForwardBenchmark(
  today: number | undefined,
  previous: number | undefined,
  startBalanceUsd: number,
): number {
  return [today, previous, startBalanceUsd].find((v) => Number.isFinite(v)) ?? 0
}
