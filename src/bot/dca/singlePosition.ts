/**
 * Single position per pair — the pure rules (spec 139). No I/O: the engine
 * (`dcaHelper`), the bot service (`index.ts`) and the v2 validators call these
 * with plain settings / deal shapes.
 */
import { CooldownUnits, DCATypeEnum, StartConditionEnum } from '../../../types'

/** Spec 139 §7.2. */
export const SINGLE_POSITION_ASAP_SPACING_REASON =
  'Single position with ASAP needs a dynamic price filter or a cooldown after deal start'

/** Spec 139 §2.3.3. */
export const SINGLE_POSITION_CLOSE_AFTER_OPENED_REASON =
  'Single position cannot be combined with "Close after X deals opened": a position does not re-open per signal. Use close after X closed, won or lost instead'

/** Spec 139 §5.1.4. */
export const SINGLE_POSITION_START_BOT_REASON =
  'Start the bot to switch it to single position'

/** Spec 139 §5.1.2 — followed by the comma-separated pair symbols. */
export const SINGLE_POSITION_MULTIPLE_OPEN_PREFIX =
  'Single position: more than one open deal on '

export const singlePositionMultipleOpenReason = (symbols: string[]) =>
  `${SINGLE_POSITION_MULTIPLE_OPEN_PREFIX}${symbols.join(', ')}`

/** Spec 139 §2.4 / §4.1. */
export const SINGLE_POSITION_ADOPT_COMBO_REASON =
  'Adopting deals is not available for combo bots'
export const SINGLE_POSITION_ADOPT_HEDGE_REASON =
  'Adopting deals is not available for hedge bots'

type SpacingSettings = {
  singlePosition?: boolean
  startCondition?: StartConditionEnum | string
  useDynamicPriceFilter?: boolean
  dynamicPriceFilterDeviation?: string
  dynamicPriceFilterOverValue?: string
  dynamicPriceFilterUnderValue?: string
  useCooldown?: boolean
  cooldownAfterDealStart?: boolean
  cooldownAfterDealStartInterval?: number | string
  cooldownAfterDealStartUnits?: CooldownUnits | string
  useBotController?: boolean
  useCloseAfterXopen?: boolean
  type?: DCATypeEnum | string
}

const positive = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(`${v ?? ''}`)
  return Number.isFinite(n) && n > 0
}

/**
 * §7.1: a dynamic price filter with a deviation. The engine only arms the
 * filter (and the ASAP price trigger) when `dynamicPriceFilterDeviation` is
 * set; over / under values without it leave the filter off.
 */
export const hasDynamicSpacing = (s: SpacingSettings) =>
  !!s.useDynamicPriceFilter && positive(s.dynamicPriceFilterDeviation)

/** §7.1: a cooldown after deal start with an interval. */
export const hasStartCooldown = (s: SpacingSettings) =>
  !!s.useCooldown &&
  !!s.cooldownAfterDealStart &&
  positive(s.cooldownAfterDealStartInterval) &&
  !!s.cooldownAfterDealStartUnits

/**
 * Spec 139 §7 and §2.3.3: why these (merged) bot settings cannot run as a
 * single-position bot, or null. Off → null, whatever else is set.
 */
export const singlePositionSettingsError = (
  s: SpacingSettings,
): string | null => {
  if (!s.singlePosition) {
    return null
  }
  if (s.useBotController && s.useCloseAfterXopen) {
    return SINGLE_POSITION_CLOSE_AFTER_OPENED_REASON
  }
  if (
    s.startCondition === StartConditionEnum.asap &&
    !hasDynamicSpacing(s) &&
    !hasStartCooldown(s)
  ) {
    return SINGLE_POSITION_ASAP_SPACING_REASON
  }
  return null
}

/**
 * Spec 139 §2.2: the entry limit, or 0 for none. '' / '0' / missing /
 * unparsable → no limit.
 */
export const maxPositionEntriesOf = (v: unknown): number => {
  const n = Math.floor(parseFloat(`${v ?? ''}`))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Entries a position holds — §3.4.1: missing means the base order alone. */
export const positionEntriesOf = (deal: { positionEntries?: number }) => {
  const n = Number(deal.positionEntries)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/** §3.2.2: the position is full. */
export const positionIsFull = (
  deal: { positionEntries?: number },
  maxPositionEntries: unknown,
) => {
  const max = maxPositionEntriesOf(maxPositionEntries)
  return max > 0 && positionEntriesOf(deal) >= max
}

/**
 * §5.1.2: the pairs holding more than one open deal, sorted. Input is one row
 * per open deal.
 */
export const pairsWithSeveralOpenDeals = (
  deals: { symbol?: { symbol?: string } | null }[],
): string[] => {
  const count = new Map<string, number>()
  for (const d of deals) {
    const s = d.symbol?.symbol
    if (s) {
      count.set(s, (count.get(s) ?? 0) + 1)
    }
  }
  return [...count.entries()]
    .filter(([, n]) => n > 1)
    .map(([s]) => s)
    .sort()
}

/**
 * §5.1.1: per pair, the oldest open deal is the position and the rest are
 * adopted into it.
 */
export const planPositionsByPair = <
  T extends { _id: string; createTime: number; symbol: { symbol: string } },
>(
  deals: T[],
): { symbol: string; target: T; sources: T[] }[] => {
  const bySymbol = new Map<string, T[]>()
  for (const d of deals) {
    bySymbol.set(d.symbol.symbol, [...(bySymbol.get(d.symbol.symbol) ?? []), d])
  }
  return [...bySymbol.entries()].map(([symbol, list]) => {
    const [target, ...sources] = [...list].sort(
      (a, b) =>
        (a.createTime ?? 0) - (b.createTime ?? 0) ||
        `${a._id}`.localeCompare(`${b._id}`),
    )
    return { symbol, target, sources }
  })
}

/** §5.1: the change turns single position on. */
export const turnsSinglePositionOn = (
  old: { singlePosition?: boolean },
  next: { singlePosition?: boolean },
) =>
  typeof next.singlePosition !== 'undefined' &&
  !old.singlePosition &&
  !!next.singlePosition

/** §2.5: the setting flips either way — a sizing change for `resetStatsAfter`. */
export const togglesSinglePosition = (
  old: { singlePosition?: boolean },
  next: { singlePosition?: boolean },
) =>
  typeof next.singlePosition !== 'undefined' &&
  !!old.singlePosition !== !!next.singlePosition
