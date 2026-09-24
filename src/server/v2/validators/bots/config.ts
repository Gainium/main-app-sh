import {
  BaseSlOnEnum,
  BotMarginTypeEnum,
  BotStartTypeEnum,
  BotStatusEnum,
  CloseConditionEnum,
  CloseDCATypeEnum,
  ComboTpBase,
  CooldownOptionsEnum,
  CooldownUnits,
  DCAConditionEnum,
  DCATypeEnum,
  DcaVolumeRequiredChangeRef,
  DCAVolumeType,
  DynamicPriceFilterDirectionEnum,
  DynamicPriceFilterPriceTypeEnum,
  IndicatorsLogicEnum,
  IndicatorStartConditionEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  PairPrioritizationEnum,
  RiskSlTypeEnum,
  RRSlTypeEnum,
  ScaleDcaTypeEnum,
  StartConditionEnum,
  StrategyEnum,
  TerminalDealTypeEnum,
  VolumeValueEnum,
  SettingsIndicatorGroup,
  MultiTP,
  DCACustom,
  IndicatorAction,
  IndicatorSection,
  IndicatorEnum,
  ExchangeIntervals,
  TradingviewAnalysisSignalEnum,
  TradingviewAnalysisConditionEnum,
  MAEnum,
  BBCrossingEnum,
  rsiValueEnum,
  rsiValue2Enum,
  SRCrossingEnum,
  StochRangeEnum,
  ECDTriggerEnum,
  DivTypeEnum,
  STConditionEnum,
  PCConditionEnum,
  ppValueEnum,
  ppValueTypeEnum,
  RangeType,
  DCValueEnum,
  OBFVGValueEnum,
  OBFVGRefEnum,
  TrendFilterOperatorEnum,
  SessionRuleEnum,
} from '../../../../../types'
import {
  COMBO_FORM_DEFAULTS,
  DCA_FORM_DEFAULTS,
  GRID_FORM_DEFAULTS,
} from '../../botDefaults'

export type ValidationResult<T> = {
  valid: boolean
  errors: [string, string][]
  data: T
}

export enum ValidatorsEnum {
  shouldBeString = 'shouldBeString',
  shouldBeNumber = 'shouldBeNumber',
  shouldBeBoolean = 'shouldBeBoolean',
  shouldBeArray = 'shouldBeArray',
  shouldBeValidEnumValue = 'shouldBeValidEnumValue',
  shouldBePositive = 'shouldBePositive',
  shouldBeNonNegative = 'shouldBeNonNegative',
  shouldBeInteger = 'shouldBeInteger',
  canBeEmptyString = 'canBeEmptyString',
  shouldBeValidNumber = 'shouldBeValidNumber',
  shouldBeNegative = 'shouldBeNegative',
  shouldBeDateString = 'shouldBeDateString',
}

export const maxStringLength = 200
export const maxPrecision = 12

// Field configurations for nested arrays
export type NestedFieldConfig = {
  required?: boolean
  validators: ValidatorsEnum[]
  enum?: readonly string[]
  min?: number
  max?: number
  maxPrecision?: number
  maxLength?: number
}

export const multiTPConfig: Record<keyof MultiTP, NestedFieldConfig> = {
  target: {
    required: true,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 8,
  },
  amount: {
    required: true,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 0,
    max: 100,
    maxPrecision: 2,
  },
  uuid: {
    required: true,
    validators: [ValidatorsEnum.shouldBeString],
    maxLength: 100,
  },
  fixed: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.canBeEmptyString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
    maxPrecision: 8,
  },
}

export const dcaCustomConfig: Record<keyof DCACustom, NestedFieldConfig> = {
  step: {
    required: true,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 4,
  },
  size: {
    required: true,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 8,
  },
  uuid: {
    required: true,
    validators: [ValidatorsEnum.shouldBeString],
    maxLength: 100,
  },
}

export const indicatorGroupConfig: Record<
  keyof SettingsIndicatorGroup,
  NestedFieldConfig
> = {
  id: {
    required: true,
    validators: [ValidatorsEnum.shouldBeString],
    maxLength: 100,
  },
  logic: {
    required: true,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorsLogicEnum),
  },
  action: {
    required: true,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorAction),
  },
  section: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorSection),
  },
}

