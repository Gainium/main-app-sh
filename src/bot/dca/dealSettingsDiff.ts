/**
 * Which of a deal's own settings differ from its bot's (main-app spec 250).
 *
 * A deal keeps a full copy of its settings. After a person edits the deal, the
 * keys returned here are what the dashboard marks the deal "edited" with and
 * lists in the tooltip. Compared by value, not by reference: lists and objects
 * (multi-target TP/SL, execution blocks, indicator ladders) are equal when
 * their contents are, and `'3'` equals `3`.
 */

/** Bookkeeping on the deal, never a setting a person chose. */
const INTERNAL_KEYS = new Set([
  'avgPrice',
  'changed',
  'changedKeys',
  'slChangedByUser',
  'updatedComboAdjustments',
])

const DCA_KEYS = [
  'ordersCount',
  'orderSize',
  'useSmartOrders',
  'activeOrdersCount',
  'stepScale',
  'volumeScale',
]
/**
 * Keys a deal can hold that its bot never carries, and that a person sets on
 * the deal itself. Any other key the bot lacks is a deal-side copy or
 * bookkeeping (indicator ladder copy, sizing cache) and is not compared.
 */
const DEAL_ONLY_KEYS = new Set(['dcaLevelsCap'])

/**
 * Execution blocks are newer than the fields they mirror (`closeOrderType`,
 * `dcaByMarket`, `closeDealType`, …), and both are written together. A bot
 * saved before the blocks existed has none, so when either side lacks the
 * block it is not compared: the mirrored fields carry the difference.
 */
const EXECUTION_KEYS = new Set(['dcaExecution', 'tpExecution', 'slExecution'])

const TP_KEYS = [
  'tpPerc',
  'trailingTp',
  'trailingTpPerc',
  'useMinTP',
  'minTp',
  'multiTp',
  'useMultiTp',
]
const SL_KEYS = [
  'slPerc',
  'trailingSl',
  'moveSL',
  'moveSLTrigger',
  'moveSLValue',
  'useMultiSl',
  'multiSl',
]

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === '' ||
  v === false ||
  (Array.isArray(v) && v.length === 0)

/** Stable form for comparison: sorted keys, no Mongo `_id`s, primitives as text. */
const normalize = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v.map(normalize)
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      if (k === '_id' || k === '__typename') {
        continue
      }
      const inner = (v as Record<string, unknown>)[k]
      if (inner === undefined || inner === null) {
        continue
      }
      out[k] = normalize(inner)
    }
    return out
  }
  return v === undefined || v === null ? null : `${v}`
}

export const sameSettingValue = (a: unknown, b: unknown): boolean => {
  if (isEmpty(a) && isEmpty(b)) {
    return true
  }
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

/**
 * Keys whose deal value differs from the bot's. A key the bot does not carry
 * counts only for deal-only settings (the DCA levels cap) holding a value.
 * Settings that are off on both — DCA, take profit, stop loss — do not
 * count their sub-settings.
 */
export const dealSettingsDiffFromBot = (
  deal: Record<string, unknown>,
  bot: Record<string, unknown> | undefined,
): string[] => {
  const botSettings = bot ?? {}
  const offOnBoth = (flag: string) => !deal[flag] && !botSettings[flag]
  const smartOffOnBoth =
    !!deal['useDca'] &&
    !!botSettings['useDca'] &&
    !deal['useSmartOrders'] &&
    !botSettings['useSmartOrders']
  const out: string[] = []
  for (const k of Object.keys(deal)) {
    if (INTERNAL_KEYS.has(k)) continue
    if (offOnBoth('useDca') && DCA_KEYS.includes(k)) continue
    if (smartOffOnBoth && k === 'activeOrdersCount') continue
    if (offOnBoth('useTp') && TP_KEYS.includes(k)) continue
    if (offOnBoth('useSl') && SL_KEYS.includes(k)) continue
    // The single-target form echoes its target into the list while multiple
    // targets are off; the list only matters when they are on.
    if (k === 'multiTp' && offOnBoth('useMultiTp')) continue
    if (k === 'multiSl' && offOnBoth('useMultiSl')) continue
    if (
      EXECUTION_KEYS.has(k) &&
      (isEmpty(deal[k]) || isEmpty(botSettings[k]))
    ) {
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(botSettings, k)) {
      if (DEAL_ONLY_KEYS.has(k) && !isEmpty(deal[k])) out.push(k)
      continue
    }
    if (!sameSettingValue(deal[k], botSettings[k])) {
      out.push(k)
    }
  }
  return out.sort()
}
