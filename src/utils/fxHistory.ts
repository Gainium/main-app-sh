import axios from 'axios'
import models from '../db/model'
import logger from './logger'
import type { FxRateDaySchema } from '../../types'
import { dailyUnitsPerUsd, utcDay } from './fiatProfit'
import { usableFiatRates, type FiatRate } from './fiatRates'

const logPrefix = 'fxHistory |'
const DAY_MS = 24 * 60 * 60 * 1000

/** First day realized profit is valued at its own day's rate. */
export const FX_HISTORY_START = Date.UTC(2021, 0, 1)

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * ECB reference rates for every business day in [from, to], as
 * "1 unit = X USD" per currency, keyed by UTC midnight. Keyless (Frankfurter).
 */
export const fetchEcbSeries = async (
  from: number,
  to: number,
): Promise<Map<number, Record<string, number>>> => {
  const res = await axios.get<{
    rates?: Record<string, Record<string, unknown>>
  }>(`https://api.frankfurter.dev/v1/${isoDay(from)}..${isoDay(to)}?base=USD`, {
    timeout: 60_000,
  })
  const out = new Map<number, Record<string, number>>()
  for (const [day, perUsd] of Object.entries(res.data?.rates ?? {})) {
    const rates: Record<string, number> = {}
    for (const [code, v] of Object.entries(perUsd ?? {})) {
      if (typeof v === 'number' && isFinite(v) && v > 0) rates[code] = 1 / v
    }
    const ms = Date.parse(`${day}T00:00:00Z`)
    if (Number.isFinite(ms) && Object.keys(rates).length) out.set(ms, rates)
  }
  return out
}

/**
 * Every day from `from` to `to` with the last published rates carried into
 * the days the source skipped (weekends, holidays).
 */
export const carryForwardDays = (
  series: Map<number, Record<string, number>>,
  from: number,
  to: number,
): { day: number; rates: Record<string, number> }[] => {
  const days = [...series.keys()].sort((a, b) => a - b)
  let last: Record<string, number> | undefined = series.get(
    days.filter((d) => d <= utcDay(from)).pop() ?? NaN,
  )
  const out: { day: number; rates: Record<string, number> }[] = []
  for (let d = utcDay(from); d <= utcDay(to); d += DAY_MS) {
    last = series.get(d) ?? last
    if (last) out.push({ day: d, rates: last })
  }
  return out
}

/**
 * Stores today's rates (the ones just written to the rate doc). Merged per
 * currency, so a currency the live sources dropped keeps the day's earlier
 * value.
 */
export const recordFxDay = async (
  fiatRates: FiatRate[] | null | undefined,
  now = Date.now(),
) => {
  const set: Record<string, number | string> = {}
  for (const r of usableFiatRates(fiatRates))
    set[`rates.${r.asset}`] = r.usdRate
  if (!Object.keys(set).length) return
  await models.fxRateDay
    .updateOne(
      { day: utcDay(now) },
      { $set: { ...set, source: 'live', updated: new Date() } },
      { upsert: true },
    )
    .catch((e) => logger.error(`${logPrefix} record day: ${e?.message ?? e}`))
}

/**
 * Fills the days missing since the last stored one (or since
 * FX_HISTORY_START) from the ECB series. Existing days are never overwritten,
 * so it is safe to run on every rate refresh; it only calls out when there is
 * a gap of more than a day.
 */
export const backfillFxHistory = async (now = Date.now()) => {
  try {
    const today = utcDay(now)
    const first = await models.fxRateDay
      .findOne({}, { day: 1 })
      .sort({ day: 1 })
      .lean()
    const lastBeforeToday = await models.fxRateDay
      .findOne({ day: { $lt: today } }, { day: 1 })
      .sort({ day: -1 })
      .lean()
    const from =
      !first || first.day > FX_HISTORY_START + 7 * DAY_MS
        ? FX_HISTORY_START
        : lastBeforeToday
          ? lastBeforeToday.day + DAY_MS
          : FX_HISTORY_START
    if (from >= today) return
    // A week of lead so the first days carry a real Friday rate forward.
    const series = await fetchEcbSeries(from - 7 * DAY_MS, today)
    const days = carryForwardDays(series, from, today - DAY_MS)
    if (!days.length) return
    const res = await models.fxRateDay.bulkWrite(
      days.map((d) => ({
        updateOne: {
          filter: { day: d.day },
          update: {
            $setOnInsert: {
              day: d.day,
              rates: d.rates,
              source: 'ecb',
              created: new Date(),
              updated: new Date(),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    )
    logger.info(
      `${logPrefix} backfilled ${res.upsertedCount} day(s) from ${isoDay(from)}`,
    )
  } catch (e) {
    logger.error(`${logPrefix} backfill: ${(e as Error)?.message ?? e}`)
  }
}

const cache = new Map<
  string,
  { at: number; days: { day: number; usdRate: number }[] }
>()
const CACHE_MS = 10 * 60 * 1000

/** Stored daily rates of one currency ("1 unit = X USD"), cached 10 min. */
export const readFxDays = async (
  code: string,
): Promise<{ day: number; usdRate: number }[]> => {
  const hit = cache.get(code)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.days
  const docs = await models.fxRateDay
    .find(
      {
        day: { $gte: FX_HISTORY_START - 14 * DAY_MS },
        [`rates.${code}`]: { $gt: 0 },
      },
      { day: 1, [`rates.${code}`]: 1 },
    )
    .lean<Pick<FxRateDaySchema, 'day' | 'rates'>[]>()
    .catch((e) => {
      logger.error(`${logPrefix} read ${code}: ${e?.message ?? e}`)
      return []
    })
  const days = docs
    .map((d) => {
      const rates = d.rates as unknown as
        | Record<string, number>
        | Map<string, number>
        | undefined
      const usdRate =
        rates instanceof Map ? rates.get(code) : (rates?.[code] as number)
      return { day: d.day, usdRate: Number(usdRate) }
    })
    .filter((d) => d.usdRate > 0)
  cache.set(code, { at: Date.now(), days })
  return days
}

/**
 * Units of `code` per USD for every day from FX_HISTORY_START to today, for
 * `reportingProfitExpr`. `todayUnitsPerUsd` (the dashboard's rate) fills the
 * series when nothing is stored yet.
 */
export const reportingRateSeries = async (
  code: string,
  todayUnitsPerUsd: number,
  now = Date.now(),
): Promise<{ from: number; rates: number[] }> => {
  const days = await readFxDays(code)
  return {
    from: FX_HISTORY_START,
    rates: dailyUnitsPerUsd(days, FX_HISTORY_START, now, todayUnitsPerUsd),
  }
}
