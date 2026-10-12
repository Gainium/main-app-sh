import { IndicatorsLogicEnum } from '../../types'

/**
 * Whether a set of indicator groups (one action, one section) has triggered.
 *
 * Each group can carry `join`: the AND/OR attaching it to the group before it
 * (ignored on the first group). AND binds tighter than OR, as usually read:
 * `A or B and C` is `A or (B and C)`. A group without `join` uses the
 * bot-level logic (`startDealLogic`, `stopDealLogic`, ...), so bots saved
 * before per-group joins evaluate exactly as they did.
 *
 * The backtester carries an identical copy (src/dca/strategy/ti/groupLogic.ts);
 * keep both in step or live and backtest results diverge.
 */
export const combineIndicatorGroups = (
  groups: ReadonlyArray<{ join?: IndicatorsLogicEnum | string | null }>,
  results: ReadonlyArray<boolean>,
  botLogic?: IndicatorsLogicEnum | string | null,
): boolean => {
  if (!results.length) {
    return false
  }
  const fallback =
    botLogic === IndicatorsLogicEnum.or
      ? IndicatorsLogicEnum.or
      : IndicatorsLogicEnum.and
  let anyTerm = false
  let term = !!results[0]
  for (let i = 1; i < results.length; i++) {
    const join = groups[i]?.join || fallback
    if (join === IndicatorsLogicEnum.or) {
      anyTerm = anyTerm || term
      term = !!results[i]
    } else {
      term = term && !!results[i]
    }
  }
  return anyTerm || term
}

/**
 * Whether any two groups of the set are joined by AND, i.e. indicators must
 * hold together (used to wait for lower-timeframe siblings). Same fallback as
 * combineIndicatorGroups: no per-group joins means the bot-level logic decides.
 */
export const groupsJoinedByAnd = (
  groups: ReadonlyArray<{ join?: IndicatorsLogicEnum | string | null }>,
  botLogic?: IndicatorsLogicEnum | string | null,
): boolean => {
  const fallbackIsAnd = !botLogic || botLogic === IndicatorsLogicEnum.and
  if (groups.length < 2 || !groups.some((group) => group.join)) {
    return fallbackIsAnd
  }
  return groups
    .slice(1)
    .some((group) =>
      group.join ? group.join === IndicatorsLogicEnum.and : fallbackIsAnd,
    )
}

/**
 * Whether the group `groupId` forms an OR-term on its own — joined by OR on
 * both sides (or at an end) — so it alone can satisfy the set. Without
 * per-group joins this is the old rule: the bot-level logic is OR.
 */
export const groupStandsAlone = (
  groups: ReadonlyArray<{
    id: string
    join?: IndicatorsLogicEnum | string | null
  }>,
  groupId: string | undefined,
  botLogic?: IndicatorsLogicEnum | string | null,
): boolean => {
  const botIsOr = botLogic === IndicatorsLogicEnum.or
  const index = groupId ? groups.findIndex((g) => g.id === groupId) : -1
  if (index === -1 || !groups.some((group) => group.join)) {
    return botIsOr
  }
  const fallback = botIsOr ? IndicatorsLogicEnum.or : IndicatorsLogicEnum.and
  const before =
    index > 0 ? groups[index].join || fallback : IndicatorsLogicEnum.or
  const after =
    index < groups.length - 1
      ? groups[index + 1].join || fallback
      : IndicatorsLogicEnum.or
  return before === IndicatorsLogicEnum.or && after === IndicatorsLogicEnum.or
}