// Complete field configuration for indicators
export const indicatorCoreConfig: Record<string, NestedFieldConfig> = {
  // Required fields
  type: {
    required: true,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorEnum),
  },
  indicatorLength: {
    required: true,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
    min: 1,
    max: 10000,
  },
  indicatorValue: {
    required: true,
    validators: [ValidatorsEnum.shouldBeString],
  },
  indicatorCondition: {
    required: true,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorStartConditionEnum),
  },
  indicatorInterval: {
    required: true,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(ExchangeIntervals),
  },
  groupId: {
    required: true,
    validators: [ValidatorsEnum.shouldBeString],
  },
  uuid: {
    required: true,
    validators: [ValidatorsEnum.shouldBeString],
    maxLength: 100,
  },
  indicatorAction: {
    required: true,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorAction),
  },

  // Optional fields
  signal: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(TradingviewAnalysisSignalEnum),
  },
  condition: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(TradingviewAnalysisConditionEnum),
  },
  checkLevel: {
    required: false,
    validators: [ValidatorsEnum.shouldBeNumber],
  },
  maType: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(MAEnum),
  },
  maCrossingValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(MAEnum),
  },
  maCrossingLength: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  maCrossingInterval: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(ExchangeIntervals),
  },
  maUUID: {
    required: false,
    validators: [ValidatorsEnum.shouldBeString],
    maxLength: 100,
  },
  bbCrossingValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(BBCrossingEnum),
  },
  stochSmoothK: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  stochSmoothD: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  stochUpper: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  stochLower: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  stochRSI: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  rsiValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(rsiValueEnum),
  },
  rsiValue2: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(rsiValue2Enum),
  },
  valueInsteadof: {
    required: false,
    validators: [ValidatorsEnum.shouldBeNumber],
  },
  leftBars: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeNonNegative,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  rightBars: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeNonNegative,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  srCrossingValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(SRCrossingEnum),
  },
  basePeriods: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  pumpPeriods: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  pump: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  interval: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  baseCrack: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  section: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorSection),
  },
  psarStart: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  psarInc: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  psarMax: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  stochRange: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(StochRangeEnum),
  },
  minPercFromLast: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  orderSize: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  keepConditionBars: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  voShort: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  voLong: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  uoFast: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  uoMiddle: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  uoSlow: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  momSource: {
    required: false,
    validators: [ValidatorsEnum.shouldBeString],
  },
  bbwpLookback: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  ecdTrigger: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(ECDTriggerEnum),
  },
  xOscillator1: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: [
      IndicatorEnum.rsi,
      IndicatorEnum.cci,
      IndicatorEnum.mfi,
      IndicatorEnum.vo,
    ],
  },
  xOscillator2: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: [
      IndicatorEnum.rsi,
      IndicatorEnum.cci,
      IndicatorEnum.mfi,
      IndicatorEnum.vo,
    ],
  },
  xOscillator2length: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  xOscillator2Interval: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(ExchangeIntervals),
  },
  xOscillator2voLong: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  xOscillator2voShort: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  xoUUID: {
    required: false,
    validators: [ValidatorsEnum.shouldBeString],
    maxLength: 100,
  },
  mar1length: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  mar1type: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(MAEnum),
  },
  mar2length: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  mar2type: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(MAEnum),
  },
  bbwMult: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  bbwMa: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(MAEnum),
  },
  bbwMaLength: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  macdFast: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  macdSlow: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  macdMaSource: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(MAEnum),
  },
  macdMaSignal: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(MAEnum),
  },
  divOscillators: {
    required: false,
    validators: [ValidatorsEnum.shouldBeArray],
  },
  divType: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(DivTypeEnum),
  },
  divMinCount: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  factor: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  atrLength: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  stCondition: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(STConditionEnum),
  },
  pcUp: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  pcDown: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  pcCondition: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(PCConditionEnum),
  },
  pcValue: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  ppHighLeft: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeNonNegative,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  ppHighRight: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeNonNegative,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  ppLowLeft: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeNonNegative,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  ppLowRight: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeNonNegative,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  ppMult: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  ppValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(ppValueEnum),
  },
  ppType: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(ppValueTypeEnum),
  },
  riskAtrMult: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  dynamicArFactor: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  athLookback: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  kcMa: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(MAEnum),
  },
  kcRange: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(RangeType),
  },
  kcRangeLength: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  unpnlValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeNumber],
  },
  unpnlCondition: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorStartConditionEnum),
  },
  dcValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(DCValueEnum),
  },
  obfvgValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(OBFVGValueEnum),
  },
  obfvgRef: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(OBFVGRefEnum),
  },
  sessionDays: {
    required: false,
    validators: [ValidatorsEnum.shouldBeArray],
  },
  sessionRule: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: [SessionRuleEnum.in, SessionRuleEnum.out],
  },
  lwThreshold: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  lwMaxDuration: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  lwValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['top', 'bottom', 'any'],
  },
  percentile: {
    required: false,
    validators: [ValidatorsEnum.shouldBeBoolean],
  },
  percentileLookback: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  percentilePercentage: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  trendFilter: {
    required: false,
    validators: [ValidatorsEnum.shouldBeBoolean],
  },
  trendFilterLookback: {
    required: false,
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
      ValidatorsEnum.shouldBeInteger,
    ],
  },
  trendFilterType: {
    required: false,
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(TrendFilterOperatorEnum),
  },
  trendFilterValue: {
    required: false,
    validators: [ValidatorsEnum.shouldBeNumber],
  },
}

