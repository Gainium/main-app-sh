import {
  IndicatorAction,
  IndicatorsLogicEnum,
  type SettingsIndicatorGroup,
  type SettingsIndicators,
} from '../../../types'
import { combineIndicatorGroups } from '../../utils/indicatorGroupLogic'

/**
 * DCA by indicators: the ladder levels.
 *
 * A level is one safety order (its own size and minimum % from the last fill)
 * placed when its conditions match. Its conditions are `startDca` indicators
 * sharing `dcaLevel`, arranged in `startDca` groups carrying the same
 * `dcaLevel` — the AND/OR group editor every other indicator section uses.
 *
 * Bots saved before per-level conditions have one `startDca` indicator per
 * level and no `dcaLevel`: the indicator is the level, keyed by its `uuid`,
 * so those bots read exactly as before. Levels are ordered by the first
 * appearance of their key in `indicators`.
 *
 * The level's size and minimum % live on its anchor: the indicator whose
 * `uuid` is the level key, else the level's first indicator.
 *
 * The backtester carries an identical copy (src/dca/strategy/ti/levels.ts,
 * tests in test/dca-indicator-levels.spec.ts); keep both in step or live and
 * backtest ladders diverge.
 */
type LevelIndicator = Pick<
  SettingsIndicators,
  'uuid' | 'indicatorAction' | 'dcaLevel'
>

export type StartDcaLevel<T extends LevelIndicator> = {
  key: string
  anchor: T
  indicators: T[]
}

export const dcaLevelKey = (indicator: LevelIndicator): string =>
  indicator.dcaLevel || indicator.uuid

export function startDcaLevels<T extends LevelIndicator>(
  indicators: ReadonlyArray<T> | null | undefined,
): StartDcaLevel<T>[] {
  const order: string[] = []
  const byKey = new Map<string, T[]>()
  for (const indicator of indicators ?? []) {
    if (indicator.indicatorAction !== IndicatorAction.startDca) {
      continue
    }
    const key = dcaLevelKey(indicator)
    let list = byKey.get(key)
    if (!list) {
      list = []
      byKey.set(key, list)
      order.push(key)
    }
    list.push(indicator)
  }
  return order.map((key) => {
    const list = byKey.get(key) ?? []
    return {
      key,
      anchor: list.find((i) => i.uuid === key) ?? list[0],
      indicators: list,
    }
  })
}

/** One indicator per level: the one holding its size and minimum %. */
export const startDcaLevelAnchors = <T extends LevelIndicator>(
  indicators: ReadonlyArray<T> | null | undefined,
): T[] => startDcaLevels(indicators).map((level) => level.anchor)

/** The `startDca` groups holding level `key`'s conditions, in order. */
export const startDcaLevelGroups = <
  G extends Pick<SettingsIndicatorGroup, 'action' | 'dcaLevel'>,
>(
  groups: ReadonlyArray<G> | null | undefined,
  key: string,
): G[] =>
  (groups ?? []).filter(
    (group) =>
      group.action === IndicatorAction.startDca && group.dcaLevel === key,
  )

/**
 * Whether a level's conditions hold.
 *
 * - `isActive(uuid)`: the indicator's condition is currently met.
 * - `isLoaded(uuid)`: the indicator is subscribed and has data. An AND group
 *   with a leg that is not loaded cannot pass: the surviving legs alone would
 *   otherwise satisfy it (same rule as deal start).
 *
 * A level without groups (bots saved before per-level conditions) fires when
 * its indicator does. Groups combine with their own `join`; a group without
 * one joins with AND.
 */
export function dcaLevelTriggered<
  T extends LevelIndicator & Pick<SettingsIndicators, 'groupId'>,
  G extends Pick<SettingsIndicatorGroup, 'id' | 'logic' | 'join'>,
>(
  level: StartDcaLevel<T>,
  groups: ReadonlyArray<G>,
  isActive: (uuid: string) => boolean,
  isLoaded: (uuid: string) => boolean = () => true,
): boolean {
  const used = groups.filter((group) =>
    level.indicators.some((i) => i.groupId === group.id),
  )
  if (!used.length) {
    return level.indicators.some((i) => isActive(i.uuid))
  }
  const results = used.map((group) => {
    const legs = level.indicators.filter((i) => i.groupId === group.id)
    const active = legs.filter((i) => isActive(i.uuid))
    return group.logic === IndicatorsLogicEnum.or
      ? active.length > 0
      : active.length === legs.length && legs.every((i) => isLoaded(i.uuid))
  })
  return combineIndicatorGroups(used, results, IndicatorsLogicEnum.and)
}
