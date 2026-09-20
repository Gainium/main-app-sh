import {
  BotSettings,
  ComboBotSettings,
  CreateComboBotInput,
  CreateDCABotInput,
  CreateGridBotInput,
  DCABotSettings,
  StartConditionEnum,
} from '../../../../types'
import { CreateDCABotInputRaw, CreateGridBotInputRaw } from '../api'
import {
  COMBO_FORM_DEFAULTS,
  DCA_FORM_DEFAULTS,
  GRID_FORM_DEFAULTS,
} from '../botDefaults'
import {
  comboBotSchemaConfig,
  DCA_EXCLUDED_FIELDS,
  COMBO_EXCLUDED_FIELDS,
  dcaBotSchemaConfig,
  GRID_EXCLUDED_FIELDS,
  gridBotSchemaConfig,
  ValidationResult,
  FieldConfig,
  validators,
  ValidatorsEnum,
  validateNestedObjects,
  indicatorCoreConfig,
  indicatorGroupConfig,
  multiTPConfig,
  dcaCustomConfig,
  maxStringLength,
  maxPrecision,
  TERMINAL_DEAL_EXCLUDED_FIELDS,
} from './bots/config'

const validateCommonSchema = <
  T extends CreateDCABotInput | CreateComboBotInput | CreateGridBotInput,
>(
  input: T,
  originalInput: CreateDCABotInputRaw | CreateGridBotInputRaw,
  config: Record<string, FieldConfig>,
  excludedFields: string[],
  defaults: DCABotSettings | ComboBotSettings | BotSettings,
): ValidationResult<T> => {
  const response: ValidationResult<T> = {
    valid: true,
    errors: [],
    data: JSON.parse(JSON.stringify(input)) as T,
  }

  // Check for required fields
  if (!input.exchangeUUID) {
    response.errors.push(['exchangeUUID', 'Field exchangeUUID is required'])
  }

  // Check for unexpected fields
  ;(
    Object.keys(input) as (
      | keyof CreateDCABotInput
      | keyof CreateComboBotInput
      | keyof CreateGridBotInput
    )[]
  ).forEach((key) => {
    if (key === 'exchangeUUID' || key === 'exchange' || key === 'vars') {
      return
    }
    if (!(key in defaults)) {
      response.errors.push([key, `Unexpected field: ${key}`])
    }
  })

  // Validate each field using fieldsConfig
  Object.entries(config).forEach(([key, config]) => {
    const k = key as keyof typeof defaults
    const kDca = k as keyof DCABotSettings
    const value = input[k]

    // Skip if value is undefined (will use defaults)
    if (value === undefined) {
      return
    }

    // Check for null values
    if (value === null) {
      response.errors.push([k, `Field ${k} cannot be null`])
      return
    }

    // Run validators
    config.validators.forEach((validatorType) => {
      const validator = validators[validatorType]
      if (!validator) return

      let error: string | null = null

      if (validatorType === ValidatorsEnum.shouldBeValidEnumValue) {
        error = validator(value, k, config.enum)
      } else {
        error = validator(value, k)
      }

      if (error) {
        response.errors.push([k, error])
      }
    })

    // Additional constraints based on type
    const isArray = Array.isArray(value)
    const isString = typeof value === 'string'
    const num = isString ? parseFloat(value) : value

    if (isArray) {
      // Array length validation (min/max apply to array size)
      if (config.min !== undefined) {
        if (value.length < config.min) {
          response.errors.push([
            k,
            `Field ${k} must have at least ${config.min} items`,
          ])
        }
      }
      if (config.max !== undefined) {
        if (value.length > config.max) {
          response.errors.push([
            k,
            `Field ${k} must have at most ${config.max} items`,
          ])
        }
      }
      // Nested array validation for specific fields
      if (kDca === 'indicators') {
        const nestedErrors = validateNestedObjects(
          value,
          k,
          indicatorCoreConfig,
        )
        response.errors.push(...nestedErrors)
      } else if (kDca === 'indicatorGroups') {
        const nestedErrors = validateNestedObjects(
          value,
          k,
          indicatorGroupConfig,
        )
        response.errors.push(...nestedErrors)
      } else if (kDca === 'multiTp') {
        const nestedErrors = validateNestedObjects(value, k, multiTPConfig)
        response.errors.push(...nestedErrors)
      } else if (kDca === 'multiSl') {
        const nestedErrors = validateNestedObjects(value, k, multiTPConfig)
        response.errors.push(...nestedErrors)
      } else if (kDca === 'dcaCustom') {
        const nestedErrors = validateNestedObjects(value, k, dcaCustomConfig)
        response.errors.push(...nestedErrors)
      }
    } else if (isString) {
      // String length validation with fallback to global maxStringLength
      const maxLen = config.maxLength ?? maxStringLength
      if (value.length > maxLen) {
        response.errors.push([
          k,
          `Field ${k} must be at most ${maxLen} characters`,
        ])
      }

      // String whitespace validation
      if (value !== '' && value.trim() === '') {
        response.errors.push([k, `Field ${k} cannot be only whitespace`])
      }

      // Precision validation for numeric strings with fallback to global maxPrecision
      if (value !== '' && !isNaN(parseFloat(value))) {
        const maxPrec = config.maxPrecision ?? maxPrecision
        const parts = value.split('.')
        if (parts[1] && parts[1].length > maxPrec) {
          response.errors.push([
            k,
            `Field ${k} must have at most ${maxPrec} decimal places`,
          ])
        }
      }
    } else if (typeof num === 'number' && !isNaN(num)) {
      // Numeric min/max validation
      if (config.min !== undefined) {
        if (num < config.min) {
          response.errors.push([
            k,
            `Field ${k} must be greater than or equal to ${config.min}`,
          ])
        }
      }

      if (config.max !== undefined) {
        if (num > config.max) {
          response.errors.push([
            k,
            `Field ${k} must be less than or equal to ${config.max}`,
          ])
        }
      }
    }
  })

  // Only shape is checked here. Whether the pair exists is settled against the
  // `pairs` collection in the logic validator, which accepts both the
  // documented `BASE_QUOTE` input and the exchange-native symbol every API
  // read returns (`findPairBySymbol`). Requiring a `_` here rejected the
  // native form before that lookup could run - schema validation
  // short-circuits - which made a read-modify-create round trip impossible.
  // Spec 067.
  const filterInvalidPairs = [input.pair]
    .flat()
    .filter((p) => typeof p !== 'string' || p.trim() === '')
  if (filterInvalidPairs.length > 0) {
    response.errors.push([
      'pair',
      `Field pair contains invalid entries: ${filterInvalidPairs.join(', ')}`,
    ])
  }
  excludedFields.forEach((field) => {
    if (field in originalInput) {
      response.errors = response.errors.filter((e) => e[0] !== field)
      response.errors.push([
        field,
        `Field ${field} is not supported for DCA bots`,
      ])
    }
  })
  response.valid = response.errors.length === 0
  return response
}

