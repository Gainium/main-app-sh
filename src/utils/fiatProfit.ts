import { REPORTING_FIATS } from './fiatRates'

const DAY_MS = 24 * 60 * 60 * 1000

/** UTC midnight (ms) of the day `time` falls in. */
export const utcDay = (time: number): number =>
  time - (((time % DAY_MS) + DAY_MS) % DAY_MS)

/**
 * A realized profit as the bot books it: the USD value it adds to
 * `userProfitByHour.profitUsd`, plus — when the profit was made in a reporting
 * fiat (EUR on LINK-EUR) — that same profit in the fiat itself.
 */
export type FiatProfitPart = {
  /** Currency the profit was made in (the pair's quote, usually). */
  asset?: string | null
  /** The profit in `asset`. */
  amount: number
}

/**
 * The `$inc` for one booked profit. `profitFiat.<code>` is only written for a
 * non-USD reporting fiat: USD already IS `profitUsd`, and a crypto or
 * stablecoin quote has no face value in any reporting currency.
 */
export const profitByHourInc = (
  usd: number,
  fiat?: FiatProfitPart | null,
): Record<string, number> => {
  const inc: Record<string, number> = { profitUsd: usd }
  const code = fiat?.asset?.toUpperCase()
  if (
    code &&
    REPORTING_FIATS.includes(code) &&
    Number.isFinite(fiat?.amount) &&
    Number.isFinite(usd)
  ) {
    inc[`profitFiat.${code}`] = fiat!.amount
    inc[`profitFiatUsd.${code}`] = usd
  }
  return inc
}

/**
 * `usd / rate` as the fiat part of a profit whose USD value was computed as
 * `amount × rate` — undefined (USD only) when the rate is unusable.
 */
export const fiatPartFromUsd = (
  asset: string | null | undefined,
  usd: number,
  rate: number,
): FiatProfitPart | undefined =>
  asset && rate > 0 && Number.isFinite(rate)
    ? { asset, amount: usd / rate }
    : undefined

/**
 * Units of `code` per 1 USD for every UTC day from `from` to `to` (inclusive),
 * as an array indexed by `(utcDay(t) - from) / DAY_MS`. Built from stored days
 * (1 unit = X USD); a day without one takes the previous day's, days before the
 * first stored one take the first, and `fallback` (today's rate) fills
 * everything when nothing is stored.
 */
export const dailyUnitsPerUsd = (
  days: { day: number; usdRate: number }[],
  from: number,
  to: number,
  fallback: number,
): number[] => {
  const start = utcDay(from)
  const end = utcDay(to)
  const byDay = new Map<number, number>()
  for (const d of days) {
    if (d.usdRate > 0 && Number.isFinite(d.usdRate)) {
      byDay.set(utcDay(d.day), 1 / d.usdRate)
    }
  }
  const sorted = [...byDay.keys()].sort((a, b) => a - b)
  const before = sorted.filter((d) => d <= start).pop()
  let last =
    before !== undefined
      ? byDay.get(before)!
      : sorted.length
        ? byDay.get(sorted[0])!
        : fallback
  const out: number[] = []
  for (let d = start; d <= end; d += DAY_MS) {
    const v = byDay.get(d)
    if (v !== undefined) last = v
    out.push(last)
  }
  return out
}

/**
 * Aggregation expression for a `userProfitByHour` row's profit in `code`:
 * the part made in `code` at face value, the rest (`profitUsd` minus that
 * part's USD value) converted at the rate of the row's UTC day.
 *
 * `rates` is `dailyUnitsPerUsd(…, from, …)`; rows outside it use the nearest
 * end. The caller divides by the dashboard's own rate so the client, which
 * multiplies every USD figure by that rate, shows exactly this amount.
 */
export const reportingProfitExpr = (
  code: string,
  rates: number[],
  from: number,
): Record<string, unknown> => {
  const face = { $ifNull: [`$profitFiat.${code}`, 0] }
  const faceUsd = { $ifNull: [`$profitFiatUsd.${code}`, 0] }
  const last = Math.max(rates.length - 1, 0)
  const index = {
    $min: [
      last,
      {
        $max: [
          0,
          {
            $toInt: {
              $floor: {
                $divide: [{ $subtract: ['$time', utcDay(from)] }, DAY_MS],
              },
            },
          },
        ],
      },
    ],
  }
  return {
    $add: [
      face,
      {
        $multiply: [
          { $subtract: [{ $ifNull: ['$profitUsd', 0] }, faceUsd] },
          rates.length ? { $arrayElemAt: [rates, index] } : 1,
        ],
      },
    ],
  }
}
