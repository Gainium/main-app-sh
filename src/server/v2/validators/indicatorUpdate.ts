import { BotVars, DCABotSettings, StatusEnum } from '../../../../types'
import { addIndicatorsDefaults } from '../helpers'
import {
  indicatorCoreConfig,
  indicatorGroupConfig,
  validateNestedObjects,
} from './bots/config'
import { indicatorConsistencyErrors, requiredIndicatorErrors } from './logic'

const INDICATOR_KEYS = ['indicators', 'indicatorGroups'] as const
// Updatable conditions that can require an indicator: a `ti` deal start and
// indicator-driven safety orders.
const CONDITION_KEYS = ['startCondition', 'dcaCondition'] as const

type IndicatorUpdateResult<T> =
  | { status: StatusEnum.ok; settings: T; vars?: BotVars | null }
  | {
      status: StatusEnum.notok
      reason: string
      errors: [string, string][]
    }

const withoutMongoId = <T>(item: T): T => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return item
  }
  const { _id: _ignored, ...rest } = item as T & { _id?: unknown }
  return rest as T
}

/**
 * Validate and normalise an update or clone body that sets `indicators` /
 * `indicatorGroups` on a DCA or Combo bot (REST v1 + v2).
 *
 * Each array is a full replacement — there is no merge by uuid. A caller that
 * wants to keep an indicator sends it back with its `uuid`.
 *
 * - The items are checked against the same schema bot creation uses, after
 *   the same per-type defaults are filled in, so a minimal indicator works
 *   here exactly as it does on create. A stored subdocument `_id` is dropped
 *   so a read → modify → write round trip is accepted.
 * - The cross-field rules (a `ti` start needs a `startDeal` indicator, group
 *   references resolve, …) run on the stored settings merged with the update,
 *   because the condition and its indicator can sit on either side of it.
 * - Variable links into a removed indicator (`indicators.{uuid}.{key}`) are
 *   dropped from `vars`; a link into a kept uuid stays.
 *
 * An update that touches neither array is returned unchanged — unless it
 * switches `startCondition` / `dcaCondition`, in which case the result must
 * still have an indicator for every indicator-driven condition it uses.
 */
export const applyIndicatorSettingsUpdate = <T extends Partial<DCABotSettings>>(
  current: DCABotSettings,
  update: T,
  vars?: BotVars | null,
): IndicatorUpdateResult<T> => {
  if (!INDICATOR_KEYS.some((k) => k in update)) {
    const errors = CONDITION_KEYS.some((k) => k in update)
      ? requiredIndicatorErrors({ ...current, ...update })
      : []
    return errors.length
      ? { status: StatusEnum.notok, reason: 'Validation error', errors }
      : { status: StatusEnum.ok, settings: update, vars }
  }

  const errors: [string, string][] = []
  for (const key of INDICATOR_KEYS) {
    if (key in update && !Array.isArray(update[key])) {
      errors.push([key, `Field ${key} must be an array`])
    }
  }
  if (errors.length) {
    return { status: StatusEnum.notok, reason: 'Validation error', errors }
  }

  let settings = { ...update }
  if (settings.indicators) {
    settings.indicators = settings.indicators.map(withoutMongoId)
    settings = addIndicatorsDefaults(settings)
    errors.push(
      ...validateNestedObjects(
        settings.indicators ?? [],
        'indicators',
        indicatorCoreConfig,
      ),
    )
  }
  if (settings.indicatorGroups) {
    settings.indicatorGroups = settings.indicatorGroups.map(withoutMongoId)
    errors.push(
      ...validateNestedObjects(
        settings.indicatorGroups,
        'indicatorGroups',
        indicatorGroupConfig,
      ),
    )
  }
  if (errors.length) {
    return { status: StatusEnum.notok, reason: 'Validation error', errors }
  }

  errors.push(...indicatorConsistencyErrors({ ...current, ...settings }))
  if (errors.length) {
    return { status: StatusEnum.notok, reason: 'Validation error', errors }
  }

  return {
    status: StatusEnum.ok,
    settings,
    vars: settings.indicators ? pruneIndicatorVars(vars, settings) : vars,
  }
}

const pruneIndicatorVars = (
  vars: BotVars | null | undefined,
  settings: Partial<DCABotSettings>,
): BotVars | null | undefined => {
  if (!vars?.paths?.length) {
    return vars
  }
  const kept = new Set((settings.indicators ?? []).map((i) => i.uuid))
  const paths = vars.paths.filter((p) => {
    const [group, uuid] = p.path.split('.')
    return group !== 'indicators' || kept.has(uuid)
  })
  const used = new Set(paths.map((p) => p.variable))
  return { list: vars.list.filter((v) => used.has(v)), paths }
}