// Generic nested object validator
export const validateNestedObjects = (
  items: any[],
  fieldName: string,
  config: Record<string, NestedFieldConfig>,
): [string, string][] => {
  const errors: [string, string][] = []

  items.forEach((item, index) => {
    const prefix = `${fieldName}[${index}]`

    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push([fieldName, `${prefix} must be an object`])
      return
    }

    // Check for unexpected fields
    Object.keys(item).forEach((key) => {
      if (!(key in config)) {
        errors.push([fieldName, `${prefix}.${key} is an unexpected field`])
      }
    })

    // Validate each configured field
    Object.entries(config).forEach(([key, fieldConfig]) => {
      const value = item[key]
      const fieldPath = `${prefix}.${key}`

      // Check required fields
      if (fieldConfig.required && (value === undefined || value === null)) {
        errors.push([fieldPath, `${fieldPath} is required`])
        return
      }

      // Skip validation for undefined optional fields
      if (value === undefined || value === null) {
        return
      }

      // Run validators
      fieldConfig.validators.forEach((validatorType) => {
        const validator = validators[validatorType]
        if (!validator) return

        let error: string | null = null

        if (validatorType === ValidatorsEnum.shouldBeValidEnumValue) {
          error = validator(value, fieldPath, fieldConfig.enum)
        } else if (validatorType === ValidatorsEnum.canBeEmptyString) {
          // Skip if empty string is allowed and it's empty
          if (typeof value === 'string' && value === '') return
        } else {
          error = validator(value, fieldPath)
        }

        if (error) {
          errors.push([fieldPath, error])
        }
      })

      // Additional constraints
      const isString = typeof value === 'string'
      const num = isString ? parseFloat(value) : value

      // Numeric min/max validation
      if (
        fieldConfig.min !== undefined &&
        typeof num === 'number' &&
        !isNaN(num)
      ) {
        if (num < fieldConfig.min) {
          errors.push([
            fieldPath,
            `${fieldPath} must be greater than or equal to ${fieldConfig.min}`,
          ])
        }
      }

      if (
        fieldConfig.max !== undefined &&
        typeof num === 'number' &&
        !isNaN(num)
      ) {
        if (num > fieldConfig.max) {
          errors.push([
            fieldPath,
            `${fieldPath} must be less than or equal to ${fieldConfig.max}`,
          ])
        }
      }

      // Precision validation for numeric strings
      if (
        fieldConfig.maxPrecision !== undefined &&
        isString &&
        value !== '' &&
        !isNaN(parseFloat(value))
      ) {
        const maxPrec = fieldConfig.maxPrecision
        const parts = value.split('.')
        if (parts[1] && parts[1].length > maxPrec) {
          errors.push([
            fieldPath,
            `${fieldPath} must have at most ${maxPrec} decimal places`,
          ])
        }
      }

      // String length validation
      if (fieldConfig.maxLength !== undefined && isString) {
        const maxLen = fieldConfig.maxLength
        if (value.length > maxLen) {
          errors.push([
            fieldPath,
            `${fieldPath} must be at most ${maxLen} characters`,
          ])
        }
      }

      // String whitespace validation
      if (isString && value !== '' && value.trim() === '') {
        errors.push([fieldPath, `${fieldPath} cannot be only whitespace`])
      }
    })
  })

  return errors
}

