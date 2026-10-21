import axios from 'axios'
import type { FiatRateSource, RateSchema } from '../../types'

export type FiatRate = NonNullable<RateSchema['fiatRates']>[number]

/**
 * The cached fiat rates worth handing to a caller: an entry without an asset
 * or with a non-positive rate would value a holding at 0 (or divide by 0 when
 * a client converts USD into that fiat), so it is dropped rather than passed
 * through. Rates are "1 unit of `asset` = `usdRate` USD".
 */
export const usableFiatRates = (
  fiatRates: RateSchema['fiatRates'] | null | undefined,
): FiatRate[] =>
  (fiatRates ?? []).filter(
    (f): f is FiatRate =>
      !!f?.asset && typeof f.usdRate === 'number' && f.usdRate > 0,
  )

/**
 * Fiat currencies a user can pick as their dashboard reporting currency (USD is
 * implicit). Every one of these is kept in the rate doc: Kraken prices the few
 * it lists live, the rest come from a daily reference source. Most are on the
 * ECB list (Frankfurter); the last few only exist on open.er-api.com.
 */
export const REPORTING_FIATS = [
  'EUR',
  'GBP',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'NZD',
  'SGD',
  'HKD',
  'IDR',
  'MYR',
  'THB',
  'PHP',
  'KRW',
  'INR',
  'CNY',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'HUF',
  'RON',
  'TRY',
  'ILS',
  'ZAR',
  'BRL',
  'MXN',
  'AED',
  'VND',
  'NGN',
  'ARS',
  'UAH',
]

export const isReportingCurrency = (code: string): boolean =>
  code === 'USD' || REPORTING_FIATS.includes(code)

/** Units of each currency per 1 USD, as a reference source quotes them. */
export type PerUsdRates = Record<string, number>

const REFERENCE_TIMEOUT_MS = 15_000

const validPerUsd = (raw: Record<string, unknown> | undefined): PerUsdRates =>
  Object.fromEntries(
    Object.entries(raw ?? {}).filter(
      ([, v]) => typeof v === 'number' && isFinite(v) && v > 0,
    ),
  ) as PerUsdRates

/** ECB reference rates (weekdays, ~16:00 CET), keyless. */
export const fetchFrankfurter = async (): Promise<PerUsdRates> => {
  const res = await axios.get<{ rates?: Record<string, unknown> }>(
    'https://api.frankfurter.dev/v1/latest?base=USD',
    { timeout: REFERENCE_TIMEOUT_MS },
  )
  return validPerUsd(res.data?.rates)
}

/** exchangerate-api open endpoint (daily, 160+ currencies), keyless. */
export const fetchOpenErApi = async (): Promise<PerUsdRates> => {
  const res = await axios.get<{
    result?: string
    rates?: Record<string, unknown>
  }>('https://open.er-api.com/v6/latest/USD', {
    timeout: REFERENCE_TIMEOUT_MS,
  })
  if (res.data?.result !== 'success') {
    throw new Error(`open.er-api result=${res.data?.result}`)
  }
  return validPerUsd(res.data?.rates)
}

export type ReferenceRates = {
  ecb: PerUsdRates
  erApi: PerUsdRates
  errors: string[]
}

/**
 * Both reference sources, each allowed to fail on its own. open.er-api is only
 * asked when the ECB set leaves a reporting currency uncovered — which is
 * always (AED, VND…), so in practice both are called once per run.
 */
export const fetchReferenceRates = async (
  fetchers: {
    ecb: () => Promise<PerUsdRates>
    erApi: () => Promise<PerUsdRates>
  } = { ecb: fetchFrankfurter, erApi: fetchOpenErApi },
): Promise<ReferenceRates> => {
  const errors: string[] = []
  const ecb = await fetchers.ecb().catch((e) => {
    errors.push(`frankfurter: ${e?.message ?? e}`)
    return {} as PerUsdRates
  })
  const needsFallback = REPORTING_FIATS.some((a) => !ecb[a])
  const erApi = needsFallback
    ? await fetchers.erApi().catch((e) => {
        errors.push(`open.er-api: ${e?.message ?? e}`)
        return {} as PerUsdRates
      })
    : {}
  return { ecb, erApi, errors }
}

/**
 * Builds the fiat rate list for the new rate doc. For each currency, in order:
 * the live Kraken rate, then the ECB reference rate, then open.er-api, and only
 * then the previous entry, which is carried forward with its old `updated` so
 * the staleness check (main-app `fxRatesHealth`) can see it has stopped moving.
 * Assets Kraken priced that are not reporting currencies are kept as they are.
 */
export const mergeFiatRates = (
  kraken: { asset: string; usdRate: number }[],
  reference: Pick<ReferenceRates, 'ecb' | 'erApi'>,
  previous: RateSchema['fiatRates'] | null | undefined,
  now: Date = new Date(),
): FiatRate[] => {
  const assets = [
    ...REPORTING_FIATS,
    ...kraken.map((k) => k.asset).filter((a) => !REPORTING_FIATS.includes(a)),
  ]
  const out: FiatRate[] = []
  for (const asset of assets) {
    const live = kraken.find((k) => k.asset === asset && k.usdRate > 0)
    const fromRef = (source: FiatRateSource, perUsd?: number) =>
      perUsd ? { asset, usdRate: 1 / perUsd, source, updated: now } : null
    const entry: FiatRate | null =
      (live && {
        asset,
        usdRate: live.usdRate,
        source: 'kraken' as const,
        updated: now,
      }) ||
      fromRef('ecb', reference.ecb[asset]) ||
      fromRef('erApi', reference.erApi[asset]) ||
      usableFiatRates(previous).find((p) => p.asset === asset) ||
      null
    if (entry) out.push(entry)
  }
  return out
}