const validateNotAddedMultiPairs = <T extends CreateDCABotInput>(
  input: T,
  previousValidation?: ValidationResult<T>,
): ValidationResult<T> => {
  const response: ValidationResult<T> = previousValidation ?? {
    valid: true,
    errors: [],
    data: JSON.parse(JSON.stringify(input)) as T,
  }

  response.errors = response.errors.filter((e) => e[0] !== 'useMulti')
  if (input.useMulti) {
    response.errors.push(['useMulti', `Multiple pairs is not supported`])
  }

  response.valid = response.errors.length === 0
  return response
}

export const validateCreateDCABotInputSchema = (
  input: CreateDCABotInput,
  originalInput: CreateDCABotInputRaw,
): ValidationResult<CreateDCABotInput> => {
  return validateCommonSchema(
    input,
    originalInput,
    dcaBotSchemaConfig,
    DCA_EXCLUDED_FIELDS,
    DCA_FORM_DEFAULTS,
  )
}

export const validateCreateComboBotInputSchema = (
  input: CreateComboBotInput,
  originalInput: CreateDCABotInputRaw,
): ValidationResult<CreateComboBotInput> => {
  let response = validateCommonSchema(
    input,
    originalInput,
    comboBotSchemaConfig,
    COMBO_EXCLUDED_FIELDS,
    COMBO_FORM_DEFAULTS,
  )
  response = validateNotAddedMultiPairs(input, response)

  return response
}

export const validateCreateTerminalDealInputSchema = (
  input: CreateDCABotInput,
  originalInput: CreateDCABotInputRaw,
): ValidationResult<CreateDCABotInput> => {
  let response = validateCommonSchema(
    input,
    originalInput,
    dcaBotSchemaConfig,
    TERMINAL_DEAL_EXCLUDED_FIELDS,
    DCA_FORM_DEFAULTS,
  )

  response = validateNotAddedMultiPairs(input, response)
  if (originalInput.vars?.length) {
    response.errors.push([
      'vars',
      `Field vars is not supported for terminal deals`,
    ])
  }
  if (input.useRiskReward) {
    response.errors.push([
      'useRiskReward',
      `Field useRiskReward is not supported for terminal deals created from API`,
    ])
  }

  if (
    originalInput.startCondition &&
    originalInput.startCondition !== StartConditionEnum.asap
  ) {
    response.errors.push([
      'startCondition',
      `Field startCondition can only be 'asap' for terminal deals `,
    ])
  }

  response.valid = response.errors.length === 0
  return response
}

export const validateCreateGridBotInputSchema = (
  input: CreateGridBotInput,
  originalInput: CreateGridBotInputRaw,
): ValidationResult<CreateGridBotInput> => {
  const response = validateCommonSchema(
    input,
    originalInput,
    gridBotSchemaConfig,
    GRID_EXCLUDED_FIELDS,
    GRID_FORM_DEFAULTS,
  )

  // Grid bots use a single pair string, not an array
  if (Array.isArray(input.pair)) {
    response.errors.push([
      'pair',
      `Field pair must be a string for grid bots, not an array`,
    ])
  }

  response.valid = response.errors.length === 0
  return response
}
