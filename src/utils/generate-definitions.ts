#!/usr/bin/env ts-node
/**
 * Bot / Indicator Field Definition Generator
 *
 * Parses TypeScript types from types.ts (via the compiler API) and merges them
 * with the validator config (dcaBotSchemaConfig, comboBotSchemaConfig,
 * gridBotSchemaConfig, indicatorCoreConfig, multiTPConfig, dcaCustomConfig,
 * indicatorGroupConfig) to produce definitions/generated.ts.
 *
 * The output file is checked in to source control. Re-run whenever types or
 * validator configs change:
 *
 *   npm run generate:definitions
 *
 * The generator NEVER invents type information – every field's type comes from
 * the parsed TypeScript AST; every constraint (min/max/enum/validators) comes
 * from the corresponding config object in validators/bots/config.ts.
 */

import * as ts from 'typescript'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import {
  dcaBotSchemaConfig,
  comboBotSchemaConfig,
  gridBotSchemaConfig,
  indicatorCoreConfig,
  multiTPConfig,
  dcaCustomConfig,
  indicatorGroupConfig,
  ValidatorsEnum,
  type NestedFieldConfig,
} from '../server/v2/validators/bots/config'
import {
  DCA_FORM_DEFAULTS,
  COMBO_FORM_DEFAULTS,
  GRID_FORM_DEFAULTS,
} from '../server/v2/botDefaults'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '../..')
const TYPES_FILE = path.join(ROOT, 'types.ts')
const OUT_FILE = path.join(ROOT, 'src/server/v2/definitions/generated.ts')
const DEFINITIONS_DIR = path.join(ROOT, 'src/server/v2/definitions')

type RawFieldConfig = NestedFieldConfig

// ---------------------------------------------------------------------------
// Human-readable validator → short label mapping
// ---------------------------------------------------------------------------
const VALIDATOR_LABELS: Record<string, string> = {
  shouldBeString: 'mustBeString',
  shouldBeNumber: 'mustBeNumber',
  shouldBeBoolean: 'mustBeBoolean',
  shouldBeArray: 'mustBeArray',
  shouldBeValidEnumValue: 'mustBeOneOfEnum',
  shouldBePositive: 'mustBePositive',
  shouldBeNonNegative: 'mustBeNonNegative',
  shouldBeNegative: 'mustBeNegative',
  shouldBeInteger: 'mustBeInteger',
  shouldBeValidNumber: 'mustBeValidNumber',
  canBeEmptyString: 'canBeEmptyString',
  shouldBeDateString: 'mustBeDateString',
}

function labelValidators(validators: ValidatorsEnum[]): string[] {
  return [...new Set(validators.map((v) => VALIDATOR_LABELS[v] ?? v))]
}

// ---------------------------------------------------------------------------
// Infer FieldType from validator list + TypeScript AST type
// ---------------------------------------------------------------------------
type FieldType =
  | 'string'
  | 'number'
  | 'numberInString'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'object'
  | 'Date'

function inferFieldType(
  validators: string[],
  astType: string,
  enumValues?: readonly string[],
): FieldType {
  const hasString = validators.includes('shouldBeString')
  const hasNumber = validators.includes('shouldBeNumber')
  const hasValidNumber = validators.includes('shouldBeValidNumber')
  const hasBoolean = validators.includes('shouldBeBoolean')
  const hasArray = validators.includes('shouldBeArray')
  const hasEnum = validators.includes('shouldBeValidEnumValue')

  if (hasArray || astType === 'array') return 'array'
  if (hasBoolean || astType === 'boolean') return 'boolean'
  if (hasEnum && enumValues && enumValues.length > 0) return 'enum'
  if (hasString && (hasNumber || hasValidNumber)) return 'numberInString'
  if (hasNumber || astType === 'number') return 'number'
  if (hasString || astType === 'string') return 'string'
  // Fallback to AST type
  if (astType === 'Date') return 'Date'
  return 'string'
}

// ---------------------------------------------------------------------------
// TypeScript AST parser
// ---------------------------------------------------------------------------

interface AstProperty {
  name: string
  type: string // 'string' | 'number' | 'boolean' | 'array' | 'object' | enum-ref
  required: boolean
  enumRef?: string // enum type name if type reference resolves to enum
  enumValues?: string[] // resolved enum values
}

class TypesParser {
  private program: ts.Program
  private sf: ts.SourceFile
  private enums = new Map<string, string[]>()
  private types = new Map<string, AstProperty[]>()

  constructor(filePath: string) {
    this.program = ts.createProgram([filePath], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      strict: false,
    })
    this.sf = this.program.getSourceFile(filePath)!
    if (!this.sf) throw new Error(`Could not parse ${filePath}`)
    this.parse()
  }

  private parse() {
    // 1st pass: enums
    ts.forEachChild(this.sf, (node) => {
      if (ts.isEnumDeclaration(node)) {
        const values: string[] = []
        node.members.forEach((m) => {
          if (m.initializer && ts.isStringLiteral(m.initializer)) {
            values.push(m.initializer.text)
          } else if (ts.isIdentifier(m.name)) {
            values.push(m.name.text)
          }
        })
        if (values.length) this.enums.set(node.name.text, values)
      }
    })

    // 2nd pass: interfaces + type aliases
    ts.forEachChild(this.sf, (node) => {
      if (ts.isInterfaceDeclaration(node)) {
        this.collectInterface(node)
      } else if (ts.isTypeAliasDeclaration(node)) {
        this.collectTypeAlias(node)
      }
    })
  }

  private collectInterface(node: ts.InterfaceDeclaration) {
    const props: AstProperty[] = []
    node.members.forEach((m) => {
      if (ts.isPropertySignature(m)) {
        const p = this.extractProp(m)
        if (p) props.push(p)
      }
    })
    if (props.length) this.types.set(node.name.text, props)
  }

  private collectTypeAlias(node: ts.TypeAliasDeclaration) {
    const props: AstProperty[] = []
    const collect = (typeNode: ts.TypeNode) => {
      if (ts.isTypeLiteralNode(typeNode)) {
        typeNode.members.forEach((m) => {
          if (ts.isPropertySignature(m)) {
            const p = this.extractProp(m)
            if (p) props.push(p)
          }
        })
      } else if (ts.isIntersectionTypeNode(typeNode)) {
        typeNode.types.forEach(collect)
      }
    }
    collect(node.type)
    if (props.length) this.types.set(node.name.text, props)
  }

  private extractProp(m: ts.PropertySignature): AstProperty | null {
    if (!m.name || !ts.isIdentifier(m.name)) return null
    const name = m.name.text
    const required = !m.questionToken
    if (!m.type) return null

    const { typeName, enumValues } = this.resolveType(m.type)
    return { name, type: typeName, required, enumValues }
  }

  private resolveType(typeNode: ts.TypeNode): {
    typeName: string
    enumValues?: string[]
  } {
    // Union: strip null/undefined, recurse on actual type
    if (ts.isUnionTypeNode(typeNode)) {
      const actual = typeNode.types.find(
        (t) =>
          t.kind !== ts.SyntaxKind.UndefinedKeyword &&
          t.kind !== ts.SyntaxKind.NullKeyword,
      )
      if (actual) return this.resolveType(actual)
    }

    if (ts.isTypeReferenceNode(typeNode)) {
      const name = ts.isIdentifier(typeNode.typeName)
        ? typeNode.typeName.text
        : typeNode.typeName.right.text

      if (this.enums.has(name)) {
        return { typeName: 'string', enumValues: this.enums.get(name) }
      }
      if (name === 'Array' && typeNode.typeArguments?.[0]) {
        return { typeName: 'array' }
      }
      if (['string', 'String'].includes(name)) return { typeName: 'string' }
      if (['number', 'Number'].includes(name)) return { typeName: 'number' }
      if (['boolean', 'Boolean'].includes(name)) return { typeName: 'boolean' }
      if (name === 'Date') return { typeName: 'Date' }
      return { typeName: 'object' }
    }

    if (ts.isArrayTypeNode(typeNode)) return { typeName: 'array' }
    if (ts.isLiteralTypeNode(typeNode)) {
      if (ts.isStringLiteral(typeNode.literal))
        return { typeName: 'string', enumValues: [typeNode.literal.text] }
      if (ts.isNumericLiteral(typeNode.literal)) return { typeName: 'number' }
    }

    switch (typeNode.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { typeName: 'string' }
      case ts.SyntaxKind.NumberKeyword:
        return { typeName: 'number' }
      case ts.SyntaxKind.BooleanKeyword:
        return { typeName: 'boolean' }
      default:
        return { typeName: 'object' }
    }
  }

  getProperties(typeName: string): AstProperty[] {
    return this.types.get(typeName) ?? []
  }

  getEnumValues(enumName: string): string[] | undefined {
    return this.enums.get(enumName)
  }
}

