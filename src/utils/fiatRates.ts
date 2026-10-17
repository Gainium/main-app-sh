import type { RateSchema } from '../../types'

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
