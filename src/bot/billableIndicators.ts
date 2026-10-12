import { DCAConditionEnum, IndicatorAction } from '../../types'

/**
 * How many indicators a bot counts as, for its credit cost and for the
 * `indicatorsLimit` cap.
 *
 * With DCA by indicators each `startDca` indicator is one ladder level, and a
 * deal only ever subscribes the one of its next level, so the whole ladder
 * counts as ONE indicator however many levels it has. Every other indicator
 * counts once.
 */
export const billableIndicators = (
  settings?: {
    indicators?: { indicatorAction?: IndicatorAction }[] | null
    dcaCondition?: DCAConditionEnum | null
  } | null,
): number => {
  const all = settings?.indicators ?? []
  if (settings?.dcaCondition !== DCAConditionEnum.indicators) {
    return all.length
  }
  const ladder = all.filter(
    (i) => i.indicatorAction === IndicatorAction.startDca,
  ).length
  return all.length - ladder + (ladder > 0 ? 1 : 0)
}