// ---------------------------------------------------------------------------
// Merge AST + validator config → FieldDefinition[]
// ---------------------------------------------------------------------------

interface OutField {
  name: string
  type: FieldType
  required: boolean
  validators: string[]
  enum?: string[]
  itemType?: FieldType
  min?: number
  max?: number
  maxPrecision?: number
  maxLength?: number
  default?: unknown
  note?: string
  example?: unknown
}

function buildField(
  name: string,
  astProp: AstProperty | undefined,
  validatorCfg: RawFieldConfig | undefined,
  defaultValue: unknown,
  notes: Record<string, { note?: string; example?: unknown }>,
): OutField {
  const validators = validatorCfg?.validators ?? []
  const enumValues = validatorCfg?.enum?.length
    ? [...validatorCfg.enum]
    : (astProp?.enumValues ?? undefined)

  const astType = astProp?.type ?? 'string'
  const fieldType = inferFieldType(validators, astType, enumValues)

  const field: OutField = {
    name,
    type: fieldType,
    required:
      validatorCfg?.required !== undefined
        ? !!validatorCfg.required
        : (astProp?.required ?? false),
    validators: labelValidators(validators),
  }

  if (enumValues?.length) field.enum = enumValues
  if (fieldType === 'array') field.itemType = 'object' // arrays of objects/primitives
  if (validatorCfg?.min !== undefined) field.min = validatorCfg.min
  if (validatorCfg?.max !== undefined) field.max = validatorCfg.max
  if (validatorCfg?.maxPrecision !== undefined)
    field.maxPrecision = validatorCfg.maxPrecision
  if (validatorCfg?.maxLength !== undefined)
    field.maxLength = validatorCfg.maxLength
  if (defaultValue !== undefined) field.default = defaultValue

  const meta = notes[name]
  if (meta?.note) field.note = meta.note
  if (meta?.example !== undefined) {
    field.example = meta.example
  } else if (defaultValue !== undefined) {
    field.example = defaultValue
  }

  return field
}

// ---------------------------------------------------------------------------
// Section layout definitions
// These describe WHICH fields belong to each section and in what order.
// The generator uses them to produce the SectionDefinition[] arrays.
// Edit these when new fields are added to bot settings.
// ---------------------------------------------------------------------------

type SectionLayout = {
  id: string
  name: string
  description: string
  fields: string[]
}

