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

/**
 * A fill a running GRID bot never booked, carried by its profit correction
 * (core spec 284). The worker folds it into the counters a booking moves:
 * `transactionsCount`, the futures `position`, `feePaid`, and the hourly
 * account profit at `updateTime`.
 */
export type GridCorrectionFill = {
  clientOrderId: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  /** The venue's fill time (ms). */
  updateTime: number
  /** The fee the booking would have recorded, per `createTransaction`. */
  fee: { base: number; quote: number }
}

/**
 * Why a GRID correction cannot be applied, or null when it can. A grid bot
 * writes `pureBase`/`pureQuote` as 0 on every booking, so a non-zero delta
 * there would be wiped by the next one; it is refused instead.
 */
export const invalidGridProfitCorrection = (
  delta: unknown,
  correctionId: unknown,
  fill?: unknown,
): string | null => {
  const invalid = invalidProfitCorrection(delta, correctionId)
  if (invalid) {
    return invalid
  }
  const d = delta as ProfitCorrectionDelta
  if (d.pureBase !== 0 || d.pureQuote !== 0) {
    return 'a grid bot keeps no pureBase/pureQuote; both must be 0'
  }
  if (fill === undefined) {
    return null
  }
  const f = fill as Partial<GridCorrectionFill>
  if (!f || typeof f !== 'object') {
    return 'fill must be an object'
  }
  if (typeof f.clientOrderId !== 'string' || !f.clientOrderId) {
    return 'fill.clientOrderId must be a non-empty string'
  }
  if (f.side !== 'BUY' && f.side !== 'SELL') {
    return 'fill.side must be BUY or SELL'
  }
  for (const k of ['qty', 'price', 'updateTime'] as const) {
    const v = f[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      return `fill.${k} must be a positive number`
    }
  }
  for (const k of ['base', 'quote'] as const) {
    const v = f.fee?.[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return `fill.fee.${k} must be a non-negative number`
    }
  }
  return null
}

/**
 * The grid bot profit with `delta` added. A grid booking moves `freeTotal` /
 * `freeTotalUsd` by the same amount as `total` / `totalUsd` whenever it has no
 * separate free match (every futures booking), so the correction does too.
 */
export const addGridProfitCorrection = <
  P extends BotProfit & { freeTotal?: number; freeTotalUsd?: number },
>(
  profit: P,
  delta: ProfitCorrectionDelta,
): P => ({
  ...profit,
  total: (profit.total ?? 0) + delta.total,
  totalUsd: (profit.totalUsd ?? 0) + delta.totalUsd,
  // `||`, as `createTransaction` falls back: a 0 freeTotal reads total.
  freeTotal: (profit.freeTotal || profit.total || 0) + delta.total,
  freeTotalUsd: (profit.freeTotalUsd || profit.totalUsd || 0) + delta.totalUsd,
})
