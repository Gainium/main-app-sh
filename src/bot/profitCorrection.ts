/**
 * Out-of-band corrections to a running DCA bot's realized-profit aggregate
 * (core spec 239).
 *
 * A DCA worker owns `data.profit` while it runs: every booking adds to the
 * in-memory object and `$set`s it whole, and a service restart restores it
 * from the bot's Redis snapshot rather than from the database. A database
 * write to a running bot's profit is therefore overwritten at its next
 * booking. A correction has to be added to the worker's own copy, which is
 * what `applyProfitCorrection` on the DCA helper does with these helpers.
 *
 * Pure: no I/O.
 */

export const PROFIT_CORRECTION_FIELDS = [
  'total',
  'totalUsd',
  'pureBase',
  'pureQuote',
] as const

export type ProfitCorrectionDelta = Record<
  (typeof PROFIT_CORRECTION_FIELDS)[number],
  number
>

type BotProfit = {
  total: number
  totalUsd: number
  freeTotal?: number
  freeTotalUsd?: number
  pureBase?: number
  pureQuote?: number
}

/** Longest correction id accepted; ids are recorded on the bot for good. */
export const PROFIT_CORRECTION_ID_MAX = 64

/**
 * Why a correction request cannot be applied, or null when it can. Every
 * delta field must be a finite number (a NaN would poison the aggregate the
 * same way a NaN booking does), and the id must be a short non-empty string.
 */
export const invalidProfitCorrection = (
  delta: unknown,
  correctionId: unknown,
): string | null => {
  if (
    typeof correctionId !== 'string' ||
    !correctionId.trim() ||
    correctionId.length > PROFIT_CORRECTION_ID_MAX
  ) {
    return 'correction id must be a non-empty string'
  }
  if (!delta || typeof delta !== 'object') {
    return 'delta must be an object'
  }
  for (const k of PROFIT_CORRECTION_FIELDS) {
    const v = (delta as Record<string, unknown>)[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return `delta.${k} must be a finite number`
    }
  }
  return null
}

/** The bot profit with `delta` added; every other field is kept as is. */
export const addProfitCorrection = <P extends BotProfit>(
  profit: P,
  delta: ProfitCorrectionDelta,
): P => ({
  ...profit,
  total: (profit.total ?? 0) + delta.total,
  totalUsd: (profit.totalUsd ?? 0) + delta.totalUsd,
  pureBase: (profit.pureBase ?? 0) + delta.pureBase,
  pureQuote: (profit.pureQuote ?? 0) + delta.pureQuote,
})