const DCA_SECTIONS: SectionLayout[] = [
  {
    id: 'basic',
    name: 'Basic',
    description:
      'Bot identity, exchange connection, trading pairs, and multi-pair mode.',
    fields: ['name', 'exchangeUUID', 'exchange', 'pair', 'useMulti'],
  },
  {
    id: 'strategy',
    name: 'Strategy',
    description:
      'Trading direction, order sizing, futures options, reinvestment and risk-reduction settings.',
    fields: [
      'strategy',
      'futures',
      'coinm',
      'marginType',
      'leverage',
      'baseOrderSize',
      'orderSize',
      'orderSizeType',
      'orderFixedIn',
      'startOrderType',
      'profitCurrency',
      'notUseLimitReposition',
      'useLimitTimeout',
      'limitTimeout',
      'skipBalanceCheck',
      'feeOrder',
      'useReinvest',
      'reinvestValue',
      'useRiskReduction',
      'riskReductionValue',
    ],
  },
  {
    id: 'deal_start',
    name: 'Deal Start',
    description:
      'Conditions that trigger opening a new deal: start condition, deal limits, price filters and cooldowns.',
    fields: [
      'startCondition',
      'maxNumberOfOpenDeals',
      'maxDealsPerPair',
      'useSeparateMaxDealsOverAndUnder',
      'maxDealsOver',
      'maxDealsUnder',
      'useSeparateMaxDealsOverAndUnderPerSymbol',
      'maxDealsOverPerSymbol',
      'maxDealsUnderPerSymbol',
      'minOpenDeal',
      'maxOpenDeal',
      'useMaxDealsPerHigherTimeframe',
      'maxDealsPerHigherTimeframe',
      'ignoreStartDeals',
      'useNoOverlapDeals',
      'minimumDeviation',
      'useVolumeFilter',
      'volumeTop',
      'volumeValue',
      'useVolumeFilterAll',
      'useRelativeVolumeFilter',
      'relativeVolumeTop',
      'relativeVolumeValue',
      'useStaticPriceFilter',
      'useDynamicPriceFilter',
      'dynamicPriceFilterDeviation',
      'dynamicPriceFilterPriceType',
      'dynamicPriceFilterDirection',
      'dynamicPriceFilterOverValue',
      'dynamicPriceFilterUnderValue',
      'pairPrioritization',
      'useCooldown',
      'cooldownAfterDealStart',
      'cooldownAfterDealStartInterval',
      'cooldownAfterDealStartUnits',
      'cooldownAfterDealStartOption',
      'cooldownAfterDealStop',
      'cooldownAfterDealStopInterval',
      'cooldownAfterDealStopUnits',
      'cooldownAfterDealStopOption',
    ],
  },
  {
    id: 'risk_reward',
    name: 'Risk Reward',
    description:
      'Risk/reward stop-loss type, risk sizing, TP ratio, and position-size limits.',
    fields: [
      'useRiskReward',
      'rrSlType',
      'rrSlFixedValue',
      'riskSlType',
      'riskSlAmountPerc',
      'riskSlAmountValue',
      'riskUseTpRatio',
      'riskTpRatio',
      'riskMaxPositionSize',
      'riskMinPositionSize',
      'riskMaxSl',
      'riskMinSl',
    ],
  },
  {
    id: 'take_profit',
    name: 'Take Profit',
    description:
      'Take-profit configuration: close condition, multi-TP, trailing TP, close-by-timer, and close order type.',
    fields: [
      'dealCloseCondition',
      'useTp',
      'tpPerc',
      'useMinTP',
      'minTp',
      'useMultiTp',
      'multiTp',
      'useFixedTPPrices',
      'fixedTpPrice',
      'trailingTp',
      'trailingTpPerc',
      'closeByTimer',
      'closeByTimerValue',
      'closeByTimerUnits',
      'useCloseAfterX',
      'closeAfterX',
      'useCloseAfterXwin',
      'closeAfterXwin',
      'useCloseAfterXloss',
      'closeAfterXloss',
      'useCloseAfterXprofit',
      'closeAfterXprofitCond',
      'closeAfterXprofitValue',
      'useCloseAfterXopen',
      'closeAfterXopen',
      'closeDealType',
      'closeOrderType',
    ],
  },
  {
    id: 'stop_loss',
    name: 'Stop Loss',
    description:
      'Stop-loss configuration: SL percent, base reference, multi-SL, trailing SL, and move-SL.',
    fields: [
      'dealCloseConditionSL',
      'useSl',
      'slPerc',
      'baseSlOn',
      'useMultiSl',
      'multiSl',
      'useFixedSLPrices',
      'fixedSlPrice',
      'trailingSl',
      'moveSL',
      'moveSLTrigger',
      'moveSLValue',
      'moveSLForAll',
    ],
  },
  {
    id: 'dca',
    name: 'DCA',
    description:
      'Dollar-cost averaging: trigger condition, order count, smart orders, order sizing and scale factors.',
    fields: [
      'useDca',
      'dcaCondition',
      'scaleDcaType',
      'ordersCount',
      'activeOrdersCount',
      'step',
      'stepScale',
      'orderSize',
      'volumeScale',
      'dcaVolumeBaseOn',
      'dcaVolumeRequiredChange',
      'dcaVolumeRequiredChangeRef',
      'dcaVolumeMaxValue',
      'dcaByMarket',
      'dcaCustom',
      'useSmartOrders',
      'gridLevel',
      'baseStep',
      'baseGridLevels',
      'hodlDay',
      'hodlAt',
      'hodlNextBuy',
      'hodlHourly',
    ],
  },
  {
    id: 'controller',
    name: 'Controller',
    description:
      'Bot-level start/stop conditions, indicator-based deal start/stop, stop-by-profit and stop-by-deal-count rules. Uses indicators and indicatorGroups arrays.',
    fields: [
      'useBotController',
      'botStart',
      'botActualStart',
      'stopType',
      'stopStatus',
      'startDealLogic',
      'stopDealLogic',
      'stopDealSlLogic',
      'stopBotLogic',
      'startBotLogic',
      'startBotPriceCondition',
      'startBotPriceValue',
      'stopBotPriceCondition',
      'stopBotPriceValue',
      'indicators',
      'indicatorGroups',
    ],
  },
  {
    id: 'experimental',
    name: 'Experimental',
    description:
      'Experimental features: rescue partially filled orders and adaptive close.',
    fields: ['remainderFullAmount', 'autoRebalancing', 'adaptiveClose'],
  },
]

const COMBO_SECTIONS: SectionLayout[] = [
  {
    id: 'basic',
    name: 'Basic',
    description:
      'Bot identity, exchange connection, trading pairs, and multi-pair mode.',
    fields: ['name', 'exchangeUUID', 'exchange', 'pair', 'useMulti'],
  },
  {
    id: 'strategy',
    name: 'Strategy',
    description:
      'Trading direction and futures options. Order sizing is handled by the Base Minigrid section.',
    fields: [
      'strategy',
      'futures',
      'coinm',
      'marginType',
      'leverage',
      'profitCurrency',
      'orderFixedIn',
      'skipBalanceCheck',
      'feeOrder',
      'newBalance',
      'comboTpBase',
      'useReinvest',
      'reinvestValue',
      'useRiskReduction',
      'riskReductionValue',
    ],
  },
  {
    id: 'base_minigrid',
    name: 'Base Minigrid',
    description:
      'Base order and base-minigrid configuration (replaces the DCA strategy order-size section for Combo bots).',
    fields: [
      'baseOrderSize',
      'orderSize',
      'orderSizeType',
      'startOrderType',
      'gridLevel',
      'baseStep',
      'baseGridLevels',
      'useActiveMinigrids',
      'comboActiveMinigrids',
      'comboUseSmartGrids',
      'comboSmartGridsCount',
    ],
  },
  {
    id: 'deal_start',
    name: 'Deal Start',
    description:
      'Conditions that trigger opening a new deal: start condition, deal limits, price filters and cooldowns.',
    fields: [
      'startCondition',
      'maxNumberOfOpenDeals',
      'maxDealsPerPair',
      'useSeparateMaxDealsOverAndUnder',
      'maxDealsOver',
      'maxDealsUnder',
      'useSeparateMaxDealsOverAndUnderPerSymbol',
      'maxDealsOverPerSymbol',
      'maxDealsUnderPerSymbol',
      'minOpenDeal',
      'maxOpenDeal',
      'useMaxDealsPerHigherTimeframe',
      'maxDealsPerHigherTimeframe',
      'ignoreStartDeals',
      'useNoOverlapDeals',
      'minimumDeviation',
      'useVolumeFilter',
      'volumeTop',
      'volumeValue',
      'useVolumeFilterAll',
      'useRelativeVolumeFilter',
      'relativeVolumeTop',
      'relativeVolumeValue',
      'useStaticPriceFilter',
      'useDynamicPriceFilter',
      'dynamicPriceFilterDeviation',
      'dynamicPriceFilterPriceType',
      'dynamicPriceFilterDirection',
      'dynamicPriceFilterOverValue',
      'dynamicPriceFilterUnderValue',
      'pairPrioritization',
      'useCooldown',
      'cooldownAfterDealStart',
      'cooldownAfterDealStartInterval',
      'cooldownAfterDealStartUnits',
      'cooldownAfterDealStartOption',
      'cooldownAfterDealStop',
      'cooldownAfterDealStopInterval',
      'cooldownAfterDealStopUnits',
      'cooldownAfterDealStopOption',
    ],
  },
  {
    id: 'take_profit',
    name: 'Take Profit',
    description:
      'Combo take-profit: simple TP percent, base-SL reference, and close order type. Advanced multi-TP, trailing, and move-SL are not available for Combo bots.',
    fields: [
      'useTp',
      'tpPerc',
      'comboTpLimit',
      'dealCloseCondition',
      'closeOrderType',
    ],
  },
  {
    id: 'stop_loss',
    name: 'Stop Loss',
    description:
      'Combo stop-loss: simple SL percent and base reference. Advanced options are not available for Combo bots.',
    fields: [
      'useSl',
      'slPerc',
      'baseSlOn',
      'comboSlLimit',
      'dealCloseConditionSL',
    ],
  },
  {
    id: 'dca_minigrids',
    name: 'DCA Minigrids',
    description:
      'DCA minigrid configuration (equivalent of the DCA section in DCA bots, adapted for Combo).',
    fields: [
      'useDca',
      'dcaCondition',
      'scaleDcaType',
      'ordersCount',
      'activeOrdersCount',
      'step',
      'stepScale',
      'orderSize',
      'volumeScale',
      'useSmartOrders',
    ],
  },
  {
    id: 'controller',
    name: 'Controller',
    description:
      'Bot-level start/stop conditions and indicator-based deal control.',
    fields: [
      'useBotController',
      'botStart',
      'botActualStart',
      'stopType',
      'stopStatus',
      'startDealLogic',
      'stopDealLogic',
      'stopDealSlLogic',
      'stopBotLogic',
      'startBotLogic',
      'startBotPriceCondition',
      'startBotPriceValue',
      'stopBotPriceCondition',
      'stopBotPriceValue',
      'indicators',
      'indicatorGroups',
    ],
  },
  {
    id: 'experimental',
    name: 'Experimental',
    description: 'Experimental features available for Combo bots.',
    fields: ['adaptiveClose'],
  },
]