// Validator functions
export const validators = {
  [ValidatorsEnum.shouldBeString]: (
    value: any,
    fieldName: string,
  ): string | null => {
    if (typeof value !== 'string') {
      return `Field ${fieldName} must be a string`
    }
    return null
  },

  [ValidatorsEnum.shouldBeNumber]: (
    value: any,
    fieldName: string,
  ): string | null => {
    let num: number

    if (typeof value === 'number') {
      num = value
    } else if (typeof value === 'string') {
      num = parseFloat(value)
      if (isNaN(num)) {
        return `Field ${fieldName} must be a valid number`
      }
    } else {
      return `Field ${fieldName} must be a number`
    }

    if (isNaN(num) || !isFinite(num)) {
      return `Field ${fieldName} must be a valid number (not NaN or Infinity)`
    }
    return null
  },

  [ValidatorsEnum.shouldBeBoolean]: (
    value: any,
    fieldName: string,
  ): string | null => {
    if (typeof value !== 'boolean') {
      return `Field ${fieldName} must be a boolean`
    }
    return null
  },

  [ValidatorsEnum.shouldBeArray]: (
    value: any,
    fieldName: string,
  ): string | null => {
    if (!Array.isArray(value)) {
      return `Field ${fieldName} must be an array`
    }
    return null
  },

  [ValidatorsEnum.shouldBeValidEnumValue]: (
    value: any,
    fieldName: string,
    enumValues?: readonly string[],
  ): string | null => {
    if (!enumValues) {
      return `Field ${fieldName} enum values not configured`
    }
    if (!enumValues.includes(value as string)) {
      return `Field ${fieldName} must be one of: ${enumValues.join(', ')}`
    }
    return null
  },

  [ValidatorsEnum.shouldBePositive]: (
    value: any,
    fieldName: string,
  ): string | null => {
    const num = typeof value === 'string' ? parseFloat(value) : value
    if (typeof num !== 'number' || isNaN(num)) {
      return `Field ${fieldName} must be a valid number`
    }
    if (num <= 0) {
      return `Field ${fieldName} must be positive (greater than 0)`
    }
    return null
  },

  [ValidatorsEnum.shouldBeNonNegative]: (
    value: any,
    fieldName: string,
  ): string | null => {
    const num = typeof value === 'string' ? parseFloat(value) : value
    if (typeof num !== 'number' || isNaN(num)) {
      return `Field ${fieldName} must be a valid number`
    }
    if (num < 0) {
      return `Field ${fieldName} must be non-negative (greater than or equal to 0)`
    }
    return null
  },

  [ValidatorsEnum.shouldBeNegative]: (
    value: any,
    fieldName: string,
  ): string | null => {
    const num = typeof value === 'string' ? parseFloat(value) : value
    if (typeof num !== 'number' || isNaN(num)) {
      return `Field ${fieldName} must be a valid number`
    }
    if (num >= 0) {
      return `Field ${fieldName} must be negative (less than 0)`
    }
    return null
  },

  [ValidatorsEnum.shouldBeInteger]: (
    value: any,
    fieldName: string,
  ): string | null => {
    const num = typeof value === 'string' ? parseFloat(value) : value
    if (typeof num !== 'number' || isNaN(num)) {
      return `Field ${fieldName} must be a valid number`
    }
    if (!Number.isInteger(num)) {
      return `Field ${fieldName} must be an integer`
    }
    return null
  },

  [ValidatorsEnum.canBeEmptyString]: (
    value: any,
    fieldName: string,
  ): string | null => {
    // This validator allows empty strings, so if it's empty, return null (valid)
    if (typeof value === 'string' && value === '') {
      return null
    }
    if (typeof value !== 'string') {
      return `Field ${fieldName} must be a string`
    }
    // If not empty, other validators will check it
    return null
  },

  [ValidatorsEnum.shouldBeValidNumber]: (
    value: any,
    fieldName: string,
  ): string | null => {
    // For string numbers, try to parse them
    if (typeof value === 'string') {
      if (value === '') return null // Empty string is handled by canBeEmptyString
      const num = parseFloat(value)
      if (isNaN(num) || !isFinite(num)) {
        return `Field ${fieldName} must be a valid numeric string`
      }
    } else if (typeof value === 'number') {
      if (isNaN(value) || !isFinite(value)) {
        return `Field ${fieldName} must be a valid number (not NaN or Infinity)`
      }
    } else {
      return `Field ${fieldName} must be a number or numeric string`
    }
    return null
  },

  [ValidatorsEnum.shouldBeDateString]: (
    value: any,
    fieldName: string,
  ): string | null => {
    if (typeof value !== 'string') {
      return `Field ${fieldName} must be a string`
    }
    // Try to parse as date
    const date = new Date(value)
    if (isNaN(date.getTime())) {
      return `Field ${fieldName} must be a valid date string`
    }
    return null
  },
}

export type FieldConfig = {
  validators: ValidatorsEnum[]
  enum?: readonly string[]
  min?: number
  max?: number
  maxPrecision?: number
  maxLength?: number
}

export const dcaBotSchemaConfig: Record<
  keyof typeof DCA_FORM_DEFAULTS,
  FieldConfig
