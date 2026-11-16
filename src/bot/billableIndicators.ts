import { DCAConditionEnum, IndicatorAction } from '../../types'

/**
 * How many indicators a bot counts as, for its credit cost and for the
 * `indicatorsLimit` cap.
 *
 * With DCA by indicators a deal only ever subscribes the conditions of its
 * NEXT ladder level (spec 244: a level is the `startDca` indicators sharing
 * `dcaLevel`, or one indicator without it). So the ladder counts as its
 * LARGEST level: that many indicators are ever subscribed at once for it,
 * and locking them up front means the bot can always afford the level it
 * reaches. A ladder of single-indicator levels counts as one. Every other
 * indicator counts once.
 *
 * The dashboard mirrors this (main-dash-sh `utils/bots/credits.ts`).
 */
export const billableIndicators = (
  settings?: {
    indicators?:
      | {
          indicatorAction?: IndicatorAction
          uuid?: string
          dcaLevel?: string
        }[]
      | null
    dcaCondition?: DCAConditionEnum | null
  } | null,
): number => {
  const all = settings?.indicators ?? []
  if (settings?.dcaCondition !== DCAConditionEnum.indicators) {
    return all.length
  }
  const ladder = all.filter(
    (i) => i.indicatorAction === IndicatorAction.startDca,
  )
  const levelSizes = new Map<string, number>()
  ladder.forEach((i, n) => {
    const key = i.dcaLevel || i.uuid || `#${n}`
    levelSizes.set(key, (levelSizes.get(key) ?? 0) + 1)
  })
  const largestLevel = Math.max(0, ...levelSizes.values())
  return all.length - ladder.length + largestLevel
}
