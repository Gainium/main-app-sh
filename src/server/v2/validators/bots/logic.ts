import { globalVarsDb, pairDb } from '../../../../db/dbInit'
import {
  BotStartTypeEnum,
  CloseConditionEnum,
  CreateComboBotInput,
  CreateDCABotInput,
  CreateGridBotInput,
  DCAConditionEnum,
  IndicatorAction,
  IndicatorEnum,
  IndicatorSection,
  RRSlTypeEnum,
  ScaleDcaTypeEnum,
  StartConditionEnum,
  StatusEnum,
  StrategyEnum,
  TerminalDealTypeEnum,
} from '../../../../../types'
import { ValidationResult } from './config'
import { CreateDCABotInputRaw } from '../../api'
import { DCA_FORM_DEFAULTS } from '../../botDefaults'
import { Types } from 'mongoose'
import { isXperpPair } from '../../../../bot/utils'

const indicatorsCheck: {
  condition: (input: CreateDCABotInput) => boolean
  verify: (input: CreateDCABotInput) => boolean
  errorMessage: string
}[] = [
  {
    condition: (input: CreateDCABotInput) =>
      input.startCondition === StartConditionEnum.ti,
    verify: (input: CreateDCABotInput) => {
      const findIndicators = input.indicators?.filter(
        (indicator) => indicator.indicatorAction === IndicatorAction.startDeal,
      )
      return !!findIndicators && findIndicators.length > 0
    },
    errorMessage:
      'At least one indicator with action "startDeal" is required when startCondition is "ti"',
  },
  {
    condition: (input: CreateDCABotInput) =>
      input.dealCloseCondition === CloseConditionEnum.techInd ||
      input.dealCloseCondition === CloseConditionEnum.dynamicAr,
    verify: (input: CreateDCABotInput) => {
      const findIndicators = input.indicators?.filter(
        (indicator) =>
          (input.dealCloseCondition === CloseConditionEnum.dynamicAr
            ? indicator.type === IndicatorEnum.adr ||
              indicator.type === IndicatorEnum.atr
            : true) &&
          indicator.indicatorAction === IndicatorAction.closeDeal &&
          indicator.section !== IndicatorSection.sl,
      )
      return !!findIndicators && findIndicators.length > 0
    },
    errorMessage:
      'At least one indicator with action "closeDeal" is required when dealCloseCondition is "techInd"',
  },
  {
    condition: (input: CreateDCABotInput) =>
      input.dealCloseConditionSL === CloseConditionEnum.techInd ||
      input.dealCloseConditionSL === CloseConditionEnum.dynamicAr,
    verify: (input: CreateDCABotInput) => {
      const findIndicators = input.indicators?.filter(
        (indicator) =>
          (input.dealCloseConditionSL === CloseConditionEnum.dynamicAr
            ? indicator.type === IndicatorEnum.adr ||
              indicator.type === IndicatorEnum.atr
            : true) &&
          indicator.indicatorAction === IndicatorAction.closeDeal &&
          indicator.section === IndicatorSection.sl,
      )
      return !!findIndicators && findIndicators.length > 0
    },
    errorMessage:
      'At least one indicator with action "closeDeal" and section "sl" is required when dealCloseConditionSL is "techInd"',
  },
  {
    condition: (input: CreateDCABotInput) =>
      input.dcaCondition === DCAConditionEnum.indicators ||
      input.scaleDcaType === ScaleDcaTypeEnum.adr ||
      input.scaleDcaType === ScaleDcaTypeEnum.atr,
    verify: (input: CreateDCABotInput) => {
      const findIndicators = input.indicators?.filter(
        (indicator) =>
          (input.scaleDcaType === ScaleDcaTypeEnum.adr
            ? indicator.type === IndicatorEnum.adr
            : input.scaleDcaType === ScaleDcaTypeEnum.atr
              ? indicator.type === IndicatorEnum.atr
              : true) &&
          indicator.indicatorAction === IndicatorAction.startDca &&
          indicator.section === IndicatorSection.dca,
      )
      return !!findIndicators && findIndicators.length > 0
    },
    errorMessage:
      'At least one indicator with action "startDca" and section "dca" is required when dcaCondition is "indicators"',
  },
  {
    condition: (input: CreateDCABotInput) =>
      input.botStart === BotStartTypeEnum.indicators,
    verify: (input: CreateDCABotInput) => {
      const findIndicators = input.indicators?.filter(
        (indicator) => indicator.indicatorAction === IndicatorAction.stopBot,
      )
      return !!findIndicators && findIndicators.length > 0
    },
    errorMessage:
      'At least one indicator with action "stopBot" is required when botStart is "indicators"',
  },
  {
    condition: (input: CreateDCABotInput) =>
      input.botActualStart === BotStartTypeEnum.indicators,
    verify: (input: CreateDCABotInput) => {
      const findIndicators = input.indicators?.filter(
        (indicator) => indicator.indicatorAction === IndicatorAction.startBot,
      )
      return !!findIndicators && findIndicators.length > 0
    },
    errorMessage:
      'At least one indicator with action "startBot" is required when botActualStart is "indicators"',
  },
  {
    condition: (input: CreateDCABotInput) =>
      !!input.useRiskReward && input.rrSlType !== RRSlTypeEnum.fixed,
    verify: (input: CreateDCABotInput) => {
      const findIndicators = input.indicators?.filter(
        (indicator) => indicator.indicatorAction === IndicatorAction.riskReward,
      )
      return !!findIndicators && findIndicators.length > 0
    },
    errorMessage:
      'At least one indicator with action "riskReward" is required when useRiskReward is true',
  },
]

