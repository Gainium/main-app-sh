import {
  DCABotSettings,
  DCAConditionEnum,
  IndicatorAction,
  IndicatorEnum,
  IndicatorSection,
  IndicatorsLogicEnum,
  ScaleDcaTypeEnum,
  SettingsIndicators,
} from '../../types'
import { v4 as uuidv4 } from 'uuid'
import { indicatorConfigDefaults } from '../server/v2/botDefaults'

/**
 * True when the engine will price this bot's DCA ladder off a dynamic ATR/ADR
 * level rather than a fixed percentage.
 *
 * MUST stay identical to `this.scaleAr` in `bot/dcaHelper.ts` — that is the
 * consumer this whole module exists to satisfy. If the two drift, a bot is
 * seeded with an indicator the engine ignores, or (worse) the engine demands
 * levels nothing ever seeded.
 */
export const scalesOnDynamicAr = (settings: Partial<DCABotSettings>): boolean =>
  !!settings.useDca &&
  (settings.dcaCondition === DCAConditionEnum.percentage ||
    !settings.dcaCondition) &&
  (settings.scaleDcaType === ScaleDcaTypeEnum.atr ||
    settings.scaleDcaType === ScaleDcaTypeEnum.adr)

/**
 * Dynamic ATR/ADR order spacing is driven by exactly one `startDca` ATR/ADR
 * indicator: `dcaHelper.getDynamicLevels` reads it to price the ladder, and
 * `openNewDeal` refuses to open anything when it yields no levels.
 *
 * Both dashboards seed that indicator as a side-effect of the "Base scaling on"
 * *field-change event*, so any write that does not pass through that exact
 * event — the public v2 API, a clone, an agent tool, or a form submit that
 * never touched the field — can persist `scaleDcaType: atr` with no indicator
 * behind it. Such a bot can never open a deal, on any pair, for its whole life,
 * and the dashboard hides the ATR panel when the indicator is absent, so its
 * owner cannot repair it either.
 *
 * Enforce the pairing on the way in instead, at the one place every write path
 * meets. Returns the settings unchanged when the pairing is already sound, so
 * it is safe to call on every save.
 *
 * Bug #463.
 */
export const ensureDynamicArIndicator = <T extends Partial<DCABotSettings>>(
  settings: T,
): T => {
  if (!scalesOnDynamicAr(settings)) {
    return settings
  }
  const indicators = settings.indicators ?? []
  if (indicators.some((i) => i.indicatorAction === IndicatorAction.startDca)) {
    return settings
  }
  const type =
    settings.scaleDcaType === ScaleDcaTypeEnum.adr
      ? IndicatorEnum.adr
      : IndicatorEnum.atr
  const groups = settings.indicatorGroups ?? []
  let group = groups.find((g) => g.action === IndicatorAction.startDca)
  let indicatorGroups = groups
  if (!group) {
    group = {
      id: uuidv4(),
      logic: IndicatorsLogicEnum.and,
      action: IndicatorAction.startDca,
      section: IndicatorSection.dca,
    }
    indicatorGroups = [...groups, group]
  }
  const seeded = {
    ...(indicatorConfigDefaults[type] ?? {}),
    type,
    indicatorAction: IndicatorAction.startDca,
    section: IndicatorSection.dca,
    dynamicArFactor: '1',
    uuid: uuidv4(),
    groupId: group.id,
  } as SettingsIndicators
  return { ...settings, indicators: [...indicators, seeded], indicatorGroups }
}
