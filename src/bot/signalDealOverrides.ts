import {
  BotType,
  CloseConditionEnum,
  type SignalDealOverrides,
} from '../../types'

export type { SignalDealOverrides }

/**
 * Per-deal settings a `startDeal` webhook may carry, replacing the bot's own
 * value for that one deal.
 *
 * Indicators that emit a signal usually emit its exits with it — an entry, a
 * stop and a target computed from the same bar. Without these, the only way to
 * honour them was a second alert per exit (`closeDeal` / `closeDealSl`) and a
 * bot configured to close by webhook. With them, the deal is opened with its
 * own targets and the bot places and manages them like any other.
 *
 * Every value is written into the deal's own settings snapshot when the deal is
 * created — the same snapshot a deal edit changes and that TP / SL / DCA
 * re-computation already reads (`getAggregatedSettings(deal)`). The bot's
 * settings are never touched, and the next deal opens with them again.
 */
export const SIGNAL_OVERRIDE_FIELDS = [
  'baseOrderSize',
  'tpPerc',
  'slPerc',
  'tpPrice',
  'slPrice',
] as const satisfies ReadonlyArray<keyof SignalDealOverrides>

type ParseResult =
  | { overrides: SignalDealOverrides | null; error?: undefined }
  | { overrides: null; error: string }

/**
 * Read and validate the override fields of a webhook payload.
 *
 * Accepts numbers and numeric strings — an alert template renders every
 * placeholder as text. A field that is present but not a positive number is an
 * error, not a field to skip: a template variable that rendered empty or as
 * `NaN` is the common cause, and opening the deal without the stop the sender
 * asked for is the one outcome worse than not opening it.
 */
export function parseSignalDealOverrides(
  data: Record<string, unknown> | undefined,
  botType: BotType | undefined,
): ParseResult {
  const overrides: SignalDealOverrides = {}
  for (const field of SIGNAL_OVERRIDE_FIELDS) {
    const raw = data?.[field]
    if (raw === undefined || raw === null) {
      continue
    }
    const value =
      typeof raw === 'number' || typeof raw === 'string'
        ? Number(`${raw}`.trim())
        : NaN
    const valid =
      `${raw}`.trim() !== '' &&
      Number.isFinite(value) &&
      // A stop loss is often written as a negative percentage, the way the
      // bot form shows it; either sign means the same distance.
      (field === 'slPerc' ? value !== 0 : value > 0)
    if (!valid) {
      return {
        overrides: null,
        error: `Invalid "${field}": ${JSON.stringify(raw)}. Expected a positive number.`,
      }
    }
    overrides[field] =
      field === 'slPerc' ? `${-Math.abs(value)}` : `${Math.abs(value)}`
  }
  if (overrides.tpPerc && overrides.tpPrice) {
    return {
      overrides: null,
      error: 'Send either "tpPerc" or "tpPrice", not both.',
    }
  }
  if (overrides.slPerc && overrides.slPrice) {
    return {
      overrides: null,
      error: 'Send either "slPerc" or "slPrice", not both.',
    }
  }
  if (
    (overrides.tpPrice || overrides.slPrice) &&
    botType !== undefined &&
    botType !== BotType.dca
  ) {
    return {
      overrides: null,
      error:
        '"tpPrice" and "slPrice" are only available for DCA bots. Use "tpPerc" and "slPerc" instead.',
    }
  }
  return {
    overrides: Object.keys(overrides).length ? overrides : null,
  }
}

export const hasSignalTpSl = (o?: SignalDealOverrides | null) =>
  !!(o?.tpPerc || o?.tpPrice || o?.slPerc || o?.slPrice)

/**
 * Why the signal's prices cannot be used at `price`: a take profit that is not
 * beyond the current price would fill as soon as it is placed, and a stop loss
 * that is not before it would close the deal at once. Both mean the signal is
 * stale or the template is wrong, so the deal is not opened.
 */
export function signalPriceError(
  o: SignalDealOverrides | null | undefined,
  price: number,
  isLong: boolean,
): string | undefined {
  if (!o || !(price > 0)) {
    return
  }
  const tp = o.tpPrice ? +o.tpPrice : undefined
  const sl = o.slPrice ? +o.slPrice : undefined
  if (tp !== undefined && (isLong ? tp <= price : tp >= price)) {
    return `take profit price ${tp} is not ${isLong ? 'above' : 'below'} the current price ${price}`
  }
  if (sl !== undefined && (isLong ? sl >= price : sl <= price)) {
    return `stop loss price ${sl} is not ${isLong ? 'below' : 'above'} the current price ${price}`
  }
}

type OverridableDealSettings = {
  tpPerc?: string
  slPerc?: string
  useTp?: boolean
  useSl?: boolean
  useMultiTp?: boolean
  useMultiSl?: boolean
  trailingSl?: boolean
  moveSL?: boolean
  dealCloseCondition?: CloseConditionEnum
  dealCloseConditionSL?: CloseConditionEnum
  useFixedTPPrices?: boolean
  useFixedSLPrices?: boolean
  fixedTpPrice?: string
  fixedSlPrice?: string
}

/**
 * The deal's initial settings with the signal's values written over them.
 *
 * A signal target replaces the bot's whole take-profit (or stop-loss) setup
 * for this deal, not just its number: a single target, closed by price, so a
 * bot that closes by webhook or indicator still gets the exit the signal asked
 * for, and multi-targets don't keep the bot's own levels alongside it. A fixed
 * stop loss is a price, so trailing and move-SL — which re-derive the stop from
 * a percentage — are off for it.
 *
 * `baseOrderSize` is deliberately NOT written here. The order is sized
 * through the new-deal size multiplier, which re-checks the balance and the
 * exchange minimums and can fall back to the configured size; the deal's
 * nominal `settings.baseOrderSize` feeds take-profit sizing, so it must keep
 * describing the size the multiplier was applied to.
 */
export function applySignalDealOverrides<T extends OverridableDealSettings>(
  settings: T,
  o?: SignalDealOverrides | null,
): T {
  if (!o) {
    return settings
  }
  const next: T = { ...settings }
  if (o.tpPerc || o.tpPrice) {
    next.useTp = true
    next.useMultiTp = false
    next.dealCloseCondition = CloseConditionEnum.tp
    if (o.tpPrice) {
      next.useFixedTPPrices = true
      next.fixedTpPrice = o.tpPrice
    } else {
      next.useFixedTPPrices = false
      next.tpPerc = o.tpPerc
    }
  }
  if (o.slPerc || o.slPrice) {
    next.useSl = true
    next.useMultiSl = false
    next.dealCloseConditionSL = CloseConditionEnum.tp
    if (o.slPrice) {
      next.useFixedSLPrices = true
      next.fixedSlPrice = o.slPrice
      next.trailingSl = false
      next.moveSL = false
    } else {
      next.useFixedSLPrices = false
      next.slPerc = o.slPerc
    }
  }
  return next
}