export const validateCreateDCABotInputLogic = async <
  T extends CreateDCABotInput,
>(
  input: T,
  originalInput: CreateDCABotInputRaw,
  userId: string,
): Promise<ValidationResult<T>> => {
  const response: ValidationResult<T> = {
    valid: true,
    errors: [],
    data: JSON.parse(JSON.stringify(input)) as T,
  }
  const readPairsForExchange = await pairDb.readData(
    {
      exchange: input.exchange,
    },
    { pair: 1, 'baseAsset.name': 1, 'quoteAsset.name': 1 },
    {},
    true,
  )

  if (readPairsForExchange.status === StatusEnum.notok) {
    response.valid = false
    response.errors.push([
      'exchange',
      `Failed to validate pairs for exchange ${input.exchange}: ${readPairsForExchange.reason}`,
    ])
    return response
  }

  const foundPairs = input.pair
    .map((p) => {
      // X-Perp pairs (e.g. `AAVE-USD_UM_XPERP`) are already the canonical
      // exchange-native pair string; splitting on `_` would tear the
      // `_UM_XPERP` contract-type suffix apart instead of base/quote.
      if (isXperpPair(p)) {
        return readPairsForExchange.data.result.find((pair) => pair.pair === p)
      }
      const [base, quote] = p.split('_')
      return readPairsForExchange.data.result.find(
        (pair) =>
          pair.baseAsset.name === base && pair.quoteAsset.name === quote,
      )
    })
    .filter((p) => p !== undefined)
  if (foundPairs.length > 1 && !input.useMulti) {
    response.errors.push([
      'useMulti',
      `Multiple pairs are provided but useMulti is not enabled. Please enable useMulti to use multiple pairs in the same bot.`,
    ])
  }
  if (foundPairs.length !== input.pair.length) {
    const invalidPairs = input.pair.filter(
      (p) =>
        !foundPairs.find(
          (fp) =>
            fp.pair === p ||
            `${fp.baseAsset.name}_${fp.quoteAsset.name}` === p,
        ),
    )
    response.errors.push([
      'pair',
      `The following pairs are invalid for exchange ${input.exchange}: ${invalidPairs.join(
        ', ',
      )}`,
    ])
  } else {
    if (input.useMulti) {
      if (input.strategy === StrategyEnum.long) {
        const quoteAssets = new Set(foundPairs.map((p) => p.quoteAsset.name))
        if (quoteAssets.size !== 1) {
          response.errors.push([
            'pair',
            `For multi-pair strategy, all pairs must have the same quote asset. Found quote assets: ${[...quoteAssets].join(', ')}`,
          ])
        }
      }
      if (input.strategy === StrategyEnum.short) {
        const baseAssets = new Set(foundPairs.map((p) => p.baseAsset.name))
        if (baseAssets.size !== 1) {
          response.errors.push([
            'pair',
            `For multi-pair strategy, all pairs must have the same base asset. Found base assets: ${[...baseAssets].join(', ')}`,
          ])
        }
      }
    }
    response.data.pair = foundPairs.map((p) => p.pair)
  }
  if (
    input.useMulti &&
    (input.botStart === BotStartTypeEnum.indicators ||
      input.botActualStart === BotStartTypeEnum.indicators ||
      input.botStart === BotStartTypeEnum.price ||
      input.botActualStart === BotStartTypeEnum.price)
  ) {
    response.errors.push([
      'useMulti',
      `Indicator or price-based bot start conditions are not supported when useMulti is enabled. Please choose a different bot start condition or disable useMulti.`,
    ])
  }
  if (input.indicators.length > 20) {
    response.errors.push([
      'indicators',
      `A maximum of 20 indicators is allowed. Currently provided: ${input.indicators.length}`,
    ])
  }
  if (response.data.pair.length > 500) {
    response.errors.push([
      'pair',
      `A maximum of 500 pairs is allowed. Currently provided: ${response.data.pair.length}`,
    ])
  }
  indicatorsCheck.forEach((check) => {
    if (check.condition(input) && !check.verify(input)) {
      response.errors.push(['indicators', check.errorMessage])
    }
  })

  if (
    indicatorsCheck.every((check) => !check.condition(input)) &&
    input.indicators.length > 0
  ) {
    response.errors.push([
      'indicators',
      `Indicators are provided but none of the conditions for using indicators are met. Please review your configuration.`,
    ])
  }

  const indicatorGroupIds = input.indicatorGroups.map((group) => group.id)
  const duplicateGroupIds = indicatorGroupIds.filter(
    (id, index) => indicatorGroupIds.indexOf(id) !== index,
  )
  if (duplicateGroupIds.length > 0) {
    response.errors.push([
      'indicatorGroups',
      `Duplicate indicator group IDs found: ${[...new Set(duplicateGroupIds)].join(', ')}`,
    ])
  }
  const indicatorIds = input.indicators.map((indicator) => indicator.uuid)
  const duplicateIndicatorIds = indicatorIds.filter(
    (id, index) => indicatorIds.indexOf(id) !== index,
  )
  if (duplicateIndicatorIds.length > 0) {
    response.errors.push([
      'indicators',
      `Duplicate indicator IDs found: ${[...new Set(duplicateIndicatorIds)].join(', ')}`,
    ])
  }
  const indicatorsWithoutGroup = input.indicators.filter(
    (indicator) =>
      indicator.groupId &&
      !input.indicatorGroups.find(
        (group) =>
          group.id === indicator.groupId &&
          group.action === indicator.indicatorAction &&
          group.section === indicator.section,
      ),
  )
  if (indicatorsWithoutGroup.length > 0) {
    response.errors.push([
      'indicators',
      `The following indicators reference non-existent groups: ${indicatorsWithoutGroup
        .map((indicator) => indicator.uuid)
        .join(', ')}`,
    ])
  }
  const groupsWithoutIndicators = input.indicatorGroups.filter(
    (group) =>
      !input.indicators.find(
        (indicator) =>
          indicator.groupId === group.id &&
          indicator.indicatorAction === group.action &&
          indicator.section === group.section,
      ),
  )
  if (groupsWithoutIndicators.length > 0) {
    response.errors.push([
      'indicatorGroups',
      `The following groups have no indicators referencing them: ${groupsWithoutIndicators
        .map((group) => group.id)
        .join(', ')}`,
    ])
  }

  if (input.useMultiTp && !input.multiTp?.length) {
    response.errors.push([
      'multiTp',
      `Multi TP is enabled but no TP values provided in multiTp array.`,
    ])
  }
  if (input.useMultiSl && !input.multiSl?.length) {
    response.errors.push([
      'multiSl',
      `Multi SL is enabled but no SL values provided in multiSl array.`,
    ])
  }
  if (
    input.dcaCondition === DCAConditionEnum.custom &&
    input.useDca &&
    !input.dcaCustom?.length
  ) {
    response.errors.push([
      'dcaCustom',
      `DCA condition is set to custom and DCA is enabled but no DCA conditions provided in dcaCustom array.`,
    ])
  }

  const multiTpIds = input.multiTp?.map((tp) => tp.uuid) || []
  const multiSlIds = input.multiSl?.map((sl) => sl.uuid) || []
  const dcaCustomIds = input.dcaCustom?.map((dca) => dca.uuid) || []
  const duplicateMultiTpIds = multiTpIds.filter(
    (id, index) => multiTpIds.indexOf(id) !== index,
  )
  const duplicateMultiSlIds = multiSlIds.filter(
    (id, index) => multiSlIds.indexOf(id) !== index,
  )
  const duplicateDcaCustomIds = dcaCustomIds.filter(
    (id, index) => dcaCustomIds.indexOf(id) !== index,
  )
  if (duplicateMultiTpIds.length > 0) {
    response.errors.push([
      'multiTp',
      `Duplicate UUIDs found in multiTp array: ${[...new Set(duplicateMultiTpIds)].join(', ')}`,
    ])
  }
  if (duplicateMultiSlIds.length > 0) {
    response.errors.push([
      'multiSl',
      `Duplicate UUIDs found in multiSl array: ${[...new Set(duplicateMultiSlIds)].join(', ')}`,
    ])
  }
  if (duplicateDcaCustomIds.length > 0) {
    response.errors.push([
      'dcaCustom',
      `Duplicate UUIDs found in dcaCustom array: ${[...new Set(duplicateDcaCustomIds)].join(', ')}`,
    ])
  }

  if (input.moveSL && input.trailingSl) {
    response.errors.push([
      'moveSL',
      `Move SL cannot be used together with Trailing SL. Please choose one of these options.`,
    ])
  }

  if (
    originalInput.useRiskReward &&
    (originalInput.useDca || originalInput.useSl || originalInput.useTp)
  ) {
    response.errors.push([
      'useRiskReward',
      'Risk/Reward cannot be used together with DCA, SL or TP. Please choose one of these options.',
    ])
  } else {
    response.data.useRiskReward = originalInput.useRiskReward
    response.data.useDca = false
    response.data.useSl = false
    response.data.useTp = false
  }

  if (input.vars?.paths.length) {
    if (input.vars.paths.some((v) => !v.path || !v.variable)) {
      response.errors.push([
        'vars.paths',
        `Each variable path entry must have both 'path' and 'variable' properties. Please review your input.`,
      ])
    } else {
      const validKeys = Object.keys(DCA_FORM_DEFAULTS)
      const invalidPaths = input.vars.paths.filter(
        (p) => !validKeys.includes(p.path.split('.')[0]),
      )
      if (invalidPaths.length > 0) {
        response.errors.push([
          'vars.paths',
          `The following variable paths are invalid: ${invalidPaths
            .map((p) => p.path)
            .join(
              ', ',
            )}. Valid paths must start with one of the following: ${validKeys.join(', ')}`,
        ])
      }
      const validSubPaths = ['indicators', 'multiTp', 'multiSl', 'dcaCustom']
      const invalidSubPaths = input.vars.paths.filter((p) => {
        const split = p.path.split('.')
        if (split.length > 1) {
          if (split.length !== 3) {
            return true
          } else {
            const [group, uuid, key] = split
            if (!validSubPaths.includes(group)) {
              return true
            } else {
              if (group === 'indicators') {
                const found = input.indicators.find(
                  (indicator) => indicator.uuid === uuid,
                )
                if (!found) {
                  return true
                } else {
                  return !Object.keys(found).includes(key)
                }
              }
              if (group === 'multiTp') {
                const found = input.multiTp?.find((tp) => tp.uuid === uuid)
                if (!found) {
                  return true
                } else {
                  return !Object.keys(found).includes(key)
                }
              }
              if (group === 'multiSl') {
                const found = input.multiSl?.find((sl) => sl.uuid === uuid)
                if (!found) {
                  return true
                } else {
                  return !Object.keys(found).includes(key)
                }
              }
              if (group === 'dcaCustom') {
                const found = input.dcaCustom?.find((dca) => dca.uuid === uuid)
                if (!found) {
                  return true
                } else {
                  return !Object.keys(found).includes(key)
                }
              }
            }
          }
        }
      })
      if (invalidSubPaths.length > 0) {
        response.errors.push([
          'vars.paths',
          `The following variable paths are invalid: ${invalidSubPaths
            .map((p) => p.path)
            .join(', ')}. Valid sub-paths are: ${validSubPaths.join(', ')}`,
        ])
      }

      const searchForVars = await globalVarsDb.readData(
        {
          userId,
          _id: {
            $in: input.vars.list.map((v) => {
              try {
                return new Types.ObjectId(v)
              } catch {
                return null
              }
            }),
          },
        },
        {},
        {},
        true,
      )
      if (searchForVars.status === StatusEnum.notok) {
        response.errors.push([
          'vars.list',
          `Failed to validate variable IDs: ${searchForVars.reason}`,
        ])
      } else {
        const missedVars = input.vars.list.filter((v) => {
          return !searchForVars.data.result.find(
            (sv) => sv._id.toString() === v,
          )
        })
        if (missedVars.length > 0) {
          response.errors.push([
            'vars.list',
            `The following variable IDs were not found: ${missedVars.join(', ')}`,
          ])
        }
      }
    }
  }

  response.valid = response.errors.length === 0
  return response
}