const GRID_SECTIONS: SectionLayout[] = [
  {
    id: 'basic',
    name: 'Basic',
    description: 'Bot identity, exchange connection, and trading pair.',
    fields: ['name', 'exchangeUUID', 'exchange', 'pair'],
  },
  {
    id: 'strategy',
    name: 'Strategy',
    description:
      'Trading direction, futures options, and optional custom start price.',
    fields: [
      'strategy',
      'futuresStrategy',
      'futures',
      'coinm',
      'marginType',
      'leverage',
      'profitCurrency',
      'orderFixedIn',
      'useStartPrice',
      'startPrice',
      'feeOrder',
    ],
  },
  {
    id: 'grid_settings',
    name: 'Grid Settings',
    description:
      'Grid price range, levels, step, grid type, and sell displacement.',
    fields: [
      'topPrice',
      'lowPrice',
      'levels',
      'gridStep',
      'prioritize',
      'gridType',
      'sellDisplacement',
    ],
  },
  {
    id: 'budget',
    name: 'Budget',
    description: 'Grid budget, balance check, and advance order settings.',
    fields: [
      'budget',
      'skipBalanceCheck',
      'useOrderInAdvance',
      'ordersInAdvance',
    ],
  },
  {
    id: 'take_profit',
    name: 'Take Profit',
    description:
      'Grid take-profit: close condition (value change or price target), value, and action on trigger.',
    fields: [
      'tpSl',
      'tpSlCondition',
      'tpPerc',
      'tpTopPrice',
      'tpSlAction',
      'tpSlLimit',
    ],
  },
  {
    id: 'stop_loss',
    name: 'Stop Loss',
    description:
      'Grid stop-loss: close condition (value change or price target), value, and action on trigger.',
    fields: [
      'sl',
      'slCondition',
      'slPerc',
      'slLowPrice',
      'slAction',
      'slLimit',
    ],
  },
]

// ---------------------------------------------------------------------------
// Field notes: extra context not derivable from types or validators
// ---------------------------------------------------------------------------

const FIELD_NOTES: Record<string, { note?: string; example?: unknown }> = {
  pair: {
    note: 'For DCA/Combo: array of "BASE_QUOTE" strings. For Grid: single "BASE_QUOTE" string.',
    example: 'BTC_USDT',
  },
  slPerc: { note: 'Must be negative, e.g. "-10" means 10% stop loss.' },
  tpPerc: { note: 'Positive percent, e.g. "2" means 2% take profit.' },
  leverage: { note: 'Integer 1–125. Only relevant when futures=true.' },
  indicators: {
    note: 'Array of SettingsIndicators objects. See GET /api/v2/discovery/indicators for full schema.',
  },
  indicatorGroups: {
    note: 'Array of SettingsIndicatorGroup objects. Each indicator must reference a group via groupId.',
  },
  gridLevel: {
    note: 'For DCA: integer 1–10 (mini-grid levels). For Combo: integer 1–100.',
  },
  dcaCustom: {
    note: 'Only used when dcaCondition = "custom". Each item has step, size, uuid.',
  },
  multiTp: {
    note: 'Only used when useMultiTp = true. Each item has target, amount (0-100%), uuid, fixed (optional price).',
  },
  multiSl: {
    note: 'Only used when useMultiSl = true. Same shape as multiTp.',
  },
  maxNumberOfOpenDeals: {
    note: '-1 means unlimited.',
  },
  rrSlType: {
    note: 'Only relevant when useRiskReward = true. "indicator" uses indicator-based SL; "fixed" uses rrSlFixedValue.',
  },
}

// ---------------------------------------------------------------------------
// Indicator definitions
// ---------------------------------------------------------------------------

// Import IndicatorEnum values at runtime from types
// We resolve them from the compiled validator config where they already appear
// as enum values.
function getIndicatorEnumValues(): string[] {
  // Read from the indicatorCoreConfig's 'type' field which has enum: Object.values(IndicatorEnum)
  return (indicatorCoreConfig['type']?.enum as string[]) ?? []
}

const INDICATOR_META: Record<
  string,
  {
    name: string
    description?: string
    typeSpecificFields: string[]
    supportedActions: string[]
    supportedSections?: string[]
    example?: Record<string, unknown>
  }