> = {
  pair: { validators: [ValidatorsEnum.shouldBeArray], min: 1 },
  name: { validators: [ValidatorsEnum.shouldBeString] },
  strategy: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(StrategyEnum),
  },
  profitCurrency: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['base', 'quote'],
  },
  baseOrderSize: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  startOrderType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(OrderTypeEnum),
  },
  startCondition: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(StartConditionEnum),
  },
  tpPerc: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  orderFixedIn: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['base', 'quote'],
  },
  orderSize: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  step: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  gridLevel: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 10,
  },
  comboSmartGridsCount: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 10,
  },
  ordersCount: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 200,
  },
  activeOrdersCount: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 200,
  },
  volumeScale: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
    min: 0.5,
    max: 10,
  },
  stepScale: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
    min: 0.5,
    max: 10,
  },
  useTp: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useSl: { validators: [ValidatorsEnum.shouldBeBoolean] },
  slPerc: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeNegative,
    ],
    maxPrecision: 2,
    min: -100,
    max: 0,
  },
  baseSlOn: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(BaseSlOnEnum),
  },
  useSmartOrders: { validators: [ValidatorsEnum.shouldBeBoolean] },
  minOpenDeal: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.canBeEmptyString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  maxOpenDeal: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.canBeEmptyString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  useDca: { validators: [ValidatorsEnum.shouldBeBoolean] },
  hodlDay: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 365,
  },
  hodlAt: { validators: [ValidatorsEnum.shouldBeString] },
  hodlNextBuy: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  maxNumberOfOpenDeals: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
    ],
    min: -1,
    max: 200,
  },
  indicators: { validators: [ValidatorsEnum.shouldBeArray] },
  indicatorGroups: { validators: [ValidatorsEnum.shouldBeArray] },
  orderSizeType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(OrderSizeTypeEnum),
  },
  limitTimeout: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
  },
  useLimitTimeout: { validators: [ValidatorsEnum.shouldBeBoolean] },
  cooldownAfterDealStart: { validators: [ValidatorsEnum.shouldBeBoolean] },
  cooldownAfterDealStartInterval: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
  },
  cooldownAfterDealStartUnits: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(CooldownUnits),
  },
  cooldownAfterDealStartOption: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(CooldownOptionsEnum),
  },
  cooldownAfterDealStop: { validators: [ValidatorsEnum.shouldBeBoolean] },
  cooldownAfterDealStopInterval: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
  },
  cooldownAfterDealStopUnits: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(CooldownUnits),
  },
  cooldownAfterDealStopOption: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(CooldownOptionsEnum),
  },
  moveSL: { validators: [ValidatorsEnum.shouldBeBoolean] },
  moveSLTrigger: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  moveSLValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  moveSLForAll: { validators: [ValidatorsEnum.shouldBeBoolean] },
  trailingSl: { validators: [ValidatorsEnum.shouldBeBoolean] },
  trailingTp: { validators: [ValidatorsEnum.shouldBeBoolean] },
  trailingTpPerc: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  useCloseAfterX: { validators: [ValidatorsEnum.shouldBeBoolean] },
  closeAfterX: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
  },
  useCloseAfterXloss: { validators: [ValidatorsEnum.shouldBeBoolean] },
  closeAfterXloss: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
  },
  useCloseAfterXprofit: { validators: [ValidatorsEnum.shouldBeBoolean] },
  closeAfterXprofitCond: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorStartConditionEnum),
  },
  closeAfterXprofitValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  useCloseAfterXwin: { validators: [ValidatorsEnum.shouldBeBoolean] },
  closeAfterXwin: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
  },
  useMulti: { validators: [ValidatorsEnum.shouldBeBoolean] },
  maxDealsPerPair: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
    ],
    min: -1,
    max: 200,
  },
  useCloseAfterXopen: { validators: [ValidatorsEnum.shouldBeBoolean] },
  closeAfterXopen: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
  },
  botStart: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(BotStartTypeEnum),
  },
  botActualStart: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(BotStartTypeEnum),
  },
  useBotController: { validators: [ValidatorsEnum.shouldBeBoolean] },
  stopType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(CloseDCATypeEnum),
  },
  dealCloseCondition: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(CloseConditionEnum),
  },
  dealCloseConditionSL: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(CloseConditionEnum),
  },
  useMinTP: { validators: [ValidatorsEnum.shouldBeBoolean] },
  minTp: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  closeDealType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(CloseDCATypeEnum),
  },
  useMultiTp: { validators: [ValidatorsEnum.shouldBeBoolean] },
  multiTp: { validators: [ValidatorsEnum.shouldBeArray] },
  useMultiSl: { validators: [ValidatorsEnum.shouldBeBoolean] },
  multiSl: { validators: [ValidatorsEnum.shouldBeArray] },
  marginType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(BotMarginTypeEnum),
  },
  leverage: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 125,
  },
  futures: { validators: [ValidatorsEnum.shouldBeBoolean] },
  coinm: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useVolumeFilter: { validators: [ValidatorsEnum.shouldBeBoolean] },
  volumeTop: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 1000,
  },
  volumeValue: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(VolumeValueEnum),
  },
  baseStep: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  baseGridLevels: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 10,
  },
  useActiveMinigrids: { validators: [ValidatorsEnum.shouldBeBoolean] },
  comboActiveMinigrids: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 10,
  },
  dcaCondition: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(DCAConditionEnum),
  },
  scaleDcaType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(ScaleDcaTypeEnum),
  },
  closeByTimer: { validators: [ValidatorsEnum.shouldBeBoolean] },
  closeByTimerValue: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
  },
  closeByTimerUnits: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(CooldownUnits),
  },
  useRelativeVolumeFilter: { validators: [ValidatorsEnum.shouldBeBoolean] },
  relativeVolumeTop: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 1000,
  },
  relativeVolumeValue: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(VolumeValueEnum),
  },
  feeOrder: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useMaxDealsPerHigherTimeframe: {
    validators: [ValidatorsEnum.shouldBeBoolean],
  },
  maxDealsPerHigherTimeframe: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
    ],
    min: -1,
    max: 200,
  },
  ignoreStartDeals: { validators: [ValidatorsEnum.shouldBeBoolean] },
  comboTpBase: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(ComboTpBase),
  },
  dynamicPriceFilterDeviation: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  dynamicPriceFilterPriceType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(DynamicPriceFilterPriceTypeEnum),
  },
  dynamicPriceFilterDirection: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(DynamicPriceFilterDirectionEnum),
  },
  pairPrioritization: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(PairPrioritizationEnum),
  },
  riskSlType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(RiskSlTypeEnum),
  },
  riskSlAmountPerc: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  riskSlAmountValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  riskUseTpRatio: { validators: [ValidatorsEnum.shouldBeBoolean] },
  riskTpRatio: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 4,
  },
  riskMaxPositionSize: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
    min: -1,
  },
  riskMinPositionSize: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeNonNegative,
    ],
  },
  dynamicArLockValue: { validators: [ValidatorsEnum.shouldBeBoolean] },
  reinvestValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
    min: 0,
    max: 100,
  },
  riskReductionValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
    min: 0,
    max: 100,
  },
  useRiskReduction: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useReinvest: { validators: [ValidatorsEnum.shouldBeBoolean] },
  startBotPriceCondition: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorStartConditionEnum),
  },
  stopBotPriceCondition: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorStartConditionEnum),
  },
  type: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(DCATypeEnum),
  },
  useNoOverlapDeals: { validators: [ValidatorsEnum.shouldBeBoolean] },
  minimumDeviation: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  skipBalanceCheck: { validators: [ValidatorsEnum.shouldBeBoolean] },
  dcaVolumeBaseOn: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(DCAVolumeType),
  },
  dcaVolumeRequiredChange: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  dcaVolumeRequiredChangeRef: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(DcaVolumeRequiredChangeRef),
  },
  dcaVolumeMaxValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
    min: -1,
  },
  dcaCustom: { validators: [ValidatorsEnum.shouldBeArray] },
  baseOrderPrice: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  useLimitPrice: { validators: [ValidatorsEnum.shouldBeBoolean] },
  hodlHourly: { validators: [ValidatorsEnum.shouldBeBoolean] },
  notUseLimitReposition: { validators: [ValidatorsEnum.shouldBeBoolean] },
  stopStatus: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(BotStatusEnum),
  },
  terminalDealType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(TerminalDealTypeEnum),
  },
  importFrom: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.canBeEmptyString,
    ],
  },
  useFixedTPPrices: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useFixedSLPrices: { validators: [ValidatorsEnum.shouldBeBoolean] },
  fixedTpPrice: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.canBeEmptyString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  fixedSlPrice: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.canBeEmptyString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  comboSlLimit: { validators: [ValidatorsEnum.shouldBeBoolean] },
  comboTpLimit: { validators: [ValidatorsEnum.shouldBeBoolean] },
  remainderFullAmount: { validators: [ValidatorsEnum.shouldBeBoolean] },
  autoRebalancing: { validators: [ValidatorsEnum.shouldBeBoolean] },
  adaptiveClose: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useStaticPriceFilter: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useCooldown: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useDynamicPriceFilter: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useVolumeFilterAll: { validators: [ValidatorsEnum.shouldBeBoolean] },
  dynamicPriceFilterOverValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  dynamicPriceFilterUnderValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    maxPrecision: 2,
  },
  useRiskReward: { validators: [ValidatorsEnum.shouldBeBoolean] },
  riskMaxSl: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
    maxPrecision: 2,
    min: -100,
    max: 0,
  },
  riskMinSl: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeNonNegative,
    ],
    maxPrecision: 2,
    min: 0,
    max: 100,
  },
  comboUseSmartGrids: { validators: [ValidatorsEnum.shouldBeBoolean] },
  startDealLogic: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorsLogicEnum),
  },
  stopDealLogic: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorsLogicEnum),
  },
  stopBotLogic: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorsLogicEnum),
  },
  startBotLogic: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorsLogicEnum),
  },
  startBotPriceValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.canBeEmptyString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  stopDealSlLogic: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(IndicatorsLogicEnum),
  },
  stopBotPriceValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.canBeEmptyString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
  },
  closeOrderType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(OrderTypeEnum),
  },
  rrSlType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(RRSlTypeEnum),
  },
  rrSlFixedValue: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  useSeparateMaxDealsOverAndUnder: {
    validators: [ValidatorsEnum.shouldBeBoolean],
  },
  maxDealsOver: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
    ],
    min: -1,
    max: 200,
  },
  maxDealsUnder: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
    ],
    min: -1,
    max: 200,
  },
  useSeparateMaxDealsOverAndUnderPerSymbol: {
    validators: [ValidatorsEnum.shouldBeBoolean],
  },
  maxDealsOverPerSymbol: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
    ],
    min: -1,
    max: 200,
  },
  maxDealsUnderPerSymbol: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBeInteger,
    ],
    min: -1,
    max: 200,
  },
  allowRaiseToExchangeMin: { validators: [ValidatorsEnum.shouldBeBoolean] },
  reduceToAvailableBalance: { validators: [ValidatorsEnum.shouldBeBoolean] },
  reduceToAvailableMinSize: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.canBeEmptyString,
      ValidatorsEnum.shouldBeValidNumber,
    ],
    min: 0,
  },
  dcaByMarket: { validators: [ValidatorsEnum.shouldBeBoolean] },
}