export const validateCreateComboBotInputLogic = async (
  input: CreateComboBotInput,
  originalInput: CreateDCABotInputRaw,
  userId: string,
): Promise<ValidationResult<CreateComboBotInput>> => {
  return await validateCreateDCABotInputLogic(input, originalInput, userId)
}

export const validateCreateTerminalDealInputLogic = async (
  input: CreateDCABotInput,
  originalInput: CreateDCABotInputRaw,
  userId: string,
): Promise<ValidationResult<CreateDCABotInput>> => {
  const dcaLogicResult = await validateCreateDCABotInputLogic(
    input,
    originalInput,
    userId,
  )

  if (input.useSl && input.useFixedSLPrices) {
    if (input.useMultiSl) {
      const findTragetsWithoutPrice = input.multiSl?.filter(
        (sl) => sl.fixed === undefined,
      )
      if (findTragetsWithoutPrice && findTragetsWithoutPrice.length > 0) {
        dcaLogicResult.errors.push([
          'multiSl',
          `All SL targets must have a fixed price defined when useFixedSLPrices is enabled. Please review your multiSl configuration.`,
        ])
      }
    } else {
      if (input.fixedSlPrice === undefined) {
        dcaLogicResult.errors.push([
          'fixedSlPrice',
          `A fixed SL price must be defined when useFixedSLPrices is enabled. Please provide a fixedSlPrice value.`,
        ])
      }
    }
  }

  if (input.useTp && input.useFixedTPPrices) {
    if (input.useMultiTp) {
      const findTragetsWithoutPrice = input.multiTp?.filter(
        (sl) => sl.fixed === undefined,
      )
      if (findTragetsWithoutPrice && findTragetsWithoutPrice.length > 0) {
        dcaLogicResult.errors.push([
          'multiTp',
          `All TP targets must have a fixed price defined when useFixedTPPrices is enabled. Please review your multiTp configuration.`,
        ])
      }
    } else {
      if (input.fixedTpPrice === undefined) {
        dcaLogicResult.errors.push([
          'fixedTpPrice',
          `A fixed TP price must be defined when useFixedTPPrices is enabled. Please provide a fixedTpPrice value.`,
        ])
      }
    }
  }

  if (input.terminalDealType === TerminalDealTypeEnum.simple && input.futures) {
    dcaLogicResult.errors.push([
      'terminalDealType',
      `Simple terminal deals are not supported for futures. Please choose a different terminal deal type or choose other exchange.`,
    ])
  }

  dcaLogicResult.valid = dcaLogicResult.errors.length === 0
  return dcaLogicResult
}