> = {
  RSI: {
    name: 'Relative Strength Index (RSI)',
    description:
      'Measures recent price changes to evaluate overbought or oversold conditions in the price of an asset.',
    typeSpecificFields: [
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'RSI',
      indicatorLength: 14,
      indicatorValue: '30',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  ADX: {
    name: 'Average Directional Index (ADX)',
    description:
      'Measures the strength of a trend without regard to direction, with higher values indicating a stronger trend.',
    typeSpecificFields: [
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'ADX',
      indicatorLength: 14,
      indicatorValue: '25',
      indicatorCondition: 'gt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  BB: {
    name: 'Bollinger Bands (BB)',
    description:
      'Displays volatility by plotting standard deviations above and below a moving average. Band widening suggests increased volatility.',
    typeSpecificFields: ['bbCrossingValue', 'bbwMult', 'bbwMa', 'bbwMaLength'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'BB',
      indicatorLength: 20,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      bbCrossingValue: 'lower',
      indicatorAction: 'startDeal',
    },
  },
  BBW: {
    name: 'Bollinger Band Width (BBW)',
    description:
      'Quantifies the gap between the Bollinger Bands. Wider bands indicate higher volatility, and narrower bands indicate lower volatility.',
    typeSpecificFields: [
      'bbwMult',
      'bbwMa',
      'bbwMaLength',
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'BBW',
      indicatorLength: 20,
      indicatorValue: '0.1',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  MACD: {
    name: 'Moving Average Convergence Divergence (MACD)',
    description:
      'Shows the relationship between two moving averages of a price. MACD crossing above signal line indicates potential buy.',
    typeSpecificFields: [
      'macdFast',
      'macdSlow',
      'macdMaSource',
      'macdMaSignal',
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'MACD',
      indicatorLength: 9,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      macdFast: 12,
      macdSlow: 26,
      indicatorAction: 'startDeal',
    },
  },
  Stoch: {
    name: 'Stochastic Oscillator (Stoch)',
    description:
      'Compares a closing price to its price range over a certain period, indicating momentum and potential trend reversals.',
    typeSpecificFields: [
      'stochSmoothK',
      'stochSmoothD',
      'stochUpper',
      'stochLower',
      'stochRSI',
      'stochRange',
      'rsiValue',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'Stoch',
      indicatorLength: 14,
      indicatorValue: '20',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  CCI: {
    name: 'Commodity Channel Index (CCI)',
    description:
      "Assesses the variation of a security's price from its statistical mean. High values show strength; low values indicate weakness.",
    typeSpecificFields: [
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'CCI',
      indicatorLength: 20,
      indicatorValue: '-100',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  AO: {
    name: 'Awesome Oscillator',
    description:
      "Calculates the difference of a 34 Period and 5 Period Simple Moving Averages. AO's zero-line crossovers can signal momentum.",
    typeSpecificFields: [
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'AO',
      indicatorLength: 34,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  StochRSI: {
    name: 'Stochastic RSI (StochRSI)',
    description:
      'An oscillator that measures the level of RSI relative to its high-low range over a set time period, indicating momentum.',
    typeSpecificFields: [
      'stochSmoothK',
      'stochSmoothD',
      'rsiValue',
      'rsiValue2',
      'stochRSI',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'StochRSI',
      indicatorLength: 14,
      indicatorValue: '20',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  WR: {
    name: 'Williams Percent Range (Williams %R)',
    description:
      "A momentum indicator that compares an asset's closing price to the high-low range over a specific period, often identifying reversals.",
    typeSpecificFields: [
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'WR',
      indicatorLength: 14,
      indicatorValue: '-80',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  BullBear: {
    name: 'Bull Bear Power',
    description:
      'EMA-based oscillator measuring the difference between bulls and bears power.',
    typeSpecificFields: [
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'BullBear',
      indicatorLength: 13,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  UO: {
    name: 'Ultimate Oscillator',
    description:
      "Combines short, intermediate, and long-term market trends' momentum into one value to detect diverse buying pressures.",
    typeSpecificFields: [
      'uoFast',
      'uoMiddle',
      'uoSlow',
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'UO',
      indicatorLength: 14,
      indicatorValue: '30',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      uoFast: 7,
      uoMiddle: 14,
      uoSlow: 28,
      indicatorAction: 'startDeal',
    },
  },
  IC: {
    name: 'Ichimoku Cloud',
    description:
      'Multi-component indicator defining support, resistance, momentum and trend direction.',
    typeSpecificFields: [
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'IC',
      indicatorLength: 9,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  TV: {
    name: 'Combined Ratings',
    description:
      'An aggregate metric that combines various individual indicators to provide a comprehensive market overview.',
    typeSpecificFields: ['signal', 'condition', 'checkLevel'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'TV',
      indicatorLength: 1,
      indicatorValue: '0',
      indicatorCondition: 'gt',
      indicatorInterval: '1h',
      signal: 'BUY',
      indicatorAction: 'startDeal',
    },
  },
  MA: {
    name: 'Moving Averages',
    description:
      'Indicates the average price of a security over a set period, smoothing out price data to identify trends.',
    typeSpecificFields: [
      'maType',
      'maCrossingValue',
      'maCrossingLength',
      'maCrossingInterval',
      'maUUID',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'MA',
      indicatorLength: 20,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      maType: 'EMA',
      indicatorAction: 'startDeal',
    },
  },
  SR: {
    name: 'Support Resistance',
    description:
      'Identifies price levels where a security tends to stop moving upward (resistance) or downward (support).',
    typeSpecificFields: ['leftBars', 'rightBars', 'srCrossingValue'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'SR',
      indicatorLength: 10,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      srCrossingValue: 'support',
      indicatorAction: 'startDeal',
    },
  },
  QFL: {
    name: 'QFL Base Scanner',
    description:
      "A tool that scans for 'bases' or support levels in price action, often used for identifying entry points.",
    typeSpecificFields: ['basePeriods', 'pumpPeriods', 'pump', 'baseCrack'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'QFL',
      indicatorLength: 20,
      indicatorValue: '3',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  MFI: {
    name: 'Money Flow Index (MFI)',
    description:
      'Analyzes both price and volume to measure trading pressure - buying or selling. Similar to RSI but includes volume.',
    typeSpecificFields: [
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'MFI',
      indicatorLength: 14,
      indicatorValue: '20',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  PSAR: {
    name: 'Parabolic SAR',
    description:
      'Provides potential reversals in price direction, appearing as dots below or above the price bars.',
    typeSpecificFields: ['psarStart', 'psarInc', 'psarMax'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'PSAR',
      indicatorLength: 1,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      psarStart: 0.02,
      psarInc: 0.02,
      psarMax: 0.2,
      indicatorAction: 'startDeal',
    },
  },
  VO: {
    name: 'Volume Oscillator',
    description:
      'Shows the difference between two volume moving averages, highlighting trends in volume relative to price.',
    typeSpecificFields: [
      'voShort',
      'voLong',
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'VO',
      indicatorLength: 1,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      voShort: 5,
      voLong: 10,
      indicatorAction: 'startDeal',
    },
  },
  MOM: {
    name: 'Momentum',
    description:
      'Measures the rate of rise or fall in asset prices, indicating the strength of price trends at a given moment.',
    typeSpecificFields: [
      'momSource',
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'MOM',
      indicatorLength: 10,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  BBWP: {
    name: 'BBW Percentile',
    description:
      'Positions the current BBW in the context of its range over a specific period, showing volatility extremes.',
    typeSpecificFields: ['bbwpLookback', 'momSource'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'BBWP',
      indicatorLength: 20,
      indicatorValue: '20',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      bbwpLookback: 252,
      indicatorAction: 'startDeal',
    },
  },
  ECD: {
    name: 'Engulfing Candle',
    description:
      "A candlestick pattern that occurs when a small candle is followed by a large one that completely 'engulfs' it, suggesting a reversal.",
    typeSpecificFields: ['ecdTrigger'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'ECD',
      indicatorLength: 1,
      indicatorValue: '0',
      indicatorCondition: 'gt',
      indicatorInterval: '1h',
      ecdTrigger: 'bullish',
      indicatorAction: 'startDeal',
    },
  },
  XO: {
    name: 'Oscillator Crossover',
    description:
      'Refers to the point where two different oscillator indicators cross each other, indicating potential buy or sell signals.',
    typeSpecificFields: [
      'xOscillator1',
      'xOscillator2',
      'xOscillator2length',
      'xOscillator2Interval',
      'xOscillator2voLong',
      'xOscillator2voShort',
      'xoUUID',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'XO',
      indicatorLength: 14,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      xOscillator1: 'RSI',
      xOscillator2: 'CCI',
      indicatorAction: 'startDeal',
    },
  },
  MAR: {
    name: 'Moving Average Ratio (MAR)',
    description:
      "Compares two moving averages or a moving average and the current price to indicate the trend's direction and strength.",
    typeSpecificFields: [
      'mar1length',
      'mar1type',
      'mar2length',
      'mar2type',
      'percentile',
      'percentileLookback',
      'percentilePercentage',
      'trendFilter',
      'trendFilterLookback',
      'trendFilterType',
      'trendFilterValue',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'MAR',
      indicatorLength: 1,
      indicatorValue: '1',
      indicatorCondition: 'gt',
      indicatorInterval: '1h',
      mar1length: 20,
      mar1type: 'EMA',
      mar2length: 50,
      mar2type: 'SMA',
      indicatorAction: 'startDeal',
    },
  },
  BBPB: {
    name: 'Bollinger Bands %B (BB %B)',
    description:
      'Measures where the last price is in relation to the BB bands, indicating overbought or oversold conditions.',
    typeSpecificFields: [
      'bbwMult',
      'bbwMa',
      'bbwMaLength',
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'BBPB',
      indicatorLength: 20,
      indicatorValue: '0.1',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  DIV: {
    name: 'Divergences',
    description:
      'Occurs when the price trend and a momentum indicator like RSI or MACD move in opposite directions, potentially signaling a price direction change.',
    typeSpecificFields: ['divType', 'divOscillators', 'divMinCount'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'DIV',
      indicatorLength: 5,
      indicatorValue: '2',
      indicatorCondition: 'gt',
      indicatorInterval: '1h',
      divType: 'Bullish',
      divOscillators: ['RSI'],
      indicatorAction: 'startDeal',
    },
  },
  ST: {
    name: 'SuperTrend',
    description: 'The Supertrend is a trend following indicator.',
    typeSpecificFields: ['stCondition', 'factor', 'atrLength'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'ST',
      indicatorLength: 10,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      factor: 3,
      stCondition: 'up',
      indicatorAction: 'startDeal',
    },
  },
  PC: {
    name: 'Price Change',
    description:
      'Measures the price change within a candle, indicating buying or selling pressure.',
    typeSpecificFields: ['pcUp', 'pcDown', 'pcCondition', 'pcValue'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'PC',
      indicatorLength: 14,
      indicatorValue: '5',
      indicatorCondition: 'gt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  ATR: {
    name: 'Average True Range (ATR)',
    description:
      "Calculates the market's volatility by measuring the range of price movements, using the average of true ranges over a period.",
    typeSpecificFields: [],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'ATR',
      indicatorLength: 14,
      indicatorValue: '100',
      indicatorCondition: 'gt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  MG: {
    name: 'McGinley Dynamic (MG)',
    description:
      'A self-adjusting moving average that speeds up in fast markets and slows down in flat ones, tracking price more closely than a fixed-period moving average.',
    typeSpecificFields: [],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'MG',
      indicatorLength: 14,
      indicatorValue: '0',
      indicatorCondition: 'gt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  PP: {
    name: 'Market Structure',
    description:
      'Marks previous highs and lows, break of structure, and change of character. Often used in Smart Money Concepts.',
    typeSpecificFields: [
      'ppHighLeft',
      'ppHighRight',
      'ppLowLeft',
      'ppLowRight',
      'ppMult',
      'ppValue',
      'ppType',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'PP',
      indicatorLength: 10,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      ppValue: 'HH',
      indicatorAction: 'startDeal',
    },
  },
  ADR: {
    name: 'Average Daily Range (ADR)',
    description:
      'Measures the average range between the high and low prices over a given number of past days, indicating daily price volatility.',
    typeSpecificFields: [],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'ADR',
      indicatorLength: 14,
      indicatorValue: '2',
      indicatorCondition: 'gt',
      indicatorInterval: '1d',
      indicatorAction: 'startDeal',
    },
  },
  ATH: {
    name: 'ATH Drawdown',
    description:
      "Calculates the percentage decline from an asset's highest price in a lookback period to its current price, measuring the extent of a potential downturn.",
    typeSpecificFields: ['athLookback'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'ATH',
      indicatorLength: 365,
      indicatorValue: '-30',
      indicatorCondition: 'lt',
      indicatorInterval: '1d',
      indicatorAction: 'startDeal',
    },
  },
  KC: {
    name: 'Keltner Channel (KC)',
    description:
      'Displays volatility by plotting bands based on Average True Range (ATR) around a moving average.',
    typeSpecificFields: ['kcMa', 'kcRange', 'kcRangeLength', 'bbwMult'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'KC',
      indicatorLength: 20,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      kcMa: 'EMA',
      indicatorAction: 'startDeal',
    },
  },
  KCPB: {
    name: 'Keltner Channel %B (KC%B)',
    description:
      'Measures the location of the current price in relation to the Keltner Channels, showing overbought or oversold conditions.',
    typeSpecificFields: [
      'kcMa',
      'kcRange',
      'kcRangeLength',
      'bbwMult',
      'percentile',
      'percentileLookback',
      'percentilePercentage',
    ],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'KCPB',
      indicatorLength: 20,
      indicatorValue: '0.1',
      indicatorCondition: 'lt',
      indicatorInterval: '1h',
      indicatorAction: 'startDeal',
    },
  },
  UNPNL: {
    name: 'Average position price (AVP)',
    description: 'Track the average price of the deal.',
    typeSpecificFields: ['unpnlValue', 'unpnlCondition'],
    supportedActions: ['closeDeal', 'stopBot'],
    supportedSections: ['tp', 'sl'],
    example: {
      type: 'UNPNL',
      indicatorLength: 1,
      indicatorValue: '5',
      indicatorCondition: 'gt',
      indicatorInterval: '1h',
      indicatorAction: 'closeDeal',
      section: 'tp',
    },
  },
  DC: {
    name: 'Donchian Channels (DC)',
    description:
      'Identifies price breakouts, trend movements, and support/resistance levels.',
    typeSpecificFields: ['dcValue'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'DC',
      indicatorLength: 20,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      dcValue: 'upper',
      indicatorAction: 'startDeal',
    },
  },
  OBFVG: {
    name: 'Fair Value Gaps (FVG)',
    description:
      "A fair value gap (FVG) is an imbalance on a financial chart where aggressive buying or selling leaves a price range with little to no trading activity, creating a 'void' in the price chart.",
    typeSpecificFields: ['obfvgValue', 'obfvgRef'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'OBFVG',
      indicatorLength: 1,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      obfvgValue: 'bullish',
      indicatorAction: 'startDeal',
    },
  },
  SESSION: {
    name: 'Session Selector',
    description:
      'Filters signals based on the day of the week (UTC). Select which days are active and whether to trade in or out of the selected sessions.',
    typeSpecificFields: ['sessionDays', 'sessionRule'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'SESSION',
      indicatorLength: 1,
      indicatorValue: '0',
      indicatorCondition: 'cd',
      indicatorInterval: '1h',
      sessionDays: [1, 2, 3, 4, 5],
      sessionRule: 'in',
      indicatorAction: 'startDeal',
    },
  },
  LW: {
    name: 'Long Wick Detector',
    description:
      'Detects candles with unusually long wicks based on ATR(200). Tracks wick levels until price mitigates them or they expire.',
    typeSpecificFields: ['lwThreshold', 'lwMaxDuration', 'lwValue'],
    supportedActions: [
      'startDeal',
      'closeDeal',
      'startDca',
      'stopBot',
      'startBot',
    ],
    example: {
      type: 'LW',
      indicatorLength: 1,
      indicatorValue: '0',
      indicatorCondition: 'cu',
      indicatorInterval: '1h',
      lwThreshold: 2,
      lwMaxDuration: 1000,
      lwValue: 'any',
      indicatorAction: 'startDeal',
    },
  },
}

// Core indicator fields (required for every indicator)
const INDICATOR_CORE_FIELD_NAMES = [
  'type',
  'indicatorLength',
  'indicatorValue',
  'indicatorCondition',
  'indicatorInterval',
  'groupId',
  'uuid',
  'indicatorAction',
]

// Overlay fields always included in typeSpecificFields for every indicator
const INDICATOR_OVERLAY_FIELDS = [
  'section',
  'minPercFromLast',
  'keepConditionBars',
]

// ---------------------------------------------------------------------------
// Code emitter: wraps OutField[] as a TS const expression
// ---------------------------------------------------------------------------

function serializeField(f: OutField, indent: string): string {
  const lines: string[] = [`${indent}{`]
  const i2 = indent + '  '
  lines.push(`${i2}name: ${JSON.stringify(f.name)},`)
  lines.push(`${i2}type: ${JSON.stringify(f.type)},`)
  lines.push(`${i2}required: ${f.required},`)
  if (f.validators.length)
    lines.push(`${i2}validators: ${JSON.stringify(f.validators)},`)
  else lines.push(`${i2}validators: [],`)
  if (f.enum) lines.push(`${i2}enum: ${JSON.stringify(f.enum)},`)
  if (f.itemType) lines.push(`${i2}itemType: ${JSON.stringify(f.itemType)},`)
  if (f.min !== undefined) lines.push(`${i2}min: ${f.min},`)
  if (f.max !== undefined) lines.push(`${i2}max: ${f.max},`)
  if (f.maxPrecision !== undefined)
    lines.push(`${i2}maxPrecision: ${f.maxPrecision},`)
  if (f.maxLength !== undefined) lines.push(`${i2}maxLength: ${f.maxLength},`)
  if (f.default !== undefined)
    lines.push(`${i2}default: ${JSON.stringify(f.default)},`)
  if (f.note) lines.push(`${i2}note: ${JSON.stringify(f.note)},`)
  if (f.example !== undefined)
    lines.push(`${i2}example: ${JSON.stringify(f.example)},`)
  lines.push(`${indent}}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  console.log('Parsing TypeScript types from', TYPES_FILE)
  const parser = new TypesParser(TYPES_FILE)

  // -----------------------------------------------------------
  // Build DCA field map
  // -----------------------------------------------------------
  const dcaAstProps = new Map<string, AstProperty>()
  ;[
    ...parser.getProperties('BaseSettings'),
    ...parser.getProperties('DCABotSettings'),
  ].forEach((p) => dcaAstProps.set(p.name, p))

  // Build field definitions for every field that appears in dcaBotSchemaConfig
  const buildBotFields = (
    schemaConfig: Record<string, RawFieldConfig>,
    formDefaults: Record<string, unknown>,
    astProps: Map<string, AstProperty>,
    fieldNames: string[],
  ): OutField[] => {
    return fieldNames
      .filter((name) => schemaConfig[name] || astProps.has(name))
      .map((name) =>
        buildField(
          name,
          astProps.get(name),
          schemaConfig[name],
          formDefaults[name],
          FIELD_NOTES,
        ),
      )
  }

  // -----------------------------------------------------------
  // Build DCA sections
  // -----------------------------------------------------------
  const buildSections = (
    layouts: SectionLayout[],
    schemaConfig: Record<string, RawFieldConfig>,
    formDefaults: Record<string, unknown>,
    astProps: Map<string, AstProperty>,
  ) =>
    layouts.map((sec) => ({
      id: sec.id,
      name: sec.name,
      description: sec.description,
      fields: buildBotFields(schemaConfig, formDefaults, astProps, sec.fields),
    }))

  // DCA
  const dcaSections = buildSections(
    DCA_SECTIONS,
    dcaBotSchemaConfig as Record<string, RawFieldConfig>,
    DCA_FORM_DEFAULTS as unknown as Record<string, unknown>,
    dcaAstProps,
  )

  // Combo — inherits DCA AST props + combo-specific override
  const comboAstProps = new Map(dcaAstProps)
  ;[...parser.getProperties('ComboBotSettings')].forEach((p) =>
    comboAstProps.set(p.name, p),
  )
  const comboSections = buildSections(
    COMBO_SECTIONS,
    comboBotSchemaConfig as Record<string, RawFieldConfig>,
    COMBO_FORM_DEFAULTS as unknown as Record<string, unknown>,
    comboAstProps,
  )

  // Grid
  const gridAstProps = new Map<string, AstProperty>()
  ;[
    ...parser.getProperties('BaseSettings'),
    ...parser.getProperties('BotSettings'),
  ].forEach((p) => gridAstProps.set(p.name, p))
  const gridSections = buildSections(
    GRID_SECTIONS,
    gridBotSchemaConfig as Record<string, RawFieldConfig>,
    GRID_FORM_DEFAULTS as unknown as Record<string, unknown>,
    gridAstProps,
  )

  // -----------------------------------------------------------
  // Build indicator definitions
  // -----------------------------------------------------------
  const indicatorTypes = getIndicatorEnumValues()
  const indAstProps = new Map<string, AstProperty>()
  parser
    .getProperties('SettingsIndicators')
    .forEach((p) => indAstProps.set(p.name, p))

  const coreFields: OutField[] = INDICATOR_CORE_FIELD_NAMES.map((name) =>
    buildField(
      name,
      indAstProps.get(name),
      { ...indicatorCoreConfig[name], required: true },
      undefined,
      FIELD_NOTES,
    ),
  )

  const overlayFields: OutField[] = INDICATOR_OVERLAY_FIELDS.map((name) =>
    buildField(
      name,
      indAstProps.get(name),
      { ...indicatorCoreConfig[name], required: false },
      undefined,
      FIELD_NOTES,
    ),
  )

  const indicatorDefs = indicatorTypes.map((type) => {
    const meta = INDICATOR_META[type]
    if (!meta) {
      console.warn(
        `  WARNING: no INDICATOR_META entry for "${type}" — using defaults`,
      )
    }
    const typeSpecificFieldNames = meta?.typeSpecificFields ?? []
    const typeSpecificFields: OutField[] = [
      ...typeSpecificFieldNames.map((name) =>
        buildField(
          name,
          indAstProps.get(name),
          { ...indicatorCoreConfig[name], required: false },
          undefined,
          FIELD_NOTES,
        ),
      ),
      ...overlayFields,
    ]
    return {
      type,
      name: meta?.name ?? type,
      description: meta?.description,
      coreFields,
      typeSpecificFields,
      supportedActions: meta?.supportedActions ?? [
        'startDeal',
        'closeDeal',
        'startDca',
        'stopBot',
        'startBot',
      ],
      supportedSections: meta?.supportedSections,
      example: {
        ...(meta?.example ?? {}),
        groupId: '<group-uuid>',
        uuid: '<indicator-uuid>',
      },
    }
  })

  // -----------------------------------------------------------
  // Nested object schemas (multiTP, dcaCustom, indicatorGroup)
  // -----------------------------------------------------------
  const multiTPAstProps = new Map<string, AstProperty>()
  parser.getProperties('MultiTP').forEach((p) => multiTPAstProps.set(p.name, p))
  const multiTPFields: OutField[] = Object.keys(multiTPConfig).map((name) =>
    buildField(
      name,
      multiTPAstProps.get(name),
      (multiTPConfig as Record<string, RawFieldConfig>)[name],
      undefined,
      FIELD_NOTES,
    ),
  )

  const dcaCustomAstProps = new Map<string, AstProperty>()
  parser
    .getProperties('DCACustom')
    .forEach((p) => dcaCustomAstProps.set(p.name, p))
  const dcaCustomFields: OutField[] = Object.keys(dcaCustomConfig).map((name) =>
    buildField(
      name,
      dcaCustomAstProps.get(name),
      (dcaCustomConfig as Record<string, RawFieldConfig>)[name],
      undefined,
      FIELD_NOTES,
    ),
  )

  const indGroupAstProps = new Map<string, AstProperty>()
  parser
    .getProperties('SettingsIndicatorGroup')
    .forEach((p) => indGroupAstProps.set(p.name, p))
  const indicatorGroupFields: OutField[] = Object.keys(
    indicatorGroupConfig,
  ).map((name) =>
    buildField(
      name,
      indGroupAstProps.get(name),
      (indicatorGroupConfig as Record<string, RawFieldConfig>)[name],
      undefined,
      FIELD_NOTES,
    ),
  )

  // -----------------------------------------------------------
  // Emit generated.ts
  // -----------------------------------------------------------
  const serializeFields = (fields: OutField[], indent: string) =>
    fields.map((f) => serializeField(f, indent + '  ')).join(',\n')

  const serializeSections = (
    sections: {
      id: string
      name: string
      description: string
      fields: OutField[]
    }[],
  ) =>
    sections
      .map(
        (s) =>
          `  {\n    id: ${JSON.stringify(s.id)},\n    name: ${JSON.stringify(s.name)},\n    description: ${JSON.stringify(s.description)},\n    fields: [\n${serializeFields(s.fields, '  ')}\n    ],\n  }`,
      )
      .join(',\n')

  const out: string[] = [
    `/**`,
    ` * AUTO-GENERATED — do not edit by hand.`,
    ` * Regenerate with: npm run generate:definitions`,
    ` *`,
    ` * Source of truth:`,
    ` *   - Types:      src/types.ts (TypeScript compiler API)`,
    ` *   - Validators: src/server/v2/validators/bots/config.ts`,
    ` *   - Sections:   src/utils/generate-definitions.ts (INDICATOR_META / *_SECTIONS)`,
    ` */`,
    `import type { BotSchemaDefinition, FieldDefinition, IndicatorDefinition } from './types'`,
    ``,
    `// -----------------------------------------------------------------------`,
    `// Nested object schemas`,
    `// -----------------------------------------------------------------------`,
    ``,
    `export const multiTPFieldDefinitions: FieldDefinition[] = [`,
    serializeFields(multiTPFields, ''),
    `]`,
    ``,
    `export const dcaCustomFieldDefinitions: FieldDefinition[] = [`,
    serializeFields(dcaCustomFields, ''),
    `]`,
    ``,
    `export const indicatorGroupFieldDefinitions: FieldDefinition[] = [`,
    serializeFields(indicatorGroupFields, ''),
    `]`,
    ``,
    `// -----------------------------------------------------------------------`,
    `// Indicator definitions`,
    `// -----------------------------------------------------------------------`,
    ``,
    `export const indicatorCoreFieldDefinitions: FieldDefinition[] = [`,
    serializeFields(coreFields, ''),
    `]`,
    ``,
    `export const indicatorDefinitions: IndicatorDefinition[] = [`,
    indicatorDefs
      .map((d) => {
        const lines = [
          `  {`,
          `    type: ${JSON.stringify(d.type)},`,
          `    name: ${JSON.stringify(d.name)},`,
        ]
        if (d.description)
          lines.push(`    description: ${JSON.stringify(d.description)},`)
        lines.push(`    coreFields: indicatorCoreFieldDefinitions,`)
        lines.push(
          `    typeSpecificFields: [\n${serializeFields(d.typeSpecificFields, '  ')}\n    ],`,
        )
        lines.push(
          `    supportedActions: ${JSON.stringify(d.supportedActions)},`,
        )
        if (d.supportedSections)
          lines.push(
            `    supportedSections: ${JSON.stringify(d.supportedSections)},`,
          )
        lines.push(`    example: ${JSON.stringify(d.example)},`)
        lines.push(`  }`)
        return lines.join('\n')
      })
      .join(',\n'),
    `]`,
    ``,
    `// -----------------------------------------------------------------------`,
    `// Bot schemas`,
    `// -----------------------------------------------------------------------`,
    ``,
    `export const dcaBotSchemaDefinition: BotSchemaDefinition = {`,
    `  botType: 'dca',`,
    `  label: 'DCA Bot',`,
    `  description: 'Dollar-Cost Averaging bot that opens deals based on conditions and averages down via DCA orders.',`,
    `  sections: [`,
    serializeSections(dcaSections),
    `  ],`,
    `}`,
    ``,
    `export const comboBotSchemaDefinition: BotSchemaDefinition = {`,
    `  botType: 'combo',`,
    `  label: 'Combo Bot',`,
    `  description: 'Combination DCA + grid bot. Uses minigrids for base orders and DCA minigrids for averaging.',`,
    `  sections: [`,
    serializeSections(comboSections),
    `  ],`,
    `}`,
    ``,
    `export const gridBotSchemaDefinition: BotSchemaDefinition = {`,
    `  botType: 'grid',`,
    `  label: 'Grid Bot',`,
    `  description: 'Grid trading bot that places buy/sell orders at evenly-spaced price levels.',`,
    `  sections: [`,
    serializeSections(gridSections),
    `  ],`,
    `}`,
    ``,
    `export const botSchemaDefinitions: BotSchemaDefinition[] = [`,
    `  dcaBotSchemaDefinition,`,
    `  comboBotSchemaDefinition,`,
    `  gridBotSchemaDefinition,`,
    `]`,
    ``,
  ]

  fs.mkdirSync(DEFINITIONS_DIR, { recursive: true })
  fs.writeFileSync(OUT_FILE, out.join('\n'), 'utf8')
  console.log(`\nWrote ${OUT_FILE}`)
  console.log(`  DCA sections:   ${dcaSections.length}`)
  console.log(`  Combo sections: ${comboSections.length}`)
  console.log(`  Grid sections:  ${gridSections.length}`)
  console.log(`  Indicators:     ${indicatorDefs.length}`)

  // Auto-fix lint issues in the generated file
  const coreRoot = path.resolve(__dirname, '../..')
  execSync(`npx eslint --fix "${OUT_FILE}"`, {
    cwd: coreRoot,
    stdio: 'inherit',
  })
  console.log('  eslint --fix done')
}

run()
