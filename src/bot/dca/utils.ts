import {
  BotType,
  CleanComboDealsSchema,
  CooldownUnits,
  IndicatorAction,
} from '../../../types'

import type {
  ComboBotSettings,
  DCABotSettings,
  CleanDCADealsSchema,
} from '../../../types'

class DCAUtils {
  convertCooldown(interval?: number, units?: CooldownUnits) {
    if (!interval || !units) {
      return 0
    }
    return (
      interval *
      (units === CooldownUnits.seconds
        ? 1000
        : units === CooldownUnits.minutes
          ? 60 * 1000
          : units === CooldownUnits.hours
            ? 60 * 60 * 1000
            : 24 * 60 * 60 * 1000)
    )
  }

  checkCooldown(last: number, cooldown: number) {
    const time = +new Date()
    const diff = time - last
    const status = diff >= cooldown
    return { status, time, last, diff, cooldown }
  }

  checkCooldownStart(
    settings:
      | Partial<ComboBotSettings & CleanDCADealsSchema['settings']>
      | Partial<DCABotSettings & CleanDCADealsSchema['settings']>,
    last: number,
  ) {
    const result = {
      status: true,
      time: 0,
      last: 0,
      diff: 0,
      cooldown: 0,
    }
    if (settings.cooldownAfterDealStart && settings.useCooldown) {
      return this.checkCooldown(
        last,
        this.convertCooldown(
          settings.cooldownAfterDealStartInterval,
          settings.cooldownAfterDealStartUnits,
        ),
      )
    }
    return result
  }

  checkCooldownStop(
    settings:
      | Partial<ComboBotSettings & CleanDCADealsSchema['settings']>
      | Partial<DCABotSettings & CleanDCADealsSchema['settings']>,
    last: number,
  ) {
    const result = {
      status: true,
      time: 0,
      last: 0,
      diff: 0,
      cooldown: 0,
    }
    if (settings.cooldownAfterDealStop && settings.useCooldown) {
      return this.checkCooldown(
        last,
        this.convertCooldown(
          settings.cooldownAfterDealStopInterval,
          settings.cooldownAfterDealStopUnits,
        ),
      )
    }
    return result
  }

  getInitalDealSettings(
    type: BotType.combo,
    settings: ComboBotSettings,
  ): CleanComboDealsSchema['settings']
  getInitalDealSettings(
    type: BotType.dca,
    settings: DCABotSettings,
  ): CleanDCADealsSchema['settings']
  getInitalDealSettings(
    type: BotType,
    settings: DCABotSettings | ComboBotSettings,
  ): CleanDCADealsSchema['settings'] | CleanComboDealsSchema['settings'] {
    const prepareSettings: CleanDCADealsSchema['settings'] = {
      changed: false,
      ordersCount: settings.ordersCount,
      baseOrderPrice: settings.baseOrderPrice,
      useLimitPrice: settings.useLimitPrice,
      startOrderType: settings.startOrderType,
      tpPerc: settings.tpPerc,
      profitCurrency: settings.profitCurrency,
      avgPrice: 0,
      baseOrderSize: settings.baseOrderSize,
      orderSize: settings.orderSize,
      useTp: settings.useTp,
      useDca: settings.useDca,
      useSl: settings.useSl,
      slPerc: settings.slPerc,
      useSmartOrders: settings.useSmartOrders,
      activeOrdersCount: settings.activeOrdersCount,
      orderSizePercQty: 0,
      trailingSl: settings.trailingSl,
      moveSL: settings.moveSL,
      moveSLTrigger: settings.moveSLTrigger,
      moveSLValue: settings.moveSLValue,
      moveSLForAll: settings.moveSLForAll,
      trailingTp: settings.trailingTp,
      trailingTpPerc: settings.trailingTpPerc,
      useMinTP: settings.useMinTP,
      minTp: settings.minTp,
      orderSizeType: settings.orderSizeType,
      useMultiSl: settings.useMultiSl,
      multiSl: settings.multiSl,
      useMultiTp: settings.useMultiTp,
      multiTp: settings.multiTp,
      volumeScale: settings.volumeScale,
      stepScale: settings.stepScale,
      minimumDeviation: settings.minimumDeviation,
      step: settings.step,
      dealCloseCondition: settings.dealCloseCondition,
      dealCloseConditionSL: settings.dealCloseConditionSL,
      futures: settings.futures,
      coinm: settings.coinm,
      marginType: settings.marginType,
      leverage: settings.leverage,
      gridLevel: settings.gridLevel,
      dcaCondition: settings.dcaCondition,
      dcaCustom: settings.dcaCustom,
      dcaIndicatorLevels: (settings.indicators ?? [])
        .filter((i) => i.indicatorAction === IndicatorAction.startDca)
        .map((i) => ({
          orderSize: i.orderSize,
          minPercFromLast: i.minPercFromLast,
        })),
      closeByTimer: settings.closeByTimer,
      closeByTimerUnits: settings.closeByTimerUnits,
      closeByTimerValue: settings.closeByTimerValue,
      comboTpBase: settings.comboTpBase,
      fixedSlPrice: settings.fixedSlPrice,
      fixedTpPrice: settings.fixedTpPrice,
      comboSmartGridsCount: settings.comboSmartGridsCount,
      comboUseSmartGrids: settings.comboUseSmartGrids,
      comboActiveMinigrids: settings.comboActiveMinigrids,
      useActiveMinigrids: settings.useActiveMinigrids,
      baseSlOn: settings.baseSlOn,
      dcaVolumeBaseOn: settings.dcaVolumeBaseOn,
      dcaVolumeMaxValue: settings.dcaVolumeMaxValue,
      dcaVolumeRequiredChange: settings.dcaVolumeRequiredChange,
      dcaByMarket: settings.dcaByMarket,
    }
    if (type === BotType.dca) {
      const set = settings as ComboBotSettings
      return {
        ...prepareSettings,
        gridLevel: set.gridLevel,
        closeOrderType: set.closeOrderType,
      } as CleanComboDealsSchema['settings']
    }
    return prepareSettings
  }
}

export default DCAUtils