export const validateCreateGridBotInputLogic = async (
  input: CreateGridBotInput,
): Promise<ValidationResult<CreateGridBotInput>> => {
  const response: ValidationResult<CreateGridBotInput> = {
    valid: true,
    errors: [],
    data: JSON.parse(JSON.stringify(input)) as CreateGridBotInput,
  }

  if (+input.topPrice <= +input.lowPrice) {
    response.errors.push([
      'topPrice',
      `Top price must be greater than low price`,
    ])
  }

  if (
    input.useOrderInAdvance &&
    +input.levels < +(input.ordersInAdvance || 0)
  ) {
    response.errors.push([
      'ordersInAdvance',
      `Orders in advance must be less than or equal to levels`,
    ])
  }
  // X-Perp pairs (e.g. `AAVE-USD_UM_XPERP`) are already the canonical
  // exchange-native pair string; splitting on `_` would tear the
  // `_UM_XPERP` contract-type suffix apart instead of base/quote.
  const pairFilter = isXperpPair(input.pair)
    ? { exchange: input.exchange, pair: input.pair }
    : (() => {
        const [base, quote] = input.pair.split('_')
        return {
          exchange: input.exchange,
          'baseAsset.name': base.trim(),
          'quoteAsset.name': quote.trim(),
        }
      })()
  const readPairForExchange = await pairDb.readData<{ pair: string }>(
    pairFilter,
    { pair: 1 },
  )

  if (readPairForExchange.status === StatusEnum.notok) {
    response.valid = false
    response.errors.push([
      'exchange',
      `Failed to validate pairs for exchange ${input.exchange}: ${readPairForExchange.reason}`,
    ])
    return response
  }
  const foundPair = readPairForExchange.data.result
  if (!foundPair) {
    response.errors.push([
      'pair',
      `The pair ${input.pair} is invalid for exchange ${input.exchange}`,
    ])
  } else {
    response.data.pair = foundPair.pair
  }
  response.valid = response.errors.length === 0
  return response
}