// Combo Bot extends DCA Bot with some additional/overridden fields
// Some fields in ComboBotSettings type are not used - add dummy check for now
export const comboBotSchemaConfig: Record<
  keyof typeof COMBO_FORM_DEFAULTS,
  FieldConfig
> = {
  ...dcaBotSchemaConfig,
  // Override specific fields with different defaults/validation for combo
  gridLevel: {
    validators: [
      ValidatorsEnum.shouldBeString,
      ValidatorsEnum.shouldBeValidNumber,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 100,
    maxPrecision: 0,
  },
  // newBalance and feeOrder are optional boolean fields in ComboBotSettings
  newBalance: { validators: [ValidatorsEnum.shouldBeBoolean] },
  feeOrder: { validators: [ValidatorsEnum.shouldBeBoolean] },
}

export const DCA_EXCLUDED_FIELDS: (keyof typeof DCA_FORM_DEFAULTS)[] = [
  'gridLevel',
  'comboSmartGridsCount',
  'type',
  'baseOrderPrice',
  'useLimitPrice',
  'terminalDealType',
  'comboUseSmartGrids',
  'comboSlLimit',
  'comboTpLimit',
]

export const COMBO_EXCLUDED_FIELDS: (keyof typeof COMBO_FORM_DEFAULTS)[] = [
  'startOrderType',
  'hodlDay',
  'hodlAt',
  'hodlNextBuy',
  'moveSL',
  'moveSLTrigger',
  'moveSLValue',
  'moveSLForAll',
  'trailingSl',
  'trailingTp',
  'trailingTpPerc',
  'useMulti',
  'maxDealsPerPair',
  'dealCloseCondition',
  'useMinTP',
  'minTp',
  'useMultiTp',
  'multiTp',
  'useMultiSl',
  'multiSl',
  'useVolumeFilter',
  'volumeTop',
  'volumeValue',
  'dcaCondition',
  'scaleDcaType',
  'riskSlType',
  'riskSlAmountPerc',
  'riskSlAmountValue',
  'riskUseTpRatio',
  'riskTpRatio',
  'riskMaxPositionSize',
  'riskMinPositionSize',
  'dynamicArLockValue',
  'dcaVolumeBaseOn',
  'dcaVolumeRequiredChange',
  'dcaVolumeRequiredChangeRef',
  'dcaVolumeMaxValue',
  'dcaCustom',
  'hodlHourly',
  'terminalDealType',
  'useFixedTPPrices',
  'useFixedSLPrices',
  'fixedTpPrice',
  'fixedSlPrice',
  'useRiskReward',
  'riskMaxSl',
  'riskMinSl',
  'allowRaiseToExchangeMin',
  'reduceToAvailableBalance',
  'reduceToAvailableMinSize',
  'dcaByMarket',
  'useLimitPrice',
  'baseSlOn',
]

export const TERMINAL_DEAL_EXCLUDED_FIELDS: (keyof typeof DCA_FORM_DEFAULTS)[] =
  [
    'gridLevel',
    'comboSmartGridsCount',
    'type',
    'comboUseSmartGrids',
    'comboSlLimit',
    'comboTpLimit',
    'baseSlOn',
    'minOpenDeal',
    'maxOpenDeal',
    'hodlDay',
    'hodlAt',
    'hodlNextBuy',
    'maxNumberOfOpenDeals',
    'cooldownAfterDealStart',
    'cooldownAfterDealStartInterval',
    'cooldownAfterDealStartUnits',
    'cooldownAfterDealStartOption',
    'cooldownAfterDealStop',
    'cooldownAfterDealStopUnits',
    'cooldownAfterDealStopInterval',
    'cooldownAfterDealStopOption',
    'useCloseAfterX',
    'closeAfterX',
    'useCloseAfterXloss',
    'closeAfterXloss',
    'useCloseAfterXprofit',
    'closeAfterXprofitCond',
    'closeAfterXprofitValue',
    'useCloseAfterXwin',
    'closeAfterXwin',
    'useMulti',
    'maxDealsPerPair',
    'useCloseAfterXopen',
    'closeAfterXopen',
    'botStart',
    'botActualStart',
    'useBotController',
    'stopType',
    'useVolumeFilter',
    'volumeTop',
    'volumeValue',
    'baseGridLevels',
    'baseStep',
    'useActiveMinigrids',
    'comboActiveMinigrids',
    'dcaCondition',
    'scaleDcaType',
    'closeByTimer',
    'closeByTimerValue',
    'closeByTimerUnits',
    'useRelativeVolumeFilter',
    'relativeVolumeTop',
    'relativeVolumeValue',
    'feeOrder',
    'useMaxDealsPerHigherTimeframe',
    'maxDealsPerHigherTimeframe',
    'ignoreStartDeals',
    'comboTpBase',
    'dynamicPriceFilterDeviation',
    'dynamicPriceFilterPriceType',
    'dynamicPriceFilterDirection',
    'pairPrioritization',
    'riskSlType',
    'riskSlAmountPerc',
    'riskSlAmountValue',
    'riskUseTpRatio',
    'riskTpRatio',
    'riskMaxPositionSize',
    'riskMinPositionSize',
    'dynamicArLockValue',
    'reinvestValue',
    'riskReductionValue',
    'useRiskReduction',
    'useReinvest',
    'startBotPriceCondition',
    'stopBotPriceCondition',
    'useNoOverlapDeals',
    'dcaCustom',
    'hodlHourly',
    'stopStatus',
    'comboSlLimit',
    'comboTpLimit',
    'remainderFullAmount',
    'autoRebalancing',
    'adaptiveClose',
    'useStaticPriceFilter',
    'useCooldown',
    'useDynamicPriceFilter',
    'useVolumeFilterAll',
    'dynamicPriceFilterOverValue',
    'dynamicPriceFilterUnderValue',
    'comboUseSmartGrids',
    'startDealLogic',
    'stopDealLogic',
    'stopBotLogic',
    'startBotLogic',
    'startBotPriceValue',
    'stopDealSlLogic',
    'stopBotPriceValue',
    'useSeparateMaxDealsOverAndUnder',
    'maxDealsOver',
    'maxDealsUnder',
    'useSeparateMaxDealsOverAndUnderPerSymbol',
    'maxDealsOverPerSymbol',
    'maxDealsUnderPerSymbol',
  ]
export const gridBotSchemaConfig: Record<
  keyof typeof GRID_FORM_DEFAULTS,
  FieldConfig
> = {
  name: { validators: [ValidatorsEnum.shouldBeString] },
  pair: { validators: [ValidatorsEnum.shouldBeString] },
  topPrice: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  lowPrice: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  levels: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 2,
    max: 200,
  },
  gridStep: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  budget: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBePositive,
    ],
  },
  ordersInAdvance: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 20,
  },
  useOrderInAdvance: { validators: [ValidatorsEnum.shouldBeBoolean] },
  prioritize: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['gridStep', 'level'],
  },
  sellDisplacement: {
    validators: [ValidatorsEnum.shouldBeNumber],
  },
  gridType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['geometric', 'arithmetic'],
  },
  tpSl: { validators: [ValidatorsEnum.shouldBeBoolean] },
  tpSlCondition: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['valueChanged', 'priceReached'],
  },
  tpSlAction: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['stop', 'stopAndSell'],
  },
  sl: { validators: [ValidatorsEnum.shouldBeBoolean] },
  slCondition: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['valueChanged', 'priceReached'],
  },
  slAction: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['stop', 'stopAndSell'],
  },
  tpPerc: {
    validators: [ValidatorsEnum.shouldBeNumber],
  },
  slPerc: {
    validators: [ValidatorsEnum.shouldBeNumber],
  },
  tpTopPrice: {
    validators: [ValidatorsEnum.shouldBeNumber],
  },
  slLowPrice: {
    validators: [ValidatorsEnum.shouldBeNumber],
  },
  updatedBudget: { validators: [ValidatorsEnum.shouldBeBoolean] },
  useStartPrice: { validators: [ValidatorsEnum.shouldBeBoolean] },
  startPrice: { validators: [ValidatorsEnum.shouldBeString] },
  futures: { validators: [ValidatorsEnum.shouldBeBoolean] },
  newProfit: { validators: [ValidatorsEnum.shouldBeBoolean] },
  newBalance: { validators: [ValidatorsEnum.shouldBeBoolean] },
  coinm: { validators: [ValidatorsEnum.shouldBeBoolean] },
  strategy: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(StrategyEnum),
  },
  futuresStrategy: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['LONG', 'SHORT', 'NEUTRAL'],
  },
  slLimit: { validators: [ValidatorsEnum.shouldBeBoolean] },
  tpSlLimit: { validators: [ValidatorsEnum.shouldBeBoolean] },
  feeOrder: { validators: [ValidatorsEnum.shouldBeBoolean] },
  marginType: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: Object.values(BotMarginTypeEnum),
  },
  leverage: {
    validators: [
      ValidatorsEnum.shouldBeNumber,
      ValidatorsEnum.shouldBeInteger,
      ValidatorsEnum.shouldBePositive,
    ],
    min: 1,
    max: 125,
  },
  profitCurrency: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['base', 'quote'],
  },
  orderFixedIn: {
    validators: [ValidatorsEnum.shouldBeValidEnumValue],
    enum: ['base', 'quote'],
  },
  skipBalanceCheck: { validators: [ValidatorsEnum.shouldBeBoolean] },
  lastPriceRangeAlert: { validators: [ValidatorsEnum.shouldBeNumber] },
}

export const GRID_EXCLUDED_FIELDS: (keyof typeof GRID_FORM_DEFAULTS)[] = [
  'updatedBudget',
  'newProfit',
]
